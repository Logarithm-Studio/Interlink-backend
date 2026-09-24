import { query, withTransaction } from "../../../config/db";
import { enqueueJob } from "../../jobQueue.service";
import { JobType } from "../../../jobs/schemas/envelope";
import { AppError, NotFoundError } from "../../../utils/errors";
import { logger } from "../../../observability/logger";
import {
  getMarketingContentItem, mapContent, type MarketingContentItem,
} from "./content.service";
import {
  assertMarketingContentPublishable, getMarketingPublishTargets, publishReservedMarketingContent,
  type MarketingPublishProvider,
} from "./social-publishing.service";
import { canUnscheduleSocialPublish, isSocialPublishDue, isSocialPublishWithinQueueWindow, socialPublishScheduleJobId } from "./social-scheduling.model";

const CONTENT_COLUMNS = "id,campaign_id,title,channel,body,asset_url,status,scheduled_at,published_at,provider,provider_item_id,provider_target_id,provider_target_name,created_at,updated_at";
const MINIMUM_SCHEDULE_LEAD_MS = 15 * 60_000;

interface MarketingSocialSchedule {
  id: string;
  userId: string;
  contentItemId: string;
  generation: number;
  provider: MarketingPublishProvider;
  targetId: string;
  targetName: string;
  scheduledAt: Date;
  status: string;
}

function mapSchedule(row: Record<string, unknown>): MarketingSocialSchedule {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    contentItemId: row.content_item_id as string,
    generation: Number(row.generation),
    provider: row.provider as MarketingPublishProvider,
    targetId: row.target_id as string,
    targetName: row.target_name as string,
    scheduledAt: row.scheduled_at as Date,
    status: row.status as string,
  };
}

export async function scheduleMarketingSocialPublish(
  userId: string,
  contentId: string,
  provider: MarketingPublishProvider,
  targetId: string,
  scheduledAt: Date,
): Promise<MarketingContentItem> {
  if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() + MINIMUM_SCHEDULE_LEAD_MS) {
    throw new AppError("Choose a publish time at least 15 minutes from now.", 400);
  }

  const initial = await getMarketingContentItem(userId, contentId);
  assertMarketingContentPublishable(initial, provider);
  const targets = await getMarketingPublishTargets(userId, provider);
  const target = targets.find((candidate) => candidate.id === targetId);
  if (!target) throw new AppError("Choose a publishing destination available to the connected account.", 400);

  const item = await withTransaction(async (client) => {
    const currentResult = await client.query(
      `SELECT ${CONTENT_COLUMNS} FROM sales_marketing_content_items WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [contentId, userId],
    );
    if (!currentResult.rows[0]) throw new NotFoundError("Marketing content");
    const current = mapContent(currentResult.rows[0] as Record<string, unknown>);
    assertMarketingContentPublishable(current, provider);
    if (current.status !== "approved" && current.status !== "planned") {
      throw new AppError("Only approved content can be scheduled for automatic publishing.", 409);
    }

    const updated = await client.query(
      `UPDATE sales_marketing_content_items SET status='planned',scheduled_at=$3,provider=$4,
         provider_item_id=NULL,provider_target_id=$5,provider_target_name=$6,updated_at=now()
       WHERE id=$1 AND user_id=$2 AND status IN ('approved','planned') RETURNING ${CONTENT_COLUMNS}`,
      [contentId, userId, scheduledAt, provider, target.id, target.name.slice(0, 200)],
    );
    if (!updated.rows[0]) throw new AppError("This content changed before its publishing schedule was saved. Refresh and review it again.", 409);

    const savedSchedule = await client.query(
      `INSERT INTO sales_marketing_social_publish_schedules
         (user_id,content_item_id,generation,provider,target_id,target_name,scheduled_at,status)
       VALUES($1,$2,1,$3,$4,$5,$6,'pending')
       ON CONFLICT(content_item_id) DO UPDATE SET
         generation=sales_marketing_social_publish_schedules.generation+1,
         provider=EXCLUDED.provider,target_id=EXCLUDED.target_id,target_name=EXCLUDED.target_name,
         scheduled_at=EXCLUDED.scheduled_at,status='pending',dispatch_claimed_at=NULL,updated_at=now()
       WHERE sales_marketing_social_publish_schedules.user_id=EXCLUDED.user_id
       RETURNING id,generation`,
      [userId, contentId, provider, target.id, target.name.slice(0, 200), scheduledAt],
    );
    if (!savedSchedule.rows[0]) throw new AppError("This schedule belongs to a different account. Refresh and contact support if the problem continues.", 409);
    await client.query(
      `INSERT INTO sales_marketing_approval_events(user_id,entity_type,entity_id,action,note)
       VALUES($1,'content',$2,'scheduled',$3)`,
      [userId, contentId, `Approved content scheduled for automatic ${provider} publication to ${target.name.slice(0, 160)} at ${scheduledAt.toISOString()}.`],
    );
    return mapContent(updated.rows[0] as Record<string, unknown>);
  });

  // Persisted schedules are picked up by the hourly dispatcher if immediate enqueue fails.
  const savedSchedule = await getScheduleForContent(userId, contentId);
  if (savedSchedule) await dispatchMarketingSocialPublishSchedules(new Date(), savedSchedule.id);
  return item;
}

export async function unscheduleMarketingSocialPublish(userId: string, contentId: string): Promise<MarketingContentItem> {
  return withTransaction(async (client) => {
    const current = await client.query(
      `SELECT ${CONTENT_COLUMNS} FROM sales_marketing_content_items WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [contentId, userId],
    );
    if (!current.rows[0]) throw new NotFoundError("Marketing content");
    if (current.rows[0].status !== "planned") throw new AppError("Only a waiting automatic publish can be removed from the calendar.", 409);

    const selected = await client.query(
      `SELECT status FROM sales_marketing_social_publish_schedules
        WHERE user_id=$1 AND content_item_id=$2 FOR UPDATE`, [userId, contentId],
    );
    if (!selected.rows[0] || !canUnscheduleSocialPublish(String(selected.rows[0].status))) {
      throw new AppError("This post may already be publishing or needs provider review. Check its status before changing the schedule.", 409);
    }
    await client.query(
      `UPDATE sales_marketing_social_publish_schedules SET status='cancelled',dispatch_claimed_at=NULL,updated_at=now()
        WHERE user_id=$1 AND content_item_id=$2 AND status IN ('pending','dispatching','queued')`, [userId, contentId],
    );
    const updated = await client.query(
      `UPDATE sales_marketing_content_items SET status='approved',scheduled_at=NULL,provider=NULL,
         provider_target_id=NULL,provider_target_name=NULL,updated_at=now()
        WHERE id=$1 AND user_id=$2 AND status='planned' RETURNING ${CONTENT_COLUMNS}`,
      [contentId, userId],
    );
    if (!updated.rows[0]) throw new AppError("This content changed while its schedule was being removed. Refresh and check its state.", 409);
    await client.query(
      `INSERT INTO sales_marketing_approval_events(user_id,entity_type,entity_id,action,note)
       VALUES($1,'content',$2,'unscheduled','The marketer removed the waiting automatic publish schedule. The approved content remains available for editing, rescheduling, or manual publishing.')`,
      [userId, contentId],
    );
    return mapContent(updated.rows[0] as Record<string, unknown>);
  });
}

async function getScheduleForContent(userId: string, contentId: string): Promise<MarketingSocialSchedule | null> {
  const result = await query(
    `SELECT id,user_id,content_item_id,generation,provider,target_id,target_name,scheduled_at,status
       FROM sales_marketing_social_publish_schedules WHERE user_id=$1 AND content_item_id=$2`, [userId, contentId],
  );
  return result.rows[0] ? mapSchedule(result.rows[0] as Record<string, unknown>) : null;
}

async function claimScheduleForDispatch(scheduleId: string, now: Date): Promise<MarketingSocialSchedule | null> {
  return withTransaction(async (client) => {
    const selected = await client.query(
      `SELECT id,user_id,content_item_id,generation,provider,target_id,target_name,scheduled_at,status
         FROM sales_marketing_social_publish_schedules
        WHERE id=$1 AND status='pending' AND scheduled_at <= $2 + interval '6 days'
        FOR UPDATE SKIP LOCKED`, [scheduleId, now],
    );
    if (!selected.rows[0]) return null;
    const schedule = mapSchedule(selected.rows[0] as Record<string, unknown>);
    if (!isSocialPublishWithinQueueWindow(schedule.scheduledAt, now)) return null;
    const claimed = await client.query(
      `UPDATE sales_marketing_social_publish_schedules SET status='dispatching',dispatch_claimed_at=$3,updated_at=$3
        WHERE id=$1 AND user_id=$2 AND generation=$4 AND status='pending'
        RETURNING id,user_id,content_item_id,generation,provider,target_id,target_name,scheduled_at,status`,
      [schedule.id, schedule.userId, now, schedule.generation],
    );
    return claimed.rows[0] ? mapSchedule(claimed.rows[0] as Record<string, unknown>) : null;
  });
}

async function enqueueClaimedSchedule(schedule: MarketingSocialSchedule): Promise<boolean> {
  try {
    const idempotencyKey = socialPublishScheduleJobId(schedule.id, schedule.generation);
    await enqueueJob("marketing-social-publish", {
      jobType: JobType.MARKETING_SOCIAL_PUBLISH,
      idempotencyKey,
      userId: schedule.userId,
      payload: { scheduleId: schedule.id, generation: schedule.generation },
    }, { jobId: idempotencyKey, notBefore: schedule.scheduledAt, retries: 5 });
    await query(
      `UPDATE sales_marketing_social_publish_schedules SET status='queued',dispatch_claimed_at=NULL,updated_at=now()
        WHERE id=$1 AND user_id=$2 AND generation=$3 AND status='dispatching'`,
      [schedule.id, schedule.userId, schedule.generation],
    );
    return true;
  } catch (error) {
    await query(
      `UPDATE sales_marketing_social_publish_schedules SET status='pending',dispatch_claimed_at=NULL,updated_at=now()
        WHERE id=$1 AND user_id=$2 AND generation=$3 AND status='dispatching'`,
      [schedule.id, schedule.userId, schedule.generation],
    );
    logger.warn("[marketing:social-schedule] queue submission failed; hourly dispatch will retry", {
      userId: schedule.userId, scheduleId: schedule.id,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
    return false;
  }
}

export async function dispatchMarketingSocialPublishSchedules(now = new Date(), onlyScheduleId?: string): Promise<number> {
  if (!onlyScheduleId) {
    // Recover dispatcher crashes. A delayed QStash delivery may already exist, so re-enqueueing
    // is safe: generation/state claims allow only one worker to start the provider write.
    await query(
      `UPDATE sales_marketing_social_publish_schedules SET status='pending',dispatch_claimed_at=NULL,updated_at=now()
        WHERE status='dispatching' AND dispatch_claimed_at < now()-interval '15 minutes'`,
    );

    const stalePublishes = await query(
      `UPDATE sales_marketing_social_publish_schedules SET status='review',dispatch_claimed_at=NULL,updated_at=now()
        WHERE status='publishing' AND updated_at < now()-interval '15 minutes'
        RETURNING user_id,content_item_id`,
    );
    for (const row of stalePublishes.rows) {
      const userId = row.user_id as string;
      const contentId = row.content_item_id as string;
      await withTransaction(async (client) => {
        const item = await client.query(
          `UPDATE sales_marketing_content_items SET status='publish_review',updated_at=now()
            WHERE id=$1 AND user_id=$2 AND status='publishing' RETURNING id`, [contentId, userId],
        );
        if (item.rows[0]) {
          await client.query(
            `INSERT INTO sales_marketing_approval_events(user_id,entity_type,entity_id,action,note)
             VALUES($1,'content',$2,'publish_review','The scheduled provider request did not finish. Check the social account before retrying.')`,
            [userId, contentId],
          );
        }
      });
    }
  }

  const due = await query<{ id: string }>(
    `SELECT id FROM sales_marketing_social_publish_schedules
      WHERE status='pending' AND scheduled_at <= $1 + interval '6 days'
        AND ($2::uuid IS NULL OR id=$2)
      ORDER BY scheduled_at ASC LIMIT 500`, [now, onlyScheduleId ?? null],
  );
  let queued = 0;
  for (const row of due.rows) {
    const claimed = await claimScheduleForDispatch(row.id, now);
    if (claimed && await enqueueClaimedSchedule(claimed)) queued += 1;
  }
  return queued;
}

async function claimScheduledPublish(userId: string, scheduleId: string, generation: number): Promise<{
  schedule: MarketingSocialSchedule; item: MarketingContentItem;
} | null> {
  return withTransaction(async (client) => {
    // Read the content key without a lock, then lock content before schedule. This matches
    // edits, cancellation, rescheduling, and immediate publishing to avoid lock-order cycles.
    const candidate = await client.query<{ content_item_id: string }>(
      `SELECT content_item_id FROM sales_marketing_social_publish_schedules
        WHERE id=$1 AND user_id=$2 AND generation=$3`, [scheduleId, userId, generation],
    );
    if (!candidate.rows[0]) return null;
    const current = await client.query(
      `SELECT ${CONTENT_COLUMNS} FROM sales_marketing_content_items WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [candidate.rows[0].content_item_id, userId],
    );
    if (!current.rows[0]) {
      await client.query(
        `UPDATE sales_marketing_social_publish_schedules SET status='cancelled',updated_at=now()
          WHERE id=$1 AND user_id=$2 AND generation=$3`, [scheduleId, userId, generation],
      );
      return null;
    }
    const item = mapContent(current.rows[0] as Record<string, unknown>);
    const selected = await client.query(
      `SELECT id,user_id,content_item_id,generation,provider,target_id,target_name,scheduled_at,status
         FROM sales_marketing_social_publish_schedules
        WHERE id=$1 AND user_id=$2 AND generation=$3 AND status IN ('dispatching','queued')
        FOR UPDATE`, [scheduleId, userId, generation],
    );
    if (!selected.rows[0]) return null;
    const schedule = mapSchedule(selected.rows[0] as Record<string, unknown>);
    if (!isSocialPublishDue(schedule.scheduledAt)) {
      // An early delivery must not strand the row in 'queued' — nothing re-dispatches that state.
      // Bump the generation so the hourly re-enqueue gets a fresh QStash deduplication ID.
      await client.query(
        `UPDATE sales_marketing_social_publish_schedules
            SET status='pending',generation=generation+1,dispatch_claimed_at=NULL,updated_at=now()
          WHERE id=$1 AND user_id=$2 AND generation=$3 AND status IN ('dispatching','queued')`,
        [scheduleId, userId, generation],
      );
      return null;
    }
    if (item.status !== "planned" || !item.scheduledAt || item.scheduledAt.getTime() !== schedule.scheduledAt.getTime() ||
      item.provider !== schedule.provider || item.providerTargetId !== schedule.targetId) {
      await client.query(
        `UPDATE sales_marketing_social_publish_schedules SET status='cancelled',dispatch_claimed_at=NULL,updated_at=now()
          WHERE id=$1 AND user_id=$2 AND generation=$3`, [scheduleId, userId, generation],
      );
      return null;
    }
    assertMarketingContentPublishable(item, schedule.provider);
    const updated = await client.query(
      `UPDATE sales_marketing_content_items SET status='publishing',updated_at=now()
        WHERE id=$1 AND user_id=$2 AND status='planned' RETURNING ${CONTENT_COLUMNS}`,
      [schedule.contentItemId, userId],
    );
    if (!updated.rows[0]) return null;
    await client.query(
      `UPDATE sales_marketing_social_publish_schedules SET status='publishing',dispatch_claimed_at=NULL,updated_at=now()
        WHERE id=$1 AND user_id=$2 AND generation=$3 AND status IN ('dispatching','queued')`,
      [scheduleId, userId, generation],
    );
    await client.query(
      `INSERT INTO sales_marketing_approval_events(user_id,entity_type,entity_id,action,note)
       VALUES($1,'content',$2,'publish_started',$3)`,
      [userId, schedule.contentItemId, `Confirmed scheduled ${schedule.provider} publication to ${schedule.targetName.slice(0, 160)} started.`],
    );
    return { schedule: { ...schedule, status: "publishing" }, item: mapContent(updated.rows[0] as Record<string, unknown>) };
  });
}

export async function runScheduledMarketingSocialPublish(userId: string, scheduleId: string, generation: number): Promise<{
  skipped: boolean; status: "skipped" | "published" | "review";
}> {
  const claimed = await claimScheduledPublish(userId, scheduleId, generation);
  if (!claimed) return { skipped: true, status: "skipped" };
  try {
    await publishReservedMarketingContent(userId, claimed.schedule.contentItemId, claimed.schedule.provider, claimed.schedule.targetId);
    return { skipped: false, status: "published" };
  } catch (error) {
    // The provider may have accepted the post before a timeout. Never ask QStash to repeat a public write.
    await query(
      `UPDATE sales_marketing_social_publish_schedules SET status='review',dispatch_claimed_at=NULL,updated_at=now()
        WHERE id=$1 AND user_id=$2 AND generation=$3 AND status='publishing'`,
      [scheduleId, userId, generation],
    );
    logger.warn("[marketing:social-schedule] scheduled provider write needs human review", {
      userId, scheduleId,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
    return { skipped: false, status: "review" };
  }
}

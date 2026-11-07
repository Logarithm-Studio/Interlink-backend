import { query, withTransaction } from "../../config/db";
import { AppError } from "../../utils/errors";
import type { PendingAction, CommandResult } from "./assistant.service";
import type { GeminiToolFunction } from "../ai/geminiClient";

export const PROFESSIONAL_TASK_READ_TOOLS: GeminiToolFunction[] = [{
  name: "read_professional_tasks",
  description: "Read the user's actual Professional Autolink tasks, exact approved arguments/content and confirmed outcomes. Use to answer what was created, delegated, sent or completed, and to avoid repeating work. Returns up to ten owned tasks; it never performs their actions.",
  parameters: { type: "object", properties: { taskId: { type: "string" } } },
}];

export async function getAgentTaskReceipts(userId: string, taskId: string): Promise<{ id: string; name: string; args: Record<string, unknown>; summary: string; status: string; result: { ok: boolean; message: string } | null }[]> {
  const res = await query<{ id: string; name: string; args: Record<string, unknown>; summary: string; status: string; result: { ok: boolean; message: string } | null }>(`SELECT id,name,args,summary,status,result FROM autolink_action_proposals WHERE task_id=$1 AND user_id=$2 ORDER BY created_at,id`, [taskId, userId]);
  return res.rows;
}

export async function readProfessionalTasks(userId: string, args: Record<string, unknown>): Promise<{ message: string; data: unknown }> {
  const taskId = typeof args.taskId === "string" ? args.taskId : null;
  if (taskId && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(taskId)) throw new AppError("Use the exact task ID from this conversation.", 400);
  const tasks = await query(`SELECT id,goal,status,answer FROM autolink_tasks WHERE user_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY updated_at DESC LIMIT 10`, [userId, taskId]);
  const rows = [];
  for (const task of tasks.rows) {
    const receipts = await getAgentTaskReceipts(userId, task.id);
    rows.push({ ...task, receipts: taskId ? receipts : receipts.map(value => {
      const receipt = value as { name: string; summary: string; status: string; result?: { message?: string } };
      return { name: receipt.name, summary: receipt.summary, status: receipt.status, message: receipt.result?.message?.slice(0, 1000) };
    }) });
  }
  const data = { source: "Interlink saved task receipts", tasks: rows, limit: 10 };
  return { message: JSON.stringify(data), data };
}

export interface AgentTask {
  id: string;
  conversationId: string;
  goal: string;
  status: "planning" | "review" | "running" | "ready" | "answered" | "paused" | "blocked";
  answer: string | null;
  steps: { id: string; name: string; summary: string; status: string; message?: string }[];
  action: PendingAction | null;
}

export interface ProposalContext { tz?: string; attachmentDigest?: string; sourceAttachmentDigest?: string }

export async function getAgentTaskContext(userId: string, taskId: string): Promise<ProposalContext> {
  const res = await query<{ execution_context: ProposalContext }>("SELECT execution_context FROM autolink_action_proposals WHERE task_id=$1 AND user_id=$2 ORDER BY created_at,id LIMIT 1", [taskId, userId]);
  return res.rows[0]?.execution_context ?? {};
}

export async function getAgentTask(userId: string, taskId?: string, conversationId?: string): Promise<AgentTask | null> {
  // An expired approval never attempted a write. Preserve it as a receipt and
  // release only the review state so the user can request a fresh plan.
  const expired = await query<{ task_id: string }>(`UPDATE autolink_action_proposals p SET status='cancelled',
    result='{"ok":false,"message":"Approval expired. No action was run. Continue to review a fresh plan."}'::jsonb,updated_at=now()
    WHERE p.user_id=$1 AND p.status='pending' AND p.expires_at<=now()
    AND EXISTS(SELECT 1 FROM autolink_tasks t WHERE t.id=p.task_id AND ($2::uuid IS NULL OR t.id=$2) AND ($3::uuid IS NULL OR t.conversation_id=$3)) RETURNING task_id`, [userId, taskId ?? null, conversationId ?? null]);
  if (expired.rows.length) await query("UPDATE autolink_tasks SET status='ready',updated_at=now() WHERE user_id=$1 AND id=ANY($2::uuid[]) AND status='review'", [userId, expired.rows.map(row => row.task_id)]);
  // A planning process can disappear without performing a write. Release only that
  // read/planning lease; a running provider operation stays locked for human review.
  await query(`UPDATE autolink_tasks SET status='ready',updated_at=now() WHERE user_id=$1
    AND ($2::uuid IS NULL OR id=$2) AND ($3::uuid IS NULL OR conversation_id=$3)
    AND status='planning' AND updated_at<now()-interval '2 minutes'
    AND EXISTS(SELECT 1 FROM autolink_action_proposals p WHERE p.task_id=autolink_tasks.id AND p.status='succeeded')
    AND NOT EXISTS(SELECT 1 FROM autolink_action_proposals p WHERE p.task_id=autolink_tasks.id AND p.status IN ('pending','running','review'))`, [userId, taskId ?? null, conversationId ?? null]);
  const res = await query<{ id: string; conversationId: string; goal: string; status: AgentTask["status"]; answer: string | null }>(
    `SELECT id,conversation_id AS "conversationId",goal,status,answer FROM autolink_tasks
      WHERE user_id=$1 AND ($2::uuid IS NULL OR id=$2) AND ($3::uuid IS NULL OR conversation_id=$3)
      ORDER BY updated_at DESC LIMIT 1`, [userId, taskId ?? null, conversationId ?? null]);
  const task = res.rows[0];
  if (!task) return null;
  const actions = await query<{ id: string; name: string; args: Record<string, unknown>; summary: string; status: string; result: { ok: boolean; message: string } | null }>(
    `SELECT id,name,args,summary,status,result FROM autolink_action_proposals WHERE task_id=$1 AND user_id=$2 ORDER BY created_at,id`, [task.id, userId]);
  const pending = actions.rows.find(action => action.status === "pending");
  return { ...task, steps: actions.rows.map(({ id, name, summary, status, result }) => ({ id, name, summary, status, message: result?.message })),
    action: pending ? { id: pending.id, name: pending.name, args: pending.args, summary: pending.summary, needsConfirm: true } : null };
}

export async function createAgentTask(userId: string, conversationId: string, goal: string): Promise<string> {
  const res = await query<{ id: string }>(`INSERT INTO autolink_tasks(user_id,conversation_id,goal)
    SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM accountant_conversations WHERE id=$2 AND user_id=$1) RETURNING id`, [userId, conversationId, goal]);
  if (!res.rows[0]) throw new AppError("Conversation not found.", 404);
  return res.rows[0].id;
}

/** Save exact reviewed arguments. A later execute request cannot substitute another payload. */
export async function saveTaskPlan(userId: string, taskId: string, plan: CommandResult, context: ProposalContext = {}): Promise<AgentTask> {
  await withTransaction(async client => {
    const locked = await client.query("SELECT id FROM autolink_tasks WHERE id=$1 AND user_id=$2 FOR UPDATE", [taskId, userId]);
    if (!locked.rows[0]) throw new AppError("Task not found.", 404);
    if (plan.action) {
      const prior = await client.query(`SELECT id FROM autolink_action_proposals WHERE task_id=$1 AND
        (status IN ('pending','running','review') OR (name=$2 AND args=$3::jsonb AND status='succeeded')) LIMIT 1`, [taskId, plan.action.name, JSON.stringify(plan.action.args)]);
      if (prior.rows[0]) throw new AppError("This step already ran or needs review. Check its result before creating another action.", 409);
      await client.query(`INSERT INTO autolink_action_proposals(id,task_id,user_id,name,args,summary,execution_context) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb)`,
        [plan.action.id, taskId, userId, plan.action.name, JSON.stringify(plan.action.args), plan.action.summary, JSON.stringify(context)]);
    }
    await client.query(`UPDATE autolink_tasks SET status=$3,answer=$4,updated_at=now() WHERE id=$1 AND user_id=$2`, [taskId, userId, plan.action ? "review" : "answered", plan.answer]);
  });
  return (await getAgentTask(userId, taskId))!;
}

/** Atomic database claim; never hold a transaction across an external provider request. */
export async function executeTaskProposal(userId: string, taskId: string, actionId: string,
  execute: (action: PendingAction, conversationId: string, context: ProposalContext) => Promise<{ ok: boolean; message: string }>,
  attachmentDigest?: string,
): Promise<{ ok: boolean; message: string; task: AgentTask }> {
  const task = await getAgentTask(userId, taskId);
  if (!task) throw new AppError("Task not found.", 404);
  const proposal = await query<{ execution_context: ProposalContext }>("SELECT execution_context FROM autolink_action_proposals WHERE id=$1 AND task_id=$2 AND user_id=$3", [actionId, taskId, userId]);
  const context = proposal.rows[0]?.execution_context ?? {};
  if (context.attachmentDigest && context.attachmentDigest !== attachmentDigest) throw new AppError("Attach the same original file before running this upload. The reviewed file cannot be replaced by a different attachment.", 409);
  const claimed = await withTransaction(async client => {
    await client.query(`SELECT c.id FROM accountant_conversations c JOIN autolink_tasks t ON t.conversation_id=c.id
      WHERE t.id=$1 AND t.user_id=$2 AND c.user_id=$2 FOR UPDATE OF c`, [taskId, userId]);
    const result = await client.query<{ id: string; name: string; args: Record<string, unknown>; summary: string }>(
    `UPDATE autolink_action_proposals SET status='running',updated_at=now() WHERE id=$1 AND task_id=$2 AND user_id=$3 AND status='pending' AND expires_at>now()
      AND EXISTS(SELECT 1 FROM autolink_tasks WHERE id=$2 AND user_id=$3 AND status='review') RETURNING id,name,args,summary`, [actionId, taskId, userId]);
    if (result.rows[0]) await client.query("UPDATE autolink_tasks SET status='running',updated_at=now() WHERE id=$1 AND user_id=$2", [taskId, userId]);
    return result;
  });
  const row = claimed.rows[0];
  if (!row) {
    const saved = await query<{ status: string; result: { ok: boolean; message: string } | null }>("SELECT status,result FROM autolink_action_proposals WHERE id=$1 AND task_id=$2 AND user_id=$3", [actionId, taskId, userId]);
    if (!saved.rows[0]) throw new AppError("Action not found.", 404);
    if (saved.rows[0].result && saved.rows[0].status !== "cancelled") return { ...saved.rows[0].result, task: (await getAgentTask(userId, taskId))! };
    throw new AppError("This action is running, expired, or paused. Check its status before continuing; it has not been run again.", 409);
  }
  let result: { ok: boolean; message: string };
  try { result = await execute({ ...row, needsConfirm: true }, task.conversationId, context); }
  catch { result = { ok: false, message: "The action could not be confirmed. Check the destination before taking further action; no automatic retry will occur." }; }
  // If receipt persistence fails after the operation, leave 'running' locked. A retry
  // cannot repeat the operation, even after process restart or lost response.
  await withTransaction(async client => {
    await client.query("UPDATE autolink_action_proposals SET status=$4,result=$5::jsonb,updated_at=now() WHERE id=$1 AND task_id=$2 AND user_id=$3", [actionId, taskId, userId, result.ok ? "succeeded" : "review", JSON.stringify(result)]);
    await client.query("UPDATE autolink_tasks SET status=$3,updated_at=now() WHERE id=$1 AND user_id=$2", [taskId, userId, result.ok ? "ready" : "blocked"]);
  });
  return { ...result, task: (await getAgentTask(userId, taskId))! };
}

export async function pauseAgentTask(userId: string, taskId: string): Promise<AgentTask> {
  const updated = await query("UPDATE autolink_tasks SET status='paused',updated_at=now() WHERE id=$1 AND user_id=$2 AND status IN ('review','ready','answered','blocked') RETURNING id", [taskId, userId]);
  if (!updated.rows[0]) throw new AppError("Task not found or currently running.", 409);
  return (await getAgentTask(userId, taskId))!;
}

export async function claimTaskContinuation(userId: string, taskId: string): Promise<AgentTask> {
  const task = await getAgentTask(userId, taskId);
  if (!task) throw new AppError("Task not found.", 404);
  if (task.steps.filter(step => step.status !== "cancelled").length >= 12) throw new AppError("This task reached its 12-action limit. Review the results and start a new request for further work.", 409);
  const claimed = await withTransaction(async client => {
    await client.query(`SELECT c.id FROM accountant_conversations c JOIN autolink_tasks t ON t.conversation_id=c.id
      WHERE t.id=$1 AND t.user_id=$2 AND c.user_id=$2 FOR UPDATE OF c`, [taskId, userId]);
    return client.query("UPDATE autolink_tasks SET status='planning',updated_at=now() WHERE id=$1 AND user_id=$2 AND status='ready' RETURNING id", [taskId, userId]);
  });
  if (!claimed.rows[0]) throw new AppError("This task is waiting for review or is already being continued.", 409);
  return task;
}

export async function resumeAgentTask(userId: string, taskId: string): Promise<AgentTask> {
  const task = await getAgentTask(userId, taskId);
  if (!task) throw new AppError("Task not found.", 404);
  if (task.status !== "paused") return task;
  const status = task.action ? "review" : task.steps.some(step => step.status === "review" || step.status === "running") ? "blocked" : "ready";
  await query("UPDATE autolink_tasks SET status=$3,updated_at=now() WHERE id=$1 AND user_id=$2 AND status='paused'", [taskId, userId, status]);
  return (await getAgentTask(userId, taskId))!;
}

export async function releaseTaskContinuation(userId: string, taskId: string): Promise<void> {
  await query("UPDATE autolink_tasks SET status='ready',updated_at=now() WHERE id=$1 AND user_id=$2 AND status='planning'", [taskId, userId]);
}

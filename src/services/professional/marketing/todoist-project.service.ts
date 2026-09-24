import { query } from "../../../config/db";
import { AppError, NotFoundError } from "../../../utils/errors";
import { getProjects } from "../../todoist/todoist.service";
import { resolveMarketingTodoistProjectId } from "./todoist-project.model";

export interface MarketingTodoistProjectPreference {
  projectId: string | null;
  projectName: string | null;
  updatedAt: Date | null;
}

export interface MarketingCampaignTodoistProject {
  projectId: string | null;
  updatedAt: Date;
}

export async function getMarketingCampaignTodoistProject(userId: string, campaignId: string): Promise<MarketingCampaignTodoistProject> {
  const result = await query<{ todoist_project_id: string | null; updated_at: Date }>(
    `SELECT todoist_project_id,updated_at FROM sales_marketing_campaigns WHERE id=$1 AND user_id=$2`,
    [campaignId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError("Marketing campaign");
  return { projectId: row.todoist_project_id, updatedAt: row.updated_at };
}

export async function saveMarketingCampaignTodoistProject(
  userId: string,
  campaignId: string,
  projectId: string | null,
): Promise<MarketingCampaignTodoistProject> {
  if (projectId) {
    const campaign = await query<{ id: string }>(
      `SELECT id FROM sales_marketing_campaigns WHERE id=$1 AND user_id=$2`, [campaignId, userId],
    );
    if (!campaign.rows[0]) throw new NotFoundError("Marketing campaign");
    const projects = await getProjects(userId);
    if (!projects.some((project) => project.id === projectId)) {
      throw new AppError("That Todoist project is not available in the connected account. Refresh the project list and choose again.", 409);
    }
  }
  const result = await query<{ todoist_project_id: string | null; updated_at: Date }>(
    `UPDATE sales_marketing_campaigns SET todoist_project_id=$3,updated_at=now()
      WHERE id=$1 AND user_id=$2 RETURNING todoist_project_id,updated_at`,
    [campaignId, userId, projectId],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError("Marketing campaign");
  return { projectId: row.todoist_project_id, updatedAt: row.updated_at };
}

export async function getMarketingTodoistProjectPreference(userId: string): Promise<MarketingTodoistProjectPreference> {
  const result = await query<{ project_id: string | null; updated_at: Date }>(
    `SELECT project_id,updated_at FROM sales_marketing_todoist_preferences WHERE user_id=$1`, [userId],
  );
  const row = result.rows[0];
  if (!row) return { projectId: null, projectName: null, updatedAt: null };
  if (!row.project_id) return { projectId: null, projectName: null, updatedAt: row.updated_at };
  return { projectId: row.project_id, projectName: null, updatedAt: row.updated_at };
}

export async function saveMarketingTodoistProjectPreference(
  userId: string,
  projectId: string | null,
): Promise<MarketingTodoistProjectPreference> {
  let projectName: string | null = null;
  if (projectId) {
    const projects = await getProjects(userId);
    const selected = projects.find((project) => project.id === projectId);
    if (!selected) throw new AppError("That Todoist project is not available in the connected account. Refresh the project list and choose again.", 409);
    projectName = selected.name;
  }

  const result = await query<{ project_id: string | null; updated_at: Date }>(
    `INSERT INTO sales_marketing_todoist_preferences(user_id,project_id,updated_at)
       VALUES($1,$2,now())
     ON CONFLICT(user_id) DO UPDATE SET project_id=EXCLUDED.project_id,updated_at=now()
     RETURNING project_id,updated_at`,
    [userId, projectId],
  );
  return { projectId: result.rows[0].project_id, projectName, updatedAt: result.rows[0].updated_at };
}

export async function getMarketingTodoistProjectId(userId: string, campaignId?: string | null): Promise<string | null> {
  if (campaignId) {
    const campaign = await query<{ campaign_project_id: string | null; default_project_id: string | null }>(
      `SELECT mc.todoist_project_id AS campaign_project_id,p.project_id AS default_project_id
         FROM sales_marketing_campaigns mc
         LEFT JOIN sales_marketing_todoist_preferences p ON p.user_id=mc.user_id
        WHERE mc.id=$1 AND mc.user_id=$2`, [campaignId, userId],
    );
    if (campaign.rows[0]) {
      return resolveMarketingTodoistProjectId(campaign.rows[0].campaign_project_id, campaign.rows[0].default_project_id);
    }
  }
  const result = await query<{ project_id: string | null }>(
    `SELECT project_id FROM sales_marketing_todoist_preferences WHERE user_id=$1`, [userId],
  );
  return result.rows[0]?.project_id ?? null;
}

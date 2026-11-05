import { z } from "zod";
import { query } from "../../../config/db";
import type { GeminiToolFunction } from "../../ai/geminiClient";

export const MARKETING_READ_TOOLS: GeminiToolFunction[] = [{
  name: "read_marketing_campaigns",
  description: "Read the user's actual saved Interlink campaigns, including exact IDs, draft/delivery status, goals and copy. Use for saved draft questions and after creating a campaign. This reads local records; it never sends or publishes.",
  parameters: { type: "object", properties: { campaignId: { type: "string", description: "Exact saved campaign UUID, if known." }, query: { type: "string", description: "Optional topic or subject phrase to find a campaign." } } },
}];

const Input = z.object({ campaignId: z.string().uuid().optional(), query: z.string().trim().max(120).optional() });
export async function readMarketingCampaigns(userId: string, args: Record<string, unknown>): Promise<{ message: string; data: unknown }> {
  const input = Input.parse(args);
  const result = await query(
    `SELECT id,topic,subject,audience,objective,success_metric AS "successMetric",channels,status,
            provider_campaign_id AS "providerCampaignId",sent_count AS "sentCount",
            LEFT(body,CASE WHEN $2::uuid IS NULL THEN 400 ELSE 4000 END) AS "bodyPreview",created_at AS "createdAt"
       FROM sales_marketing_campaigns
      WHERE user_id=$1 AND ($2::uuid IS NULL OR id=$2)
        AND ($3::text IS NULL OR topic ILIKE '%' || $3 || '%' OR subject ILIKE '%' || $3 || '%')
      ORDER BY created_at DESC LIMIT 20`, [userId, input.campaignId ?? null, input.query || null]);
  const data = { campaigns: result.rows, limit: 20, source: "Interlink saved campaigns" };
  return { message: JSON.stringify(data), data };
}

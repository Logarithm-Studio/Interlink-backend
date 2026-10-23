import { z } from "zod";
import { BadRequestError } from "../../../utils/errors";
import { MARKETING_GOAL_METRICS } from "./campaign-goals.model";

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid calendar date in YYYY-MM-DD format.").refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, { message: "Use a valid calendar date in YYYY-MM-DD format." });
const CampaignBody = z.object({
  topic: z.string().trim().min(1).max(300), audience: z.string().trim().max(500).optional(),
  objective: z.string().trim().max(500).optional(), offer: z.string().trim().max(1000).optional(),
  successMetric: z.string().trim().max(500).optional(),
  goalMetric: z.enum(MARKETING_GOAL_METRICS).optional(),
  goalTarget: z.number().int().min(1).max(1_000_000_000).optional(),
  goalCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
  channels: z.array(z.enum(["email", "instagram", "facebook", "linkedin", "youtube", "blog", "landing_page", "search", "ad", "influencer", "event", "other"])).min(1).max(12).optional(),
  startDate: DateOnly.optional(), endDate: DateOnly.optional(),
  budgetCents: z.number().int().min(0).max(1_000_000_000).optional(),
}).refine((data) => !data.startDate || !data.endDate || data.endDate >= data.startDate, { message: "endDate must be on or after startDate." })
  .refine((data) => {
    if (!data.goalMetric) return data.goalTarget === undefined && data.goalCurrency === undefined;
    if (data.goalTarget === undefined) return false;
    return data.goalMetric === "closed_won_value" ? Boolean(data.goalCurrency) : data.goalCurrency === undefined;
  }, { message: "Choose a target and, for closed-won value, its three-letter currency." });

export function parseCampaignInput(value: unknown): z.infer<typeof CampaignBody> {
  const parsed = CampaignBody.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".");
    throw new BadRequestError(issue ? `${field ? `${field}: ` : ""}${issue.message}` : "Invalid campaign brief.");
  }
  return parsed.data;
}

import { z } from "zod";

const optionalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Use a real calendar date.").nullable().optional();

const moneyAmount = z.string().trim().regex(/^\d{1,11}(?:\.\d{1,2})?$/, "Enter a non-negative amount with up to two decimals.").nullable().optional();
const webUrl = z.string().trim().url().max(2000).refine((value) => {
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}, "Use an http or https link.").nullable().optional();
const resultCount = z.number().int().min(0).max(1_000_000_000).nullable().optional();

export const MarketingActivationCreateBody = z.object({
  campaignId: z.string().uuid().nullable().optional(),
  type: z.enum(["event", "influencer"]),
  name: z.string().trim().min(1).max(200),
  owner: z.string().trim().max(200).nullable().optional(),
  deliverables: z.string().max(5000).optional(),
  date: optionalDate,
  plannedCost: moneyAmount,
  actualCost: moneyAmount,
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).optional(),
  url: webUrl,
  outcome: z.string().max(5000).optional(),
  reach: resultCount,
  engagements: resultCount,
  leads: resultCount,
  conversions: resultCount,
  status: z.enum(["planned", "in_progress", "completed", "cancelled"]).optional(),
});

export const MarketingActivationPatchBody = z.object({
  campaignId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  owner: z.string().trim().max(200).nullable().optional(),
  deliverables: z.string().max(5000).optional(),
  date: optionalDate,
  plannedCost: moneyAmount,
  actualCost: moneyAmount,
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).optional(),
  url: webUrl,
  outcome: z.string().max(5000).optional(),
  reach: resultCount,
  engagements: resultCount,
  leads: resultCount,
  conversions: resultCount,
  status: z.enum(["planned", "in_progress", "completed", "cancelled"]).optional(),
}).refine((patch) => Object.values(patch).some((value) => value !== undefined), {
  message: "Choose at least one activation field to update.",
});

export type MarketingActivationCreateInput = z.infer<typeof MarketingActivationCreateBody>;
export type MarketingActivationPatchInput = z.infer<typeof MarketingActivationPatchBody>;

export function activationCampaignMatches(requestedCampaignId: string | undefined, activationCampaignId: string | null): boolean {
  return requestedCampaignId === undefined || requestedCampaignId === activationCampaignId;
}

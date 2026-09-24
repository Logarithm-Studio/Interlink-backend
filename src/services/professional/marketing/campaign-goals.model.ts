export const MARKETING_GOAL_METRICS = [
  "attributed_leads",
  "qualified_leads",
  "sales_opportunities",
  "closed_won_deals",
  "closed_won_value",
  "published_content",
  "activation_reach",
  "activation_engagements",
  "activation_leads",
  "activation_conversions",
  "email_unique_opens",
  "email_unique_clicks",
] as const;

export type MarketingGoalMetric = typeof MARKETING_GOAL_METRICS[number];
export type MarketingGoalState = "awaiting_data" | "in_progress" | "reached";

export interface MarketingGoalProgress {
  metric: MarketingGoalMetric;
  target: number;
  currency: string | null;
  actual: number | null;
  attainmentPercent: number | null;
  state: MarketingGoalState;
}

export interface MarketingLearningSignals {
  leads: number;
  qualifiedLeads: number;
  opportunities: number;
  uniqueEmailClicks: number | null;
  unsubscribes: number | null;
  approvedContent: number;
  plannedContent: number;
  publishedContent: number;
}

export interface MarketingExperimentSuggestion {
  title: string;
  evidence: string;
  hypothesis: string;
  nextStep: string;
  measure: string;
}

export function compareMarketingGoal(
  metric: MarketingGoalMetric,
  target: number,
  currency: string | null,
  actual: number | null,
): MarketingGoalProgress {
  if (!Number.isSafeInteger(target) || target <= 0) throw new Error("Campaign goal target must be a positive safe integer.");
  if (metric === "closed_won_value" && (!currency || !/^[A-Z]{3}$/.test(currency))) {
    throw new Error("Closed-won value goals require a three-letter currency code.");
  }
  if (metric !== "closed_won_value" && currency !== null) {
    throw new Error("Only closed-won value goals can have a currency.");
  }
  const validActual = actual !== null && Number.isSafeInteger(actual) && actual >= 0 ? actual : null;
  return {
    metric,
    target,
    currency,
    actual: validActual,
    attainmentPercent: validActual === null ? null : Math.round((validActual / target) * 100),
    state: validActual === null ? "awaiting_data" : validActual >= target ? "reached" : "in_progress",
  };
}

/** Grounded next-step hypotheses from available counts; never an attribution or significance claim. */
export function suggestMarketingExperiments(signals: MarketingLearningSignals): MarketingExperimentSuggestion[] {
  const suggestions: MarketingExperimentSuggestion[] = [];
  if ((signals.unsubscribes ?? 0) > 0) {
    suggestions.push({
      title: "Review audience fit before the next email",
      evidence: `Mailchimp reports ${signals.unsubscribes} unsubscribe${signals.unsubscribes === 1 ? "" : "s"}.`,
      hypothesis: "The audience, permission, or promise may not match what some recipients expected.",
      nextStep: "Review the signup source, consent wording, and audience criteria before the next send.",
      measure: "Unsubscribes in the next provider report, alongside clicks and attributed leads.",
    });
  }
  if ((signals.uniqueEmailClicks ?? 0) > 0 && signals.leads === 0) {
    suggestions.push({
      title: "Check the tracked click-to-lead path",
      evidence: `Mailchimp reports ${signals.uniqueEmailClicks} unique click${signals.uniqueEmailClicks === 1 ? "" : "s"}; Interlink has no attributed CRM leads yet.`,
      hypothesis: "The tagged destination or form may be hard to complete, or its campaign tracking may be missing.",
      nextStep: "Submit a controlled test through the campaign's tracked form and confirm the campaign touch appears on the contact.",
      measure: "Campaign-attributed CRM leads. Provider clicks are not the same as landing-page visits.",
    });
  }
  if (signals.leads > 0 && signals.qualifiedLeads === 0) {
    suggestions.push({
      title: "Test the lead qualification handoff",
      evidence: `${signals.leads} unique attributed lead${signals.leads === 1 ? "" : "s"} are recorded; none is currently qualified.`,
      hypothesis: "A clearer qualification question or faster first response may help the team identify sales-ready leads.",
      nextStep: "Review the first few lead records, then test one qualification question or response-time change on the next cohort.",
      measure: "Qualified leads among the next campaign-attributed contacts.",
    });
  } else if (signals.qualifiedLeads > 0 && signals.opportunities === 0) {
    suggestions.push({
      title: "Review the qualified-lead handoff",
      evidence: `${signals.qualifiedLeads} contacts are currently qualified; no sales opportunity is linked to this campaign.`,
      hypothesis: "A visible next step for qualified contacts may reduce gaps between marketing and sales follow-up.",
      nextStep: "Review ownership and follow-up timing, then test one meeting or discovery-call prompt with the next qualified lead.",
      measure: "Campaign-linked opportunities and follow-up completion.",
    });
  }
  if (signals.approvedContent + signals.plannedContent > 0 && signals.publishedContent === 0) {
    const count = signals.approvedContent + signals.plannedContent;
    suggestions.push({
      title: "Check the approved-content distribution path",
      evidence: `${count} content item${count === 1 ? " is" : "s are"} approved or planned; none is marked published.`,
      hypothesis: "The next learning opportunity may be blocked by an unassigned publishing step rather than the creative itself.",
      nextStep: "Open the content calendar, confirm the destination and owner, then publish only after the normal review step.",
      measure: "Provider-confirmed or user-recorded published items and their available read-back metrics.",
    });
  }
  return suggestions.slice(0, 3);
}

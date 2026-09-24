export interface MarketingActivationDealOutcomeRow {
  activation_id: string;
  currency: string;
  opportunities: number | string;
  crm_won_deals: number | string;
  pipeline_cents: number | string;
  closed_won_cents: number | string;
}

export interface MarketingActivationContractOutcomeRow {
  activation_id: string;
  currency: string;
  signed_contract_cents: number | string;
}

export interface MarketingActivationCrmOutcome {
  opportunities: number;
  wonDeals: number;
  pipelineByCurrency: { currency: string; amountCents: number }[];
  closedWonByCurrency: { currency: string; amountCents: number }[];
  signedContractByCurrency: { currency: string; amountCents: number }[];
}

/** Combine SQL currency groups without summing different currencies together. */
export function mapMarketingActivationCrmOutcomes(
  dealRows: MarketingActivationDealOutcomeRow[],
  contractRows: MarketingActivationContractOutcomeRow[],
): Map<string, MarketingActivationCrmOutcome> {
  const outcomes = new Map<string, {
    opportunities: number;
    wonDeals: number;
    pipeline: Map<string, number>;
    won: Map<string, number>;
    signed: Map<string, number>;
  }>();
  const getOutcome = (activationId: string) => {
    let outcome = outcomes.get(activationId);
    if (!outcome) {
      outcome = { opportunities: 0, wonDeals: 0, pipeline: new Map(), won: new Map(), signed: new Map() };
      outcomes.set(activationId, outcome);
    }
    return outcome;
  };
  const addAmount = (target: Map<string, number>, currency: string, value: number | string) => {
    const amount = Number(value);
    if (Number.isFinite(amount)) target.set(currency, (target.get(currency) ?? 0) + amount);
  };

  for (const row of dealRows) {
    const outcome = getOutcome(row.activation_id);
    outcome.opportunities += Number(row.opportunities) || 0;
    outcome.wonDeals += Number(row.crm_won_deals) || 0;
    addAmount(outcome.pipeline, row.currency, row.pipeline_cents);
    addAmount(outcome.won, row.currency, row.closed_won_cents);
  }
  for (const row of contractRows) {
    addAmount(getOutcome(row.activation_id).signed, row.currency, row.signed_contract_cents);
  }

  const toValues = (values: Map<string, number>) => [...values]
    .map(([currency, amountCents]) => ({ currency, amountCents }))
    .filter((row) => row.amountCents !== 0)
    .sort((a, b) => a.currency.localeCompare(b.currency));
  return new Map([...outcomes].map(([activationId, outcome]) => [activationId, {
    opportunities: outcome.opportunities,
    wonDeals: outcome.wonDeals,
    pipelineByCurrency: toValues(outcome.pipeline),
    closedWonByCurrency: toValues(outcome.won),
    signedContractByCurrency: toValues(outcome.signed),
  }]));
}

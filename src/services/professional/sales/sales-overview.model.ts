import type { DealStage, SalesContract, SalesDeal, SalesOverview } from "./sales.service";

export interface SalesCurrencyAmount { currency: string; amountCents: number }

export function salesAmountsByCurrency(rows: readonly { currency: string; amountCents: number }[]): SalesCurrencyAmount[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const currency = row.currency.toUpperCase();
    totals.set(currency, (totals.get(currency) ?? 0) + row.amountCents);
  }
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amountCents]) => ({ currency, amountCents }));
}

export function formatSalesAmounts(amounts: readonly SalesCurrencyAmount[]): string {
  return amounts.length
    ? amounts.map(({ currency, amountCents }) => `${currency} ${(amountCents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`).join(" + ")
    : "USD 0";
}

export function buildSalesOverview(deals: readonly SalesDeal[], contracts: readonly SalesContract[], now = Date.now()): SalesOverview {
  const open = deals.filter((deal) => deal.stage !== "won" && deal.stage !== "lost");
  const won = deals.filter((deal) => deal.stage === "won");
  const pipelineByCurrency = salesAmountsByCurrency(open);
  const wonByCurrency = salesAmountsByCurrency(won);
  const usdTotal = (amounts: SalesCurrencyAmount[]) => amounts.find((amount) => amount.currency === "USD")?.amountCents ?? 0;
  const stages: DealStage[] = ["lead", "qualified", "proposal", "negotiation", "won", "lost", "nurture"];
  const stageBreakdown = stages.map((stage) => {
    const inStage = deals.filter((deal) => deal.stage === stage);
    const valuesByCurrency = salesAmountsByCurrency(inStage);
    return { stage, count: inStage.length, valueCents: usdTotal(valuesByCurrency), valuesByCurrency };
  }).filter((stage) => stage.count > 0);
  const lastActivity = (deal: SalesDeal) => new Date(deal.lastActivityAt ?? deal.createdAt).getTime();
  const atRisk = open.filter((deal) => lastActivity(deal) < now - 14 * 86_400_000)
    // Amounts in different currencies cannot be ranked without an exchange rate.
    .sort((a, b) => lastActivity(a) - lastActivity(b) || a.id.localeCompare(b.id))
    .slice(0, 5)
    .map((deal) => ({ id: deal.id, title: deal.title, company: deal.company, amountCents: deal.amountCents, currency: deal.currency, stage: deal.stage }));
  return {
    briefing: `${open.length} open deal(s) worth ${formatSalesAmounts(pipelineByCurrency)}; ${atRisk.length} need attention.`,
    pipelineByCurrency, wonByCurrency,
    // Legacy dollar fields stay available, but must contain USD only.
    pipelineValueCents: usdTotal(pipelineByCurrency), wonValueCents: usdTotal(wonByCurrency),
    openCount: open.length, stageBreakdown, atRisk,
    contractsOut: contracts.filter((contract) => contract.status === "sent").length,
  };
}

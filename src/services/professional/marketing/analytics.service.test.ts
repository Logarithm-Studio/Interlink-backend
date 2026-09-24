import assert from "node:assert/strict";
import test from "node:test";
import { loadGoogleAdsAnalyticsAccounts, loadGoogleAdsCampaignMetrics, loadStripeBalanceMetrics, normalizeGa4Analytics, normalizeGoogleAdsCampaignMetrics, normalizeMarketingSocialInsights, normalizeSearchConsoleAnalytics, normalizeStripeBalanceTransactions } from "./analytics.service";

test("Google Ads discovery expands manager accounts and only returns reportable customer accounts", async () => {
  const requests: { toolName: string; args: Record<string, unknown> }[] = [];
  const result = await loadGoogleAdsAnalyticsAccounts(async (toolName, args) => {
    requests.push({ toolName, args });
    if (toolName === "GOOGLEADS_LIST_ACCESSIBLE_CUSTOMERS") return {
      ok: true, message: "", data: { resource_names: ["customers/1234567890", "customers/9876543210"] },
    };
    const id = args.customer_id;
    if (id === "1234567890") return {
      ok: true, message: "", data: { sub_accounts: [
        { customer_id: "1111111111", descriptive_name: "Nested manager", manager: true },
        { customer_id: "2222222222", descriptive_name: "Northwind", manager: false },
      ] },
    };
    if (id === "1111111111") return {
      ok: true, message: "", data: { sub_accounts: [{ customer_id: "3333333333", descriptive_name: "Contoso Ads", manager: false }] },
    };
    return { ok: true, message: "", data: { sub_accounts: [] } };
  });

  assert.deepEqual(result.accounts, [
    { ref: "9876543210", name: "Google Ads 9876543210" },
    { ref: "2222222222", name: "Northwind" },
    { ref: "3333333333", name: "Contoso Ads" },
  ].sort((a, b) => a.name.localeCompare(b.name)));
  assert.equal(result.truncated, false);
  assert.equal(requests.length, 4);
  assert.equal(result.accounts.some((account) => account.ref === "1234567890" || account.ref === "1111111111"), false);
});

test("Google Ads snapshots normalize account currency, spend micros, and configured conversion metrics", () => {
  const result = normalizeGoogleAdsCampaignMetrics({ response_data: { results: [
    { customer: { currency_code: "USD" }, campaign: { id: "1", name: "Spring launch", status: "ENABLED" }, metrics: { impressions: "1200", clicks: "86", cost_micros: "45500000", conversions: "9.5", conversions_value: "170.25" } },
    { customer: { currency_code: "USD" }, campaign: { id: "2", name: "Retargeting", status: "PAUSED" }, metrics: { impressions: 300, clicks: 17, costMicros: 12500000, conversions: 2, conversionsValue: 50 } },
  ] } });

  assert.equal(result.currency, "USD");
  assert.equal(result.impressions, 1500);
  assert.equal(result.clicks, 103);
  assert.equal(result.costMicros, 58000000);
  assert.equal(result.conversions, 11.5);
  assert.equal(result.conversionValue, 220.25);
  assert.equal(result.campaignRowsReturned, 2);
  assert.equal(result.truncated, false);
  assert.match(String(result.note), /not Interlink CRM-attributed leads/);
  assert.deepEqual((result.campaigns as Record<string, unknown>[]).map((campaign) => campaign.name), ["Spring launch", "Retargeting"]);
});

test("Google Ads reporting pins the selected customer and validated date range", async () => {
  let request: { toolName: string; args: Record<string, unknown> } | null = null;
  const result = await loadGoogleAdsCampaignMetrics("1234567890", "2026-09-01", "2026-09-30", async (toolName, args) => {
    request = { toolName, args };
    return { ok: true, message: "", data: { results: [] } };
  });

  assert.equal(request?.toolName, "GOOGLEADS_SEARCH_STREAM_GAQL");
  assert.equal(request?.args.customer_id, "1234567890");
  assert.match(String(request?.args.query), /segments\.date BETWEEN '2026-09-01' AND '2026-09-30'/);
  assert.match(String(request?.args.query), /campaign\.status != 'REMOVED'/);
  assert.equal(result.currency, null);
  await assert.rejects(() => loadGoogleAdsCampaignMetrics("12345'; DROP", "2026-09-01", "2026-09-30", async () => {
    throw new Error("The provider must not be called for an invalid account ID.");
  }), /valid Google Ads customer account/);
});

test("Google Ads campaign row cap marks aggregate totals as incomplete", () => {
  const result = normalizeGoogleAdsCampaignMetrics({ results: Array.from({ length: 501 }, (_, index) => ({
    campaign: { id: String(index), name: `Campaign ${index}`, status: "ENABLED" },
    customer: { currency_code: "USD" },
    metrics: { impressions: "1", clicks: "1", cost_micros: "1000000", conversions: "1", conversions_value: "2" },
  })) });
  assert.equal(result.campaignRowsReturned, 500);
  assert.equal(result.impressions, 500);
  assert.equal(result.truncated, true);
  assert.match(String(result.truncationNote), /totals may be incomplete/);
});

test("GA4 snapshots normalize channel rows and preserve separate engagement metrics", () => {
  const result = normalizeGa4Analytics({ data: { rowCount: 2, rows: [
    { dimensionValues: [{ value: "Organic Search" }, { value: "google / organic" }, { value: "Fall launch" }], metricValues: [{ value: "100" }, { value: "75" }, { value: "6" }] },
    { dimensionValues: [{ value: "Email" }, { value: "newsletter / email" }, { value: "September newsletter" }], metricValues: [{ value: "30" }, { value: "24" }, { value: "3" }] },
  ] } }, { rows: [{ metricValues: [{ value: "130" }, { value: "85" }, { value: "9" }, { value: "1250.5" }] }] }, {
    currencyCode: "USD", rowCount: 2, rows: [
      { dimensionValues: [{ value: "/pricing" }], metricValues: [{ value: "80" }, { value: "4" }, { value: "950.25" }] },
      { dimensionValues: [{ value: "/signup" }], metricValues: [{ value: "50" }, { value: "5" }, { value: "300.25" }] },
    ],
  });
  assert.equal(result.sessions, 130);
  assert.equal(result.users, 85);
  assert.equal(result.keyEvents, 9);
  assert.equal(result.totalRevenue, 1250.5);
  assert.equal(result.revenueCurrency, "USD");
  assert.equal(result.channelUsersAreNonAdditive, true);
  assert.equal(result.breakdownTruncated, false);
  assert.equal(result.rowCount, 2);
  assert.deepEqual(result.channels, [
    { channel: "Organic Search", sessions: 100, keyEvents: 6 },
    { channel: "Email", sessions: 30, keyEvents: 3 },
  ]);
  assert.deepEqual(result.campaigns, [
    { channel: "Organic Search", sourceMedium: "google / organic", campaign: "Fall launch", sessions: 100, keyEvents: 6 },
    { channel: "Email", sourceMedium: "newsletter / email", campaign: "September newsletter", sessions: 30, keyEvents: 3 },
  ]);
  assert.deepEqual(result.landingPages, [
    { path: "/pricing", sessions: 80, keyEvents: 4, revenue: 950.25 },
    { path: "/signup", sessions: 50, keyEvents: 5, revenue: 300.25 },
  ]);
  assert.equal(result.landingPagesTruncated, false);
});

test("GA4 landing page normalization marks capped rows and keeps missing currency explicit", () => {
  const result = normalizeGa4Analytics({ rows: [], rowCount: 0 }, { rows: [{ metricValues: [{ value: "0" }, { value: "0" }, { value: "0" }, { value: "0" }] }] }, {
    rowCount: 2,
    rows: [{ dimensionValues: [{ value: "/one" }], metricValues: [{ value: "4" }, { value: "1" }, { value: "0" }] }],
  });
  assert.equal(result.landingPageRowCount, 2);
  assert.equal(result.landingPagesTruncated, true);
  assert.equal(result.landingPageRevenueCurrency, null);
  assert.equal(result.revenueCurrency, null);
});

test("Search Console snapshots sum clicks and impressions and weight average position by impressions", () => {
  const result = normalizeSearchConsoleAnalytics({ response_data: { rows: [
    { keys: ["2026-09-01"], clicks: 10, impressions: 100, ctr: 0.1, position: 2 },
    { keys: ["2026-09-02"], clicks: 6, impressions: 300, ctr: 0.02, position: 6 },
  ] } });
  assert.equal(result.clicks, 16);
  assert.equal(result.impressions, 400);
  assert.equal(result.ctr, 0.04);
  assert.equal(result.averagePosition, 5);
  assert.equal(result.dataState, "final");
  assert.equal(result.days.length, 2);
});

test("Search Console query and page reports sort top rows and discard page URL parameters", () => {
  const result = normalizeSearchConsoleAnalytics({ rows: [{ keys: ["2026-09-01"], clicks: 2, impressions: 20, ctr: 0.1, position: 3 }] }, {
    rows: [
      { keys: ["low volume term"], clicks: 1, impressions: 4, ctr: 0.25, position: 2 },
      { keys: ["high volume term"], clicks: 9, impressions: 90, ctr: 0.1, position: 4 },
    ],
  }, {
    rows: [
      { keys: ["https://example.test/campaign?a=private&email=person@example.test#form"], clicks: 4, impressions: 40, ctr: 0.1, position: 5 },
    ],
  });
  assert.deepEqual(result.topQueries, [
    { query: "high volume term", clicks: 9, impressions: 90, ctr: 0.1, position: 4 },
    { query: "low volume term", clicks: 1, impressions: 4, ctr: 0.25, position: 2 },
  ]);
  assert.deepEqual(result.topPages, [
    { page: "/campaign", clicks: 4, impressions: 40, ctr: 0.1, position: 5 },
  ]);
  assert.equal(result.topQueriesUnavailable, false);
  assert.match(String(result.dimensionReportNote), /potentially sensitive/);
});

test("social insights preserve daily values and sum object-valued follow metrics separately", () => {
  const result = normalizeMarketingSocialInsights({ data: { data: [
    { name: "reach", values: [{ value: 20, end_time: "2026-09-01T00:00:00+0000" }, { value: 30, end_time: "2026-09-02T00:00:00+0000" }] },
    { name: "follows_and_unfollows", values: [{ value: { follows: 4, unfollows: 1 }, end_time: "2026-09-01T00:00:00+0000" }] },
  ] } });
  assert.deepEqual(result.metrics, [
    { name: "reach", points: [{ date: "2026-09-01", value: 20 }, { date: "2026-09-02", value: 30 }], totals: { total: 50 } },
    { name: "follows_and_unfollows", points: [{ date: "2026-09-01", value: { follows: 4, unfollows: 1 } }], totals: { follows: 4, unfollows: 1 } },
  ]);
  assert.match(String(result.note), /repeat viewers/);
});

test("Stripe balance snapshots separate currencies and summarize only payment and refund activity", () => {
  const result = normalizeStripeBalanceTransactions([
    { type: "charge", currency: "usd", amount: 1500, fee: 45, net: 1455, status: "available" },
    { type: "payment_refund", currency: "usd", amount: -300, fee: 0, net: -300, status: "pending" },
    { type: "payment", currency: "eur", amount: 1200, fee: 35, status: "available" },
    { type: "payout", currency: "usd", amount: -1155, fee: 0, net: -1155, status: "pending" },
    { type: "adjustment", currency: "usd", amount: -100, fee: 0, net: -100, status: "available" },
  ], false, 2);

  assert.deepEqual(result.currencies, [
    {
      currency: "EUR", grossPaymentsMinor: 1200, refundsMinor: 0, feesMinor: 35,
      paymentReversalMinor: 0, refundsReturnedMinor: 0, netAfterFeesMinor: 1165,
      paymentCount: 1, refundCount: 0, paymentReversalCount: 0, refundReturnCount: 0,
      pendingNetMinor: 0, availableNetMinor: 1165,
    },
    {
      currency: "USD", grossPaymentsMinor: 1500, refundsMinor: 300, feesMinor: 45,
      paymentReversalMinor: 0, refundsReturnedMinor: 0, netAfterFeesMinor: 1155,
      paymentCount: 1, refundCount: 1, paymentReversalCount: 0, refundReturnCount: 0,
      pendingNetMinor: -300, availableNetMinor: 1455,
    },
  ]);
  assert.equal(result.includedTransactions, 3);
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.truncated, false);
  assert.match(String(result.note), /not campaign or lead attribution/);
});

test("Stripe snapshots mark capped pagination without retaining individual transaction records", () => {
  const result = normalizeStripeBalanceTransactions([
    { type: "refund", currency: "jpy", amount: -250, fee: 0, net: -250, status: "available", id: "txn_private" },
    { type: "charge", currency: "US", amount: 100, fee: 0, net: 100, status: "available" },
    { type: "charge", currency: "usd", amount: null, fee: 0, net: 0, status: "available" },
    { type: "payment_failure_refund", currency: "usd", amount: -100, fee: 0, net: -100, status: "pending" },
    { type: "payment_reversal", currency: "usd", amount: -200, fee: 0, net: -200, status: "available" },
    { type: "refund_failure", currency: "usd", amount: 400, fee: 0, net: 400, status: "available" },
    { type: "payment_refund", currency: "usd", amount: 300, fee: 0, net: 300, status: "available" },
  ], true, 10);

  assert.deepEqual(result.currencies, [
    {
      currency: "JPY", grossPaymentsMinor: 0, refundsMinor: 250, feesMinor: 0,
      paymentReversalMinor: 0, refundsReturnedMinor: 0, netAfterFeesMinor: -250,
      paymentCount: 0, refundCount: 1, paymentReversalCount: 0, refundReturnCount: 0,
      pendingNetMinor: 0, availableNetMinor: -250,
    },
    {
      currency: "USD", grossPaymentsMinor: 0, refundsMinor: 0, feesMinor: 0,
      paymentReversalMinor: 300, refundsReturnedMinor: 700, netAfterFeesMinor: 400,
      paymentCount: 0, refundCount: 0, paymentReversalCount: 2, refundReturnCount: 2,
      pendingNetMinor: -100, availableNetMinor: 500,
    },
  ]);
  assert.equal(result.truncated, true);
  assert.match(String(result.truncationNote), /most recent 1,000.*incomplete/);
  assert.equal("transactions" in result, false);
});

test("Stripe refresh follows starting_after cursors and sends inclusive UTC date filters", async () => {
  const requests: Record<string, unknown>[] = [];
  let pageNumber = 0;
  const result = await loadStripeBalanceMetrics("2026-09-01", "2026-09-30", async (args) => {
    requests.push(args);
    pageNumber += 1;
    return {
      ok: true,
      message: "",
      data: {
        has_more: pageNumber === 1,
        data: [{ id: `txn_${pageNumber}`, type: "charge", currency: "usd", amount: 1000, fee: 30, net: 970, status: "available" }],
      },
    };
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].created, {
    gte: Math.floor(Date.parse("2026-09-01T00:00:00.000Z") / 1000),
    lte: Math.floor(Date.parse("2026-09-30T23:59:59.999Z") / 1000),
  });
  assert.equal(requests[0].limit, 100);
  assert.equal(requests[1].starting_after, "txn_1");
  assert.equal(result.includedTransactions, 2);
  assert.equal(result.truncated, false);
});

test("Stripe refresh caps pagination at 1,000 records and reports when more are available", async () => {
  let calls = 0;
  const result = await loadStripeBalanceMetrics("2026-09-01", "2026-09-30", async () => {
    calls += 1;
    return {
      ok: true,
      message: "",
      data: { has_more: true, data: [{ id: `txn_${calls}`, type: "charge", currency: "usd", amount: 100, fee: 3, net: 97 }] },
    };
  });

  assert.equal(calls, 10);
  assert.equal(result.pagesFetched, 10);
  assert.equal(result.truncated, true);
  assert.match(String(result.truncationNote), /most recent 1,000.*incomplete/);
});

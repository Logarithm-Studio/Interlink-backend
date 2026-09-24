import assert from "node:assert/strict";
import test from "node:test";
import { compareMarketingGoal, suggestMarketingExperiments } from "./campaign-goals.model";

test("campaign goals distinguish unavailable provider data from a measured zero", () => {
  assert.deepEqual(compareMarketingGoal("email_unique_clicks", 20, null, null), {
    metric: "email_unique_clicks", target: 20, currency: null, actual: null, attainmentPercent: null, state: "awaiting_data",
  });
  assert.deepEqual(compareMarketingGoal("email_unique_clicks", 20, null, 0), {
    metric: "email_unique_clicks", target: 20, currency: null, actual: 0, attainmentPercent: 0, state: "in_progress",
  });
});

test("campaign goal progress keeps closed-won value in its selected currency", () => {
  assert.deepEqual(compareMarketingGoal("closed_won_value", 12_500, "EUR", 15_000), {
    metric: "closed_won_value", target: 12_500, currency: "EUR", actual: 15_000, attainmentPercent: 120, state: "reached",
  });
  assert.throws(() => compareMarketingGoal("closed_won_value", 12_500, null, 15_000));
  assert.throws(() => compareMarketingGoal("attributed_leads", 12, "USD", 15));
});

test("learning suggestions cite observed counts and do not imply provider clicks are visits", () => {
  const suggestions = suggestMarketingExperiments({
    leads: 0, qualifiedLeads: 0, opportunities: 0, uniqueEmailClicks: 3, unsubscribes: 0,
    approvedContent: 1, plannedContent: 0, publishedContent: 0,
  });
  assert.equal(suggestions.length, 2);
  assert.match(suggestions[0].evidence, /3 unique clicks/);
  assert.match(suggestions[0].measure, /not the same as landing-page visits/);
  assert.match(suggestions[1].evidence, /1 content item is approved or planned/);
});

test("learning suggestions surface consent and qualification follow-up signals", () => {
  const unsubscribe = suggestMarketingExperiments({
    leads: 2, qualifiedLeads: 0, opportunities: 0, uniqueEmailClicks: null, unsubscribes: 1,
    approvedContent: 0, plannedContent: 0, publishedContent: 0,
  });
  assert.equal(unsubscribe[0].title, "Review audience fit before the next email");
  assert.match(unsubscribe[0].evidence, /1 unsubscribe/);
  assert.equal(unsubscribe[1].title, "Test the lead qualification handoff");
});

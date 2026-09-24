import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { activationCampaignMatches, MarketingActivationCreateBody, MarketingActivationPatchBody } from "./activation.model";

describe("marketing activation request validation", () => {
  it("accepts a campaign-linked creator activation with bounded costs and an HTTPS brief", () => {
    const result = MarketingActivationCreateBody.safeParse({
      campaignId: "8acb6efa-5376-46bf-a38f-07c87d35522e",
      type: "influencer",
      name: "Spring creator launch",
      owner: "Ari",
      deliverables: "One short video and two story frames",
      date: "2026-10-10",
      plannedCost: "1250.50",
      currency: "usd",
      url: "https://example.com/creator-brief",
    });
    assert.equal(result.success, true);
    if (result.success) assert.equal(result.data.currency, "usd");
  });

  it("rejects unsupported activation types, invalid dates, over-precision costs, and non-web links", () => {
    const base = { type: "event", name: "Launch night" };
    assert.equal(MarketingActivationCreateBody.safeParse({ ...base, type: "webinar" }).success, false);
    assert.equal(MarketingActivationCreateBody.safeParse({ ...base, date: "2026-02-29" }).success, false);
    assert.equal(MarketingActivationCreateBody.safeParse({ ...base, plannedCost: "12.345" }).success, false);
    assert.equal(MarketingActivationCreateBody.safeParse({ ...base, actualCost: "-2" }).success, false);
    assert.equal(MarketingActivationCreateBody.safeParse({ ...base, url: "javascript:alert(1)" }).success, false);
  });

  it("requires a patch and permits explicit clearing of nullable fields", () => {
    assert.equal(MarketingActivationPatchBody.safeParse({}).success, false);
    const result = MarketingActivationPatchBody.safeParse({ campaignId: null, actualCost: null, url: null, date: null });
    assert.equal(result.success, true);
  });

  it("does not allow a tracked activation link to claim a different campaign", () => {
    const linkedCampaign = "8acb6efa-5376-46bf-a38f-07c87d35522e";
    const otherCampaign = "c2feeb8f-3a7c-41f8-88c9-9b4911dbe743";
    assert.equal(activationCampaignMatches(undefined, linkedCampaign), true);
    assert.equal(activationCampaignMatches(linkedCampaign, linkedCampaign), true);
    assert.equal(activationCampaignMatches(otherCampaign, linkedCampaign), false);
    assert.equal(activationCampaignMatches(undefined, null), true);
  });
});

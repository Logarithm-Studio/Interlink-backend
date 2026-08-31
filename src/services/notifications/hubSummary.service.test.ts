/**
 * Tests for the parts of the notification hub that encode a decision rather than a mechanism.
 *
 * These are the invariants that were argued over and are easy to "simplify" away later:
 * the summary must never invent a number, and the deterministic fallback must stay correct
 * when the model is unavailable.
 *
 * Run with `npm test` (the script runs a file list — add this one to it).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deterministicSummary } from "./hubSummary.service";
import type { HubItem } from "./hub.service";

function item(kind: string, weight = 2, over: Partial<HubItem> = {}): HubItem {
  return {
    id: `${kind}-${Math.random().toString(36).slice(2)}`,
    mode: "professional",
    source: "internal",
    kind,
    title: `${kind} title`,
    preview: null,
    actor: null,
    weight,
    state: "open",
    externalRef: {},
    occurredAt: new Date().toISOString(),
    textPurged: false,
    ...over,
  };
}

describe("deterministicSummary", () => {
  it("says nothing is waiting when the feed is empty", () => {
    assert.equal(deterministicSummary([]), "Nothing needs you right now.");
  });

  it("counts each kind exactly — the bug that shipped was an invented number", () => {
    // The model, asked to tally this list itself, reported "five compliance reviews" against
    // four actual items. The deterministic path must never do that.
    const items = [
      ...Array.from({ length: 4 }, () => item("compliance_due", 3)),
      ...Array.from({ length: 3 }, () => item("invoice_overdue", 4)),
      item("lease_expiring", 3),
    ];

    const summary = deterministicSummary(items);

    assert.match(summary, /4 compliance items/);
    assert.match(summary, /3 overdue invoices/);
    assert.match(summary, /^8 things need you/);
  });

  it("uses singular labels for a single item", () => {
    const summary = deterministicSummary([item("invoice_overdue", 4)]);
    assert.match(summary, /^1 thing needs you/);
    assert.match(summary, /1 overdue invoice(?!s)/);
  });

  it("lists the largest groups first and caps the sentence at three", () => {
    const items = [
      ...Array.from({ length: 5 }, () => item("lead_followup", 2)),
      ...Array.from({ length: 3 }, () => item("invoice_overdue", 4)),
      ...Array.from({ length: 2 }, () => item("compliance_due", 3)),
      item("lease_expiring", 3),
    ];

    const summary = deterministicSummary(items);
    const leads = summary.indexOf("5 leads");
    const invoices = summary.indexOf("3 overdue invoices");

    assert.ok(leads >= 0 && invoices >= 0, "expected both groups named");
    assert.ok(leads < invoices, "larger group should be named first");
    // Four kinds present, at most three named — the sentence stays readable.
    assert.ok(!summary.includes("lease ending"), "fourth group should be trimmed");
  });

  it("falls back to a readable label for an unknown kind", () => {
    const summary = deterministicSummary([item("some_new_kind", 1)]);
    assert.match(summary, /some new kind/);
  });

  it("never reports a total that disagrees with the item count", () => {
    for (const n of [1, 2, 7, 15]) {
      const items = Array.from({ length: n }, () => item("gmail_thread", 2));
      const summary = deterministicSummary(items);
      assert.match(
        summary,
        new RegExp(`^${n} thing`),
        `total should be ${n} for ${n} items`,
      );
    }
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  findMarketingFollowupTodoistTask,
  marketingFollowupTodoistMarker,
  resolveMarketingTodoistTasks,
  todoistMarketingCompletionWindow,
  listMarketingLeads,
} from "./leads.service";
import { getPool, query } from "../../../config/db";
import type { TodoistTask } from "../../todoist/todoist.service";

function task(id: string, description: string): TodoistTask {
  return {
    id, content: "Follow up", description, projectId: "project-1", priority: 2,
    due: null, isCompleted: false, createdAt: "2026-09-01T00:00:00.000Z", labels: [],
  };
}

// Explicitly opt in with a disposable inbound QA contact in a migrated database.
// A real PostgreSQL query catches missing LATERAL projection columns that mocked
// rows cannot catch. No records are written or returned in the test output.
test("marketing lead list reads latest attribution source and scores inbound leads", {
  skip: !process.env.MARKETING_LEADS_TEST_CONTACT_ID,
}, async () => {
  const pool = getPool();
  pool.options.max = 1;
  try {
    await query("BEGIN READ ONLY");
    const owner = await query<{ user_id: string }>(
      "SELECT user_id FROM sales_contacts WHERE id=$1 AND source='inbound'",
      [process.env.MARKETING_LEADS_TEST_CONTACT_ID],
    );
    assert.ok(owner.rows[0], "Provide an existing inbound QA contact");
    const leads = await listMarketingLeads(owner.rows[0].user_id);
    const lead = leads.find((item) => item.id === process.env.MARKETING_LEADS_TEST_CONTACT_ID);
    assert.ok(lead, "Inbound contact must appear in the marketing lead list");
    assert.ok(lead.scoreReasons.includes("Submitted an inbound form"));
    assert.ok(lead.score >= 25 && lead.score <= 100);
  } finally {
    await query("ROLLBACK");
    await pool.end();
  }
});

test("marketing Todoist marker matches a whole description line", () => {
  const marker = marketingFollowupTodoistMarker("followup-123");
  assert.equal(findMarketingFollowupTodoistTask([task("other", `prefix ${marker} suffix`)], marker), undefined);
  assert.equal(findMarketingFollowupTodoistTask([task("match", `Contact: Ada\n\n${marker}\n`)], marker)?.id, "match");
});

test("Todoist completion lookup stays inside the provider's recent history window", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");
  const { since, until } = todoistMarketingCompletionWindow(now);
  assert.equal(until.toISOString(), now.toISOString());
  assert.equal(until.getTime() - since.getTime(), 89 * 86_400_000);
});

test("scheduled Todoist reconciliation completes only mapped tasks in provider completion history", () => {
  const resolutions = resolveMarketingTodoistTasks([
    { followupId: "f-active", taskId: "t-active" },
    { followupId: "f-done", taskId: "t-done" },
    { followupId: "f-missing", taskId: "t-deleted-or-old" },
  ], [task("t-active", "")], [task("t-done", ""), task("t-active", "")]);

  assert.deepEqual(resolutions, [
    { followupId: "f-active", taskId: "t-active", state: "active" },
    { followupId: "f-done", taskId: "t-done", state: "completed" },
    { followupId: "f-missing", taskId: "t-deleted-or-old", state: "missing" },
  ]);
});

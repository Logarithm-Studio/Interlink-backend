import test from "node:test";
import assert from "node:assert/strict";
import {
  findMarketingFollowupTodoistTask,
  marketingFollowupTodoistMarker,
  resolveMarketingTodoistTasks,
  todoistMarketingCompletionWindow,
} from "./leads.service";
import type { TodoistTask } from "../../todoist/todoist.service";

function task(id: string, description: string): TodoistTask {
  return {
    id, content: "Follow up", description, projectId: "project-1", priority: 2,
    due: null, isCompleted: false, createdAt: "2026-09-01T00:00:00.000Z", labels: [],
  };
}

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

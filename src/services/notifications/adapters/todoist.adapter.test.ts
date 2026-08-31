/**
 * The Todoist adapter's inclusion rule.
 *
 * The live token for the one connected Todoist account is encrypted under a keyring key that
 * only production holds, so the adapter cannot be exercised end to end from a dev machine.
 * The part worth protecting is the rule itself — what counts as "waiting on you" — so it is a
 * pure function and tested directly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { selectActionableTasks } from "./todoist.adapter";
import type { TodoistTask } from "../../todoist/todoist.service";

const TODAY = "2026-08-31";

function task(over: Partial<TodoistTask> & { id: string }): TodoistTask {
  return {
    content: `task ${over.id}`,
    description: "",
    projectId: "p1",
    priority: 1,
    due: null,
    isCompleted: false,
    createdAt: "2026-08-01T00:00:00Z",
    labels: [],
    ...over,
  };
}

const due = (date: string) => ({ date, string: date });

test("an undated task is backlog, not a notification", () => {
  const out = selectActionableTasks([task({ id: "a", due: null })], TODAY);
  assert.equal(out.length, 0);
});

test("a task due in the future is not yet waiting on the user", () => {
  const out = selectActionableTasks(
    [task({ id: "a", due: due("2026-09-05") })],
    TODAY,
  );
  assert.equal(out.length, 0);
});

test("a task due today is included", () => {
  const out = selectActionableTasks([task({ id: "a", due: due(TODAY) })], TODAY);
  assert.deepEqual(out.map((t) => t.id), ["a"]);
});

test("an overdue task is included", () => {
  const out = selectActionableTasks(
    [task({ id: "a", due: due("2026-08-20") })],
    TODAY,
  );
  assert.deepEqual(out.map((t) => t.id), ["a"]);
});

test("a completed task is never included, even when overdue", () => {
  const out = selectActionableTasks(
    [task({ id: "a", due: due("2026-08-20"), isCompleted: true })],
    TODAY,
  );
  assert.equal(out.length, 0);
});

test("the most overdue task sorts first", () => {
  const out = selectActionableTasks(
    [
      task({ id: "today", due: due(TODAY) }),
      task({ id: "oldest", due: due("2026-07-01") }),
      task({ id: "middle", due: due("2026-08-15") }),
    ],
    TODAY,
  );
  assert.deepEqual(out.map((t) => t.id), ["oldest", "middle", "today"]);
});

test("a datetime due value is compared by its date part, not lexically past it", () => {
  // Todoist returns `2026-08-31T09:00:00` for timed tasks. Comparing the raw string against
  // "2026-08-31" would make a task due at 09:00 today look FUTURE and silently drop it.
  const out = selectActionableTasks(
    [task({ id: "timed", due: due("2026-08-31T09:00:00") })],
    TODAY,
  );
  assert.deepEqual(out.map((t) => t.id), ["timed"]);
});

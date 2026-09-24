import assert from "node:assert/strict";
import test from "node:test";
import { resolveMarketingTodoistProjectId } from "./todoist-project.model";

test("campaign Todoist project overrides the account default for its follow-ups", () => {
  assert.equal(resolveMarketingTodoistProjectId("campaign-project", "account-default"), "campaign-project");
});

test("campaign without a project uses the account default or Todoist Inbox", () => {
  assert.equal(resolveMarketingTodoistProjectId(null, "account-default"), "account-default");
  assert.equal(resolveMarketingTodoistProjectId(null, null), null);
});

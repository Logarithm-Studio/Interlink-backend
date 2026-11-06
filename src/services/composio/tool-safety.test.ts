import assert from "node:assert/strict";
import test from "node:test";
import { isComposioReadOnlyTool } from "./composio.service";

test("connector exports and composite mutation actions always require review", () => {
  for (const tool of ["HUBSPOT_GET_OR_CREATE_CONTACT", "CRM_FIND_OR_CREATE_CONTACT", "GMAIL_SEARCH_AND_SEND_MESSAGE", "NOTION_EXPORT_PAGE", "TODOIST_LIST_AND_DELETE_TASKS", "STRIPE_CREATE_REFUND"]) {
    assert.equal(isComposioReadOnlyTool(tool), false, tool);
  }
  for (const tool of ["GMAIL_GET_MESSAGE", "HUBSPOT_SEARCH_CONTACTS", "NOTION_LIST_PAGES", "GITHUB_GET_PULL_REQUEST", "CRM_LIST_DELETED_RECORDS"]) {
    assert.equal(isComposioReadOnlyTool(tool), true, tool);
  }
  assert.equal(isComposioReadOnlyTool("UNKNOWN_OPERATION"), false);
});

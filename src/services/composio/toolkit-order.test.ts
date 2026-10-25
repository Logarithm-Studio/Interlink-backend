import assert from "node:assert/strict";
import test from "node:test";
import { orderConnectedToolkits } from "./toolkit-order";

test("CRM and signature requests remain reachable when many marketing apps are connected", () => {
  const connected = ["mailchimp", "facebook", "instagram", "linkedin", "youtube", "canva", "googleads", "kit", "stripe", "google_analytics", "hubspot", "salesforce", "docusign"];
  assert.equal(orderConnectedToolkits(connected, connected, "Research my Salesforce leads")[0], "salesforce");
  assert.equal(orderConnectedToolkits(connected, connected, "Prepare a DocuSign envelope")[0], "docusign");
  assert.deepEqual(orderConnectedToolkits(connected, connected, "Use HubSpot and Salesforce").slice(0, 2), ["hubspot", "salesforce"]);
});

test("tool selection never introduces disconnected apps and preserves default order", () => {
  assert.deepEqual(orderConnectedToolkits(["facebook", "hubspot", "hubspot"], ["hubspot"], "Use Salesforce"), ["hubspot", "facebook"]);
  assert.deepEqual(orderConnectedToolkits(["facebook", "kit"], ["facebook"], "Toolkit examples"), ["facebook", "kit"]);
  assert.equal(orderConnectedToolkits(["facebook", "google_analytics"], ["facebook"], "Check Google Analytics")[0], "google_analytics");
});

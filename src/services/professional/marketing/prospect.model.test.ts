import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProspects } from "./prospect.model";

test("CRM prospect normalization preserves source IDs and treats invalid email as missing", () => {
  assert.deepEqual(normalizeProspects("hubspot", { results: [{ id: "101", properties: { firstname: "Ada", lastname: "Lovelace", email: "ada@example.com", company: "Analytical", jobtitle: "Director" } }] }),
    [{ provider: "hubspot", externalId: "101", name: "Ada Lovelace", email: "ada@example.com", company: "Analytical", title: "Director" }]);
  assert.equal(normalizeProspects("salesforce", { data: { records: [{ Id: "00Q1", Name: "Grace", Email: "invalid" }] } })[0].email, null);
  assert.deepEqual(normalizeProspects("salesforce", { records: [{ Name: "No source ID" }] }), []);
});

test("CRM response shape failures are distinct from empty results and large responses are bounded", () => {
  assert.throws(() => normalizeProspects("hubspot", { message: "Bad gateway" }), /unrecognized/);
  assert.deepEqual(normalizeProspects("hubspot", { results: [] }), []);
  assert.equal(normalizeProspects("salesforce", { records: Array.from({ length: 40 }, (_, i) => ({ Id: `${i}`, Name: "Prospect" })) }).length, 25);
});

import assert from "node:assert/strict";
import test from "node:test";
import { normalizeClientIp } from "./client-ip";

test("keeps IPv4 clients distinct", () => {
  assert.equal(normalizeClientIp("203.0.113.4"), "203.0.113.4");
  assert.notEqual(normalizeClientIp("203.0.113.4"), normalizeClientIp("203.0.113.5"));
});

test("groups IPv6 address rotation within the same /64", () => {
  assert.equal(normalizeClientIp("2001:db8:1:2::1"), "2001:db8:1:2::/64");
  assert.equal(normalizeClientIp("2001:db8:1:2:abcd:ef01:2345:6789"), "2001:db8:1:2::/64");
});

test("normalizes compressed and IPv4-mapped socket addresses", () => {
  assert.equal(normalizeClientIp("::1"), "0:0:0:0::/64");
  assert.equal(normalizeClientIp("::ffff:192.0.2.8"), "192.0.2.8");
  assert.equal(normalizeClientIp("0:0:0:0:0:ffff:c000:0208"), "192.0.2.8");
});

test("rejects untrusted or malformed address strings", () => {
  assert.equal(normalizeClientIp("spoofed-ip"), null);
  assert.equal(normalizeClientIp(undefined), null);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMarketingPostOwnedByTarget,
  normalizeMarketingPostCheck,
} from "./post-monitoring.model";

test("Facebook read-back normalizes provider counts and lifetime views", () => {
  const result = normalizeMarketingPostCheck("facebook", {
    data: {
      is_published: true,
      created_time: "2026-09-22T10:00:00Z",
      permalink_url: "https://www.facebook.com/123456789/posts/987654321",
      likes: { summary: { total_count: 17 } },
      comments: { summary: { total_count: 3 } },
      shares: { count: 2 },
    },
  }, {
    response_data: { data: [
      { name: "post_media_view", values: [{ value: 101 }] },
      { name: "post_total_media_view_unique", values: [{ value: 82 }] },
    ] },
  });
  assert.equal(result.providerState, "live");
  assert.equal(result.providerUrl, "https://www.facebook.com/123456789/posts/987654321");
  assert.equal(result.providerPublishedAt?.toISOString(), "2026-09-22T10:00:00.000Z");
  assert.deepEqual(result.metrics, { likes: 17, comments: 3, shares: 2, views: 101, reach: 82 });
});

test("Facebook false publication state is kept distinct from a missing metric", () => {
  const result = normalizeMarketingPostCheck("facebook", {
    is_published: false,
    likes: { data: [] },
    shares: null,
  });
  assert.equal(result.providerState, "not_published");
  assert.deepEqual(result.metrics, {});
});

test("Instagram read-back preserves supported count fields and rejects bad URLs", () => {
  const result = normalizeMarketingPostCheck("instagram", {
    data: {
      media_type: "REELS",
      permalink: "http://instagram.com/p/abc/",
      timestamp: "2026-09-20T10:00:00+0000",
      like_count: "44",
      comments_count: 5,
      view_count: 903,
      shares_count: 7,
      saved_count: 8,
      reposts_count: -1,
    },
  });
  assert.equal(result.providerUrl, null);
  assert.deepEqual(result.metrics, { likes: 44, comments: 5, shares: 7, views: 903, saves: 8 });
});

test("LinkedIn read-back reports availability without inventing member-post metrics", () => {
  const result = normalizeMarketingPostCheck("linkedin", {
    data: {
      permalink: "https://www.linkedin.com/feed/update/urn:li:share:123/",
      createdAt: "2026-09-19T12:00:00Z",
      author: "urn:li:person:123",
    },
  });
  assert.equal(result.providerState, "live");
  assert.equal(result.providerUrl, "https://www.linkedin.com/feed/update/urn:li:share:123/");
  assert.deepEqual(result.metrics, {});
});

test("provider ownership checks reject a post from another Facebook Page or Instagram account", () => {
  assert.equal(assertMarketingPostOwnedByTarget("facebook", "123456789", "987654321_456", {}), false);
  assert.equal(assertMarketingPostOwnedByTarget("facebook", "123456789", "123456789_456", {}), true);
  assert.equal(assertMarketingPostOwnedByTarget("instagram", "555555", "17858625294504375", { owner: { id: "444444" } }), false);
  assert.equal(assertMarketingPostOwnedByTarget("instagram", "555555", "17858625294504375", { owner: { id: "555555" } }), true);
  assert.equal(assertMarketingPostOwnedByTarget("instagram", "555555", "17858625294504375", { owner: { id: 555555 } }), true);
});

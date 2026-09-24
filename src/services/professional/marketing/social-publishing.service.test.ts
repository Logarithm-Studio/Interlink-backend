import assert from "node:assert/strict";
import test from "node:test";
import {
  facebookPublishRequest, instagramMediaContainerId, instagramMediaRequest, linkedinAuthorUrn,
  marketingProviderPostId, normalizeFacebookPublishTargets,
} from "./social-publishing.service";

test("Facebook target discovery keeps named numeric Pages from wrapped Composio responses", () => {
  const targets = normalizeFacebookPublishTargets({ successful: true, data: { data: [
    { id: "1234567890123", name: "Interlink Studio" },
    { id: "not-a-page", name: "Invalid result" },
    { id: "2345678901234", page_name: "Campaign Page" },
  ] } });
  assert.deepEqual(targets, [
    { id: "1234567890123", name: "Interlink Studio", kind: "page" },
    { id: "2345678901234", name: "Campaign Page", kind: "page" },
  ]);
});

test("LinkedIn member IDs normalize to author URNs without changing existing URNs", () => {
  assert.equal(linkedinAuthorUrn({ data: { id: "A1B2C3" } }), "urn:li:person:A1B2C3");
  assert.equal(linkedinAuthorUrn({ data: { id: "urn:li:person:A1B2C3" } }), "urn:li:person:A1B2C3");
  assert.equal(linkedinAuthorUrn({ data: {} }), null);
});

test("social post ID extraction accepts Facebook, Instagram, and LinkedIn response wrappers", () => {
  assert.equal(marketingProviderPostId({ data: { data: { id: "page_post" } } }), "page_post");
  assert.equal(marketingProviderPostId({ data: { id: "photo_asset", post_id: "page_post" } }), "page_post");
  assert.equal(marketingProviderPostId({ data: { id: "photo_asset" } }, "FACEBOOK_CREATE_PHOTO_POST"), null);
  assert.equal(marketingProviderPostId({ data: { id: "photo_asset", post_id: "page_post" } }, "FACEBOOK_CREATE_PHOTO_POST"), "page_post");
  assert.equal(marketingProviderPostId({ response_data: { x_restli_id: "urn:li:share:123" } }), "urn:li:share:123");
  assert.equal(marketingProviderPostId({ data: { media_id: "987654" } }), "987654");
  assert.equal(marketingProviderPostId({ successful: true, data: {} }), null);
});

test("Instagram container parsing prefers explicit creation IDs over generic response IDs", () => {
  assert.equal(instagramMediaContainerId({ data: { id: "container-123" } }), "container-123");
  assert.equal(instagramMediaContainerId({ data: { id: "other", creation_id: "container-456" } }), "container-456");
  assert.equal(instagramMediaContainerId({ data: {} }), null);
});

test("Facebook publishing chooses the matching text, link, photo, or video action contract", () => {
  assert.deepEqual(facebookPublishRequest({ title: "Launch", body: "Hello", assetUrl: null }, "page-1"), {
    tool: "FACEBOOK_CREATE_POST", args: { page_id: "page-1", message: "Hello", published: true },
  });
  assert.deepEqual(facebookPublishRequest({ title: "Launch", body: "Hello", assetUrl: "https://example.com/offer" }, "page-1"), {
    tool: "FACEBOOK_CREATE_POST", args: { page_id: "page-1", message: "Hello", published: true, link: "https://example.com/offer" },
  });
  assert.equal(facebookPublishRequest({ title: "Launch", body: "Hello", assetUrl: "https://cdn.example.com/launch.jpg" }, "page-1").tool, "FACEBOOK_CREATE_PHOTO_POST");
  assert.equal(facebookPublishRequest({ title: "Launch", body: "Hello", assetUrl: "https://cdn.example.com/launch.mp4" }, "page-1").tool, "FACEBOOK_CREATE_VIDEO_POST");
});

test("Instagram image containers omit video-only fields and Reels use MP4", () => {
  assert.deepEqual(instagramMediaRequest({ body: "Hello", assetUrl: "https://cdn.example.com/post.jpg" }, "ig-1"), {
    ig_user_id: "ig-1", caption: "Hello", image_url: "https://cdn.example.com/post.jpg",
  });
  assert.deepEqual(instagramMediaRequest({ body: "Hello", assetUrl: "https://cdn.example.com/reel.mp4" }, "ig-1"), {
    ig_user_id: "ig-1", caption: "Hello", video_url: "https://cdn.example.com/reel.mp4", media_type: "REELS", share_to_feed: true,
  });
});

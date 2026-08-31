-- Listing page views — the Real Estate persona's own notification source.
--
-- WHY THIS EXISTS: Composio has no Zillow/AppFolio/Dotloop toolkit, so the Real Estate persona
-- cannot get third-party notifications the way Finance or PM can. But we already HOST the page a
-- buyer opens (`GET /l/:slug`) and currently learn nothing from it. Repeat-view intent is a
-- signal the portals monetise heavily; here it costs one insert on a route we already serve.
--
-- PRIVACY — this is deliberately COARSE. The listing page is public and its viewer has agreed to
-- nothing: no account, no terms, no cookie banner. So we record the slug, a day bucket, and a
-- count. No IP address, no user agent, no fingerprint, no identity. That is enough to tell an
-- agent "this listing is getting attention" — which is the actionable signal — without building
-- a tracking profile of members of the public.
--
-- Counting per (listing, day) rather than per view keeps the table small by construction: a
-- listing shared to a hundred buyers produces one row per day, not a hundred rows.

BEGIN;

CREATE TABLE IF NOT EXISTS re_listing_views (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  uuid        NOT NULL REFERENCES re_listings(id) ON DELETE CASCADE,
  view_date   date        NOT NULL DEFAULT CURRENT_DATE,
  view_count  integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, view_date)
);

CREATE INDEX IF NOT EXISTS idx_re_listing_views_listing
  ON re_listing_views (listing_id, view_date DESC);

COMMIT;

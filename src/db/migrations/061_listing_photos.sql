-- Listing photos + public share links.
--
-- Agents need to put a property in front of buyers. Publishing to Zillow/an MLS requires
-- broker credentials we don't have, so instead a listing gets its own photos (Supabase
-- Storage, free tier) and a public, unguessable share page the agent can email to matched
-- buyers using the existing Gmail workflow.
--
-- `photos` is a JSON array of public URLs (ordered; first is the cover).
-- `share_slug` is a random token — the share page is public, so the id must not be guessable
-- and must not leak the owner's user_id.

ALTER TABLE re_listings
  ADD COLUMN IF NOT EXISTS photos jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS share_slug text;

-- One slug per listing; NULLs are allowed (a listing is only published when asked).
CREATE UNIQUE INDEX IF NOT EXISTS re_listings_share_slug_key
  ON re_listings (share_slug)
  WHERE share_slug IS NOT NULL;

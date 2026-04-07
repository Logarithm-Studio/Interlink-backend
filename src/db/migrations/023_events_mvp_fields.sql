BEGIN;

-- Extend events to match backend MVP requirements for Flutter consumers.
-- New explicit columns reduce reliance on metadata JSON and make event reads
-- stable for list/detail APIs.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS timezone     TEXT,
  ADD COLUMN IF NOT EXISTS location     TEXT,
  ADD COLUMN IF NOT EXISTS status       TEXT NOT NULL DEFAULT 'confirmed',
  ADD COLUMN IF NOT EXISTS is_cancelled BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill explicit location from metadata where possible.
UPDATE events
   SET location = COALESCE(location, metadata->>'location')
 WHERE location IS NULL;

COMMIT;

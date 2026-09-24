-- Add user-selected, read-only Google Ads campaign performance snapshots.
BEGIN;

ALTER TABLE sales_marketing_analytics_snapshots
  DROP CONSTRAINT IF EXISTS sales_marketing_analytics_snapshots_provider_check;

ALTER TABLE sales_marketing_analytics_snapshots
  ADD CONSTRAINT sales_marketing_analytics_snapshots_provider_check
    CHECK (provider IN ('ga4', 'search_console', 'facebook_page', 'instagram_account', 'stripe_balance', 'google_ads_campaign'));

COMMIT;

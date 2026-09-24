-- Keep structured campaign targets separate from free-text success notes.
BEGIN;

ALTER TABLE sales_marketing_campaigns
  ADD COLUMN IF NOT EXISTS goal_metric text,
  ADD COLUMN IF NOT EXISTS goal_target bigint,
  ADD COLUMN IF NOT EXISTS goal_currency text;

ALTER TABLE sales_marketing_campaigns
  ADD CONSTRAINT sales_marketing_campaign_goal_config_check CHECK (
    (goal_metric IS NULL AND goal_target IS NULL AND goal_currency IS NULL)
    OR (
      goal_metric IS NOT NULL
      AND goal_target IS NOT NULL
      AND goal_metric IN (
        'attributed_leads', 'qualified_leads', 'sales_opportunities', 'closed_won_deals',
        'closed_won_value', 'published_content', 'activation_reach', 'activation_engagements',
        'activation_leads', 'activation_conversions', 'email_unique_opens', 'email_unique_clicks'
      )
      AND goal_target BETWEEN 1 AND 1000000000
      AND (
        (goal_metric = 'closed_won_value' AND goal_currency IS NOT NULL AND goal_currency ~ '^[A-Z]{3}$')
        OR (goal_metric <> 'closed_won_value' AND goal_currency IS NULL)
      )
    )
  );

COMMIT;

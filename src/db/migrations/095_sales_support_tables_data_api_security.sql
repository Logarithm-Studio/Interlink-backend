-- Sales support records are private backend data, like the other Sales tables.
-- The Express API uses its server-side PostgreSQL connection and checks user_id.
-- No row data is changed. Table owners and existing service-role grants remain.
ALTER TABLE public.sales_reps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_settings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.sales_reps, public.sales_settings
  FROM PUBLIC, anon, authenticated;

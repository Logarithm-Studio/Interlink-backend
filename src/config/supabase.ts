import { createClient, SupabaseClient } from '@supabase/supabase-js';

let supabase: SupabaseClient;

function getSupabaseServerKey(): string | undefined {
  // Keep backward compatibility with existing environments while preferring
  // the explicit service-role variable required by production docs.
  return process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_KEY;
}

/**
 * Get or create the Supabase client singleton.
 */
export function getSupabase(): SupabaseClient {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = getSupabaseServerKey();

    if (!url || !key) {
      throw new Error(
        'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set',
      );
    }

    supabase = createClient(url, key);
  }

  return supabase;
}

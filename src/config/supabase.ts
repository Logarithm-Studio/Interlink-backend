import { createClient, SupabaseClient } from '@supabase/supabase-js';

let supabase: SupabaseClient;

/**
 * Get or create the Supabase client singleton.
 */
export function getSupabase(): SupabaseClient {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;

    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_KEY must be set');
    }

    supabase = createClient(url, key);
  }

  return supabase;
}

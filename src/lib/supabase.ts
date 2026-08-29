import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { env } from './env';

/**
 * Server-side Supabase client.
 *
 * ⚠️  This uses the NEW-FORMAT **secret** key (`sb_secret_...`), which BYPASSES
 * Row Level Security entirely. Every row in every table is readable and writable
 * through it. It must never be shipped to the mobile app repo, never be exposed to
 * a client, and never appear in a log line. The app repo uses the *publishable*
 * key and relies on RLS; this backend is the only place the secret key exists.
 *
 * Because RLS is bypassed here, any endpoint built on this client is responsible
 * for its own tenancy check (facility_id scoping) — the database will not do it
 * for you.
 */
let cached: SupabaseClient | undefined;

export function supabase(): SupabaseClient {
  if (!cached) {
    const { SUPABASE_URL, SUPABASE_SECRET_KEY } = env();
    cached = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: {
        // No user session to persist or refresh: this is a trusted server process.
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return cached;
}

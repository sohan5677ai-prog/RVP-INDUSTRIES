import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cachedClient: SupabaseClient | undefined;

/**
 * Server-side Supabase client using the service_role key (full storage access,
 * bypasses RLS). Never expose this key or this client to the browser.
 */
export function getSupabase(): SupabaseClient {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to upload files.'
    );
  }
  cachedClient = createClient(url, key, {
    auth: { persistSession: false },
  });
  return cachedClient;
}

export function storageBucket(): string {
  return process.env.SUPABASE_STORAGE_BUCKET ?? 'invoices';
}

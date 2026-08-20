/* Public configuration. Safe to sit in a public repo: the anon key grants nothing by
   itself. What a signed-in user may read or write is decided by row level security in
   the database, not by keeping this string secret.

   Note this is the legacy JWT anon key, not the newer sb_publishable_ one. Both are
   valid for this project, but on 20 Aug 2026 the Data API rejected the new format and
   accepted this. Swap it when Supabase finishes that transition. */
export const SUPABASE_URL = 'https://xmbiqxdozrysvoqxdbns.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhtYmlxeGRvenJ5c3ZvcXhkYm5zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcyNTc1NTQsImV4cCI6MjEwMjgzMzU1NH0.OrJBNy0LZ1AOqJYiAKDgFUA-uEJuELdaVZX_QvqwKVI';

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Browser Supabase client. Reads publishable/anon key + URL from Vite env.
// For self-hosted Supabase, set:
//   VITE_SUPABASE_URL=https://supabase.yourdomain.com
//   VITE_SUPABASE_PUBLISHABLE_KEY=<your self-hosted ANON_KEY>
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

if (!url || !anon) {
  // Do not throw at module load — build/SSR must still succeed. Log for visibility.
  // eslint-disable-next-line no-console
  console.warn("[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY not set");
}

export const supabase: SupabaseClient = createClient(
  url ?? "http://localhost:54321",
  anon ?? "public-anon-key",
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: typeof window !== "undefined" ? window.localStorage : undefined,
    },
  },
);

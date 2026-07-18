import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Browser Supabase client. Reads publishable/anon key + URL from Vite env.
// Self-hosted Supabase. URL is public; anon key is public but injected via env.
const url = "https://supabase.accentrixmailer.online";
const anon = (import.meta.env.VITE_SELFHOST_SUPABASE_ANON_KEY as string | undefined) ?? "";

if (!anon) {
  // eslint-disable-next-line no-console
  console.warn("[supabase] VITE_SELFHOST_SUPABASE_ANON_KEY not set");
}

export const supabase: SupabaseClient = createClient(
  url,
  anon || "public-anon-key",
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: typeof window !== "undefined" ? window.localStorage : undefined,
    },
  },
);

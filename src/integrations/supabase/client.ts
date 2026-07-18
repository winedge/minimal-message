import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Browser Supabase client. Reads publishable/anon key + URL from Vite env.
// Self-hosted Supabase. URL + anon key are public and safe to commit.
const url = "https://supabase.accentrixmailer.online";
const anon =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlLXNlbGZob3N0IiwiaWF0IjoxNzg0Mzg2NDEwLCJleHAiOjIwOTk3NDY0MTB9.FSsgCUilZbcBSH4gynOKBlP_cNep5g_mosHMz1OdFuc";

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

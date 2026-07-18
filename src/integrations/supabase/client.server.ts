import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// SERVER-ONLY. Never import from client-reachable modules at top level.
const url = "https://supabase.accentrixmailer.online";
const serviceRole = process.env.SELFHOST_SUPABASE_SERVICE_ROLE_KEY;

if (!serviceRole) {
  // eslint-disable-next-line no-console
  console.warn("[supabase.server] SELFHOST_SUPABASE_SERVICE_ROLE_KEY not set");
}

export const supabaseAdmin: SupabaseClient = createClient(
  url,
  serviceRole ?? "service-role-key",
  { auth: { persistSession: false, autoRefreshToken: false } },
);

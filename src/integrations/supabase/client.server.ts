import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// SERVER-ONLY. Never import from client-reachable modules at top level.
// From a `.functions.ts` handler, load with:
//   const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
const url = process.env.SUPABASE_URL;
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRole) {
  // eslint-disable-next-line no-console
  console.warn("[supabase.server] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
}

export const supabaseAdmin: SupabaseClient = createClient(
  url ?? "http://localhost:54321",
  serviceRole ?? "service-role-key",
  { auth: { persistSession: false, autoRefreshToken: false } },
);

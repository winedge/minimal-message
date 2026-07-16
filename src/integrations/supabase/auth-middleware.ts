import { createMiddleware } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";

// Server-fn middleware that validates the request's bearer token against
// self-hosted Supabase (GoTrue) and provides an authenticated `supabase`
// client + `userId` on `context`.
export const requireSupabaseAuth = createMiddleware({ type: "function" }).server(
  async ({ next, request }) => {
    const authHeader = request.headers.get("authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) throw new Response("Unauthorized", { status: 401 });

    const url = process.env.SUPABASE_URL;
    const anon = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!url || !anon) throw new Response("Server misconfigured", { status: 500 });

    const supabase = createClient(url, anon, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) throw new Response("Unauthorized", { status: 401 });

    return next({ context: { supabase, userId: data.user.id, user: data.user } });
  },
);

import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";

// Server-fn middleware: validates the request's Supabase bearer against
// self-hosted GoTrue and exposes `supabase` + `userId` on `context`.
export const requireSupabaseAuth = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const request = getRequest();
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

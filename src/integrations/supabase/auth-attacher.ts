import { createMiddleware } from "@tanstack/react-start";
import { supabase } from "./client";

// Attach the current Supabase bearer token to every server-fn RPC call.
// Registered in src/start.ts as a functionMiddleware.
export const attachSupabaseAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    let token: string | undefined;
    try {
      const { data } = await supabase.auth.getSession();
      token = data.session?.access_token;
    } catch {
      // ignore — SSR path
    }
    if (!token) return next();
    return next({ headers: { Authorization: `Bearer ${token}` } });
  },
);

import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// Called from Asterisk dialplan (via CURL) when a Telnyx inbound call arrives.
// Body: {"did":"+15551234567"}   Header: x-signature = hex(HMAC-SHA256(body, ASTERISK_WEBHOOK_SECRET))
// Response: {"extension":"1001","ringSeconds":20}
//   extension === "" means no agent available (dialplan should send to voicemail / hangup).
export const Route = createFileRoute("/api/public/inbound-route")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.ASTERISK_WEBHOOK_SECRET;
        if (!secret) return new Response("Server misconfigured", { status: 500 });
        const body = await request.text();
        const sig = request.headers.get("x-signature") ?? "";
        const expected = createHmac("sha256", secret).update(body).digest("hex");
        const a = Buffer.from(sig);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          return new Response("bad signature", { status: 401 });
        }

        let payload: { did: string };
        try {
          payload = z.object({ did: z.string().min(3).max(32) }).parse(JSON.parse(body));
        } catch (e: any) {
          return new Response(`bad payload: ${e.message}`, { status: 400 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: route } = await supabaseAdmin
          .from("inbound_routes")
          .select("*")
          .eq("did", payload.did)
          .maybeSingle();
        if (!route) {
          return Response.json({ extension: "", ringSeconds: 20 });
        }

        const resolve = async (userId: string | null) => {
          if (!userId) return "";
          const { data: sip } = await supabaseAdmin
            .from("sip_endpoints")
            .select("extension")
            .eq("user_id", userId)
            .maybeSingle();
          return (sip?.extension as string | undefined) ?? "";
        };

        let extension = "";
        if (route.strategy === "direct") {
          extension = await resolve(route.target_user_id);
        } else {
          // Round-robin among ring_group, preferring 'available' agents.
          const group = (route.ring_group as string[] | null) ?? [];
          if (group.length > 0) {
            const { data: statuses } = await supabaseAdmin
              .from("agent_status")
              .select("user_id, state")
              .in("user_id", group);
            const available = group.filter((uid) =>
              statuses?.find((s: any) => s.user_id === uid && s.state === "available"),
            );
            const pool = available.length ? available : group;

            const { data: state } = await supabaseAdmin
              .from("inbound_state")
              .select("last_agent_index")
              .eq("did", payload.did)
              .maybeSingle();
            const next = ((state?.last_agent_index ?? -1) + 1) % pool.length;
            const chosen = pool[next];
            await supabaseAdmin
              .from("inbound_state")
              .upsert({ did: payload.did, last_agent_index: next, updated_at: new Date().toISOString() });
            extension = await resolve(chosen);
          }
        }

        if (!extension && route.fallback_extension) extension = route.fallback_extension as string;
        return Response.json({ extension, ringSeconds: route.ring_seconds ?? 20 });
      },
    },
  },
});

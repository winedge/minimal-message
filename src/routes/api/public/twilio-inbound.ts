// Inbound TwiML endpoint — point your Twilio number's Voice webhook here.
// Priority for routing:
//   1) If this caller was dialed by an agent recently (callback), ring
//      that same agent so the customer reaches the person they spoke to.
//   2) Otherwise fall back to the DID → agent mapping in `inbound_routes`.
import { createFileRoute } from "@tanstack/react-router";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// How far back to consider an outbound as "recent" for callback routing.
const CALLBACK_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24 hours

function last10(n: string) {
  const digits = n.replace(/\D/g, "");
  return digits.slice(-10);
}

export const Route = createFileRoute("/api/public/twilio-inbound")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const form = await request.formData();
        const to = String(form.get("To") ?? "");
        const from = String(form.get("From") ?? "");

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        let agentExt: string | null = null;
        let agentUserId: string | null = null;
        let matchedByCallback = false;

        // 1) Callback routing — find the most recent outbound call to this From.
        try {
          const fromTail = last10(from);
          if (fromTail.length >= 7) {
            const since = new Date(Date.now() - CALLBACK_LOOKBACK_MS).toISOString();
            const { data: recent } = await supabaseAdmin
              .from("calls")
              .select("agent_id, customer_phone, created_at")
              .eq("direction", "outbound")
              .gte("created_at", since)
              .ilike("customer_phone", `%${fromTail}%`)
              .order("created_at", { ascending: false })
              .limit(1);
            const hit = recent?.[0];
            if (hit?.agent_id) {
              const { data: sip } = await supabaseAdmin
                .from("sip_endpoints")
                .select("extension")
                .eq("user_id", hit.agent_id)
                .maybeSingle();
              if (sip?.extension) {
                agentExt = String(sip.extension);
                agentUserId = hit.agent_id;
                matchedByCallback = true;
              }
            }
          }
        } catch (e) {
          console.error("[twilio-inbound] callback lookup failed", e);
        }

        // 2) Fallback: DID → agent mapping from `inbound_routes`.
        let ringUserIds: string[] = [];
        let ringSeconds = 25;
        let fallbackExtension: string | null = null;

        if (!agentExt) {
          try {
            const { data: routes, error } = await supabaseAdmin
              .from("inbound_routes")
              .select("did, strategy, target_user_id, ring_group, ring_seconds, fallback_extension");
            if (error) throw error;
            const toTail = last10(to);
            const route =
              (routes ?? []).find((r: any) => r.did === to) ??
              (routes ?? []).find((r: any) => toTail && last10(String(r.did ?? "")) === toTail);
            if (route) {
              ringSeconds = Number(route.ring_seconds) || 25;
              fallbackExtension = route.fallback_extension ?? null;
              const group = Array.isArray(route.ring_group) ? route.ring_group : [];
              ringUserIds =
                route.strategy === "roundrobin" && group.length
                  ? group.map(String)
                  : route.target_user_id
                    ? [String(route.target_user_id)]
                    : group.map(String);
            }
          } catch (e) {
            console.error("[twilio-inbound] route lookup failed", e);
          }
        }

        // Resolve extensions for the target agent(s).
        let extensions: string[] = [];
        if (agentExt) {
          extensions = [agentExt];
        } else if (ringUserIds.length) {
          const { data: sips } = await supabaseAdmin
            .from("sip_endpoints")
            .select("user_id, extension")
            .in("user_id", ringUserIds);
          extensions = (sips ?? []).map((s: any) => String(s.extension));
          agentUserId = (sips ?? [])[0]?.user_id ?? null;
        }
        if (!extensions.length && fallbackExtension) extensions = [String(fallbackExtension)];

        if (!extensions.length) {
          console.error("[twilio-inbound] no route for DID", to);
          const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>No agent is available right now. Please call back later.</Say></Response>`;
          return new Response(twiml, { headers: { "Content-Type": "text/xml" } });
        }

        // Best-effort inbound call row for history / live monitoring.
        try {
          if (agentUserId) {
            await supabaseAdmin.from("calls").insert({
              agent_id: agentUserId,
              customer_phone: from,
              direction: "inbound",
              status: "ringing",
              disposition: matchedByCallback ? "CALLBACK" : null,
            });
          }
        } catch (e) {
          console.error("[twilio-inbound] insert call row failed", e);
        }

        const clients = extensions
          .map((ext) => `    <Client>${esc(`ext_${ext}`)}</Client>`)
          .join("\n");
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="${ringSeconds}" answerOnBridge="true" callerId="${esc(from)}">
${clients}
  </Dial>
</Response>`;
        return new Response(twiml, { headers: { "Content-Type": "text/xml" } });

      },
    },
  },
});

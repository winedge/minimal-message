// Inbound TwiML endpoint — point your Twilio number's Voice webhook here.
// We look up the destination agent from `inbound_routes` (DID → extension)
// and dial their browser Client (Twilio Voice SDK identity = "ext_<ext>").
import { createFileRoute } from "@tanstack/react-router";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const Route = createFileRoute("/api/public/twilio-inbound")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const form = await request.formData();
        const to = String(form.get("To") ?? "");
        const from = String(form.get("From") ?? "");

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: route } = await supabaseAdmin
          .from("inbound_routes")
          .select("agent_ext")
          .eq("did", to)
          .maybeSingle();

        if (!route?.agent_ext) {
          const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>No agent is available right now. Please call back later.</Say></Response>`;
          return new Response(twiml, { headers: { "Content-Type": "text/xml" } });
        }

        // Best-effort inbound call row.
        try {
          const { data: sip } = await supabaseAdmin
            .from("sip_endpoints")
            .select("user_id")
            .eq("extension", route.agent_ext)
            .maybeSingle();
          if (sip) {
            await supabaseAdmin.from("calls").insert({
              agent_id: sip.user_id,
              customer_phone: from,
              direction: "inbound",
              status: "ringing",
            });
          }
        } catch (e) {
          console.error("[twilio-inbound] insert call row failed", e);
        }

        const identity = `ext_${route.agent_ext}`;
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="25" answerOnBridge="true">
    <Client>${esc(identity)}</Client>
  </Dial>
</Response>`;
        return new Response(twiml, { headers: { "Content-Type": "text/xml" } });
      },
    },
  },
});

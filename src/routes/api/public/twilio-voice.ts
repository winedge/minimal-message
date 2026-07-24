// TwiML endpoint invoked by Twilio when an agent's browser Device.connect()
// fires. Bridges the agent's WebRTC leg to the customer via a PSTN Dial.
import { createFileRoute } from "@tanstack/react-router";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const Route = createFileRoute("/api/public/twilio-voice")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const form = await request.formData();
        const to = String(form.get("To") ?? "").trim();
        const from = String(form.get("From") ?? "").trim();
        const callId = String(form.get("CallId") ?? "").trim();
        const parentSid = String(form.get("CallSid") ?? "").trim();

        const base = (process.env.PUBLIC_WEBHOOK_BASE_URL ?? "").replace(/\/$/, "");
        const statusUrl = `${base}/api/public/twilio-status${callId ? `?callId=${encodeURIComponent(callId)}` : ""}`;

        if (!to || !from) {
          const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Missing destination number.</Say></Response>`;
          return new Response(twiml, { status: 200, headers: { "Content-Type": "text/xml" } });
        }

        // Link Twilio's parent CallSid onto our row so status callbacks correlate.
        try {
          if (parentSid && callId) {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            await supabaseAdmin
              .from("calls")
              .update({ asterisk_channel_id: parentSid })
              .eq("id", callId);
          }
        } catch (e) {
          console.error("[twilio-voice] failed to link CallSid", e);
        }

        // NOTE: no `action` attr — a non-TwiML response there ends the parent
        // leg. Status is tracked via <Number statusCallback> only.
        // NOTE: no `answerOnBridge` — with a Twilio Voice JS SDK (WebRTC)
        // parent leg it has been observed to cut the parent Call the moment
        // the callee answers, so the customer picks up and immediately drops.
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${esc(from)}" timeout="30">
    <Number statusCallback="${esc(statusUrl)}" statusCallbackEvent="initiated ringing answered completed" statusCallbackMethod="POST">${esc(to)}</Number>
  </Dial>
</Response>`;
        return new Response(twiml, {
          status: 200,
          headers: { "Content-Type": "text/xml" },
        });
      },
    },
  },
});

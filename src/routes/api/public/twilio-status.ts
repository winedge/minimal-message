// Twilio status callbacks — updates the calls row so the UI can show live
// progress (dialing → ringing → answered → ended).
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/twilio-status")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const callId = url.searchParams.get("callId");
        if (!callId) return new Response("ok");

        const form = await request.formData();
        const evt = String(
          form.get("CallStatus") ?? form.get("DialCallStatus") ?? "",
        ).toLowerCase();
        const dur = parseInt(
          String(form.get("CallDuration") ?? form.get("DialCallDuration") ?? "0"),
          10,
        ) || 0;

        const patch: Record<string, unknown> = {};
        if (evt === "initiated") {
          patch.status = "ringing";
          patch.disposition = "DIALING";
        } else if (evt === "ringing") {
          patch.status = "ringing";
          patch.disposition = null;
        } else if (evt === "in-progress" || evt === "answered") {
          patch.status = "answered";
          patch.disposition = "ANSWER";
        } else if (evt === "completed") {
          patch.status = "ended";
          patch.ended_at = new Date().toISOString();
          patch.duration = dur;
        } else if (evt === "busy") {
          patch.status = "failed";
          patch.disposition = "BUSY";
          patch.ended_at = new Date().toISOString();
        } else if (evt === "no-answer") {
          patch.status = "failed";
          patch.disposition = "NOANSWER";
          patch.ended_at = new Date().toISOString();
        } else if (evt === "failed" || evt === "canceled") {
          patch.status = "failed";
          patch.disposition = evt.toUpperCase();
          patch.ended_at = new Date().toISOString();
        }

        if (Object.keys(patch).length) {
          try {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            await supabaseAdmin.from("calls").update(patch).eq("id", callId);
          } catch (e) {
            console.error("[twilio-status] update failed", e);
          }
        }
        return new Response("ok");
      },
    },
  },
});

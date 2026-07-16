import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// AMI forwarder on your VPS POSTs signed events here.
// Body: raw JSON string. Header: x-signature = hex(HMAC-SHA256(body, ASTERISK_WEBHOOK_SECRET)).
export const Route = createFileRoute("/api/public/asterisk-events")({
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

        const Event = z.object({
          type: z.enum([
            "channel_ringing",
            "channel_answered",
            "channel_hangup",
            "cdr",
            "agent_state",
          ]),
          channelId: z.string().optional(),
          linkedId: z.string().optional(),
          callId: z.string().uuid().optional(),
          agentId: z.string().uuid().optional(),
          disposition: z.string().optional(),
          recordingUrl: z.string().url().optional(),
          duration: z.number().int().optional(),
          state: z.enum(["offline", "available", "on_call"]).optional(),
          currentCallId: z.string().uuid().optional(),
          at: z.string().optional(),
        });

        let payload: z.infer<typeof Event>;
        try {
          payload = Event.parse(JSON.parse(body));
        } catch (e: any) {
          return new Response(`bad payload: ${e.message}`, { status: 400 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const now = payload.at ?? new Date().toISOString();

        try {
          switch (payload.type) {
            case "channel_ringing":
              if (payload.callId)
                await supabaseAdmin.from("calls").update({ status: "ringing" }).eq("id", payload.callId);
              break;
            case "channel_answered":
              if (payload.callId)
                await supabaseAdmin
                  .from("calls")
                  .update({ status: "answered", answered_at: now })
                  .eq("id", payload.callId);
              break;
            case "channel_hangup":
            case "cdr":
              if (payload.callId)
                await supabaseAdmin
                  .from("calls")
                  .update({
                    status: "ended",
                    ended_at: now,
                    duration: payload.duration ?? null,
                    disposition: payload.disposition ?? null,
                    recording_url: payload.recordingUrl ?? null,
                  })
                  .eq("id", payload.callId);
              break;
            case "agent_state":
              if (payload.agentId && payload.state)
                await supabaseAdmin.from("agent_status").upsert({
                  user_id: payload.agentId,
                  state: payload.state,
                  current_call_id: payload.currentCallId ?? null,
                  updated_at: now,
                });
              break;
          }
        } catch (e: any) {
          return new Response(`db error: ${e.message}`, { status: 500 });
        }

        return new Response("ok");
      },
    },
  },
});

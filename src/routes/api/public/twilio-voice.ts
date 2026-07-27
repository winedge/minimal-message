// TwiML endpoint invoked by Twilio when an agent's browser Device.connect()
// fires. Bridges the agent's WebRTC leg to the customer via a PSTN Dial.
import { createFileRoute } from "@tanstack/react-router";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const recentDialRequests = new Map<string, number>();
const CALL_DEDUPE_MS = 10 * 60 * 1000;
const PAIR_DEDUPE_MS = 45 * 1000;

function formValue(form: FormData, ...keys: string[]) {
  for (const key of keys) {
    const value = form.get(key);
    if (value != null) return String(value).trim();
  }
  return "";
}

function claimRecentDial(key: string, ttlMs: number) {
  const now = Date.now();
  for (const [k, ts] of recentDialRequests) {
    if (now - ts > CALL_DEDUPE_MS) recentDialRequests.delete(k);
  }
  const lastSeen = recentDialRequests.get(key);
  if (lastSeen && now - lastSeen < ttlMs) return false;
  recentDialRequests.set(key, now);
  return true;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function claimCallRow(callId: string, parentSid: string) {
  if (!callId) return true;
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const marker = parentSid || `twilio-started:${Date.now()}`;
    const { data: existing, error: readError } = await supabaseAdmin
      .from("calls")
      .select("asterisk_channel_id")
      .eq("id", callId)
      .maybeSingle();
    if (readError) {
      console.error("[twilio-voice] claim read failed", readError);
      return true;
    }
    if (existing?.asterisk_channel_id) return false;

    const { data, error } = await supabaseAdmin
      .from("calls")
      .update({ asterisk_channel_id: marker })
      .eq("id", callId)
      .select("id")
      .maybeSingle();
    if (error) {
      console.error("[twilio-voice] claim failed", error);
      return true;
    }
    return Boolean(data?.id);
  } catch (e) {
    console.error("[twilio-voice] claim failed", e);
    return true;
  }
}

function duplicateResponse() {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1" /></Response>`;
  return new Response(twiml, { status: 200, headers: { "Content-Type": "text/xml" } });
}

export const Route = createFileRoute("/api/public/twilio-voice")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const form = await request.formData();
        const to = formValue(form, "To", "to");
        const from = formValue(form, "From", "from");
        const callId = formValue(form, "CallId", "callId", "call_id");
        const parentSid = formValue(form, "CallSid", "callSid");

        const base = (process.env.PUBLIC_WEBHOOK_BASE_URL ?? "").replace(/\/$/, "");
        const statusUrl = `${base}/api/public/twilio-status${callId ? `?callId=${encodeURIComponent(callId)}` : ""}`;

        if (!to || !from) {
          const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Missing destination number.</Say></Response>`;
          return new Response(twiml, { status: 200, headers: { "Content-Type": "text/xml" } });
        }

        const dedupeKey = callId ? `call:${callId}` : `pair:${from}->${to}`;
        if (!claimRecentDial(dedupeKey, callId ? CALL_DEDUPE_MS : PAIR_DEDUPE_MS)) {
          return duplicateResponse();
        }

        const rowClaimed = await withTimeout(claimCallRow(callId, parentSid), 1200, true);
        if (!rowClaimed) return duplicateResponse();

        // IMPORTANT: do NOT block the TwiML response on any external I/O.
        // Twilio retries this webhook after ~15s of no response, which would
        // cause the customer's phone to ring a SECOND time. Return TwiML
        // immediately; correlation is done via callId in the status URL.
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

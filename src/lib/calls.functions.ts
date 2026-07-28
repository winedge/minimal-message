import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  findRecentActiveOutboundCall,
  identityForExt,
  normalizeDialedNumber,
  resolveOutboundCallerId,
} from "@/lib/calls.server";

// Issue a short-lived Twilio Voice access token for this agent. The browser
// registers the Device with it and can receive/place calls.
export const getSipCredentials = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("sip_endpoints")
      .select("extension")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!data) return { provisioned: false as const };

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const apiKeySid = process.env.TWILIO_API_KEY_SID;
    const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
    const appSid = process.env.TWILIO_TWIML_APP_SID;
    if (!accountSid || !apiKeySid || !apiKeySecret || !appSid) {
      throw new Error("Twilio is not configured (missing TWILIO_* secrets)");
    }

    const twilio = (await import("twilio")).default;
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;
    const identity = identityForExt(data.extension);
    const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, {
      identity,
      ttl: 3600,
    });
    token.addGrant(
      new VoiceGrant({ outgoingApplicationSid: appSid, incomingAllow: true }),
    );

    return {
      provisioned: true as const,
      token: token.toJwt(),
      identity,
      extension: data.extension,
      // Legacy fields kept for backward compat with existing UI bindings.
      username: identity,
      password: "",
      wssUrl: "twilio-managed",
      sipDomain: "twilio",
    };
  });

// Insert a `calls` row for this outbound attempt and hand back the caller ID
// the browser should use when it invokes Twilio Voice's connect().
export const originateCall = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        customerPhone: z.string().trim().min(3).max(32),
        outboundDidId: z.string().uuid().optional().nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const dialedNumber = normalizeDialedNumber(data.customerPhone);
    const callerNumber = await resolveOutboundCallerId(supabaseAdmin, data.outboundDidId);

    const recent = await findRecentActiveOutboundCall(
      context.supabase,
      context.userId,
      dialedNumber,
    );
    if (recent) {
      return { callId: recent.id, from: callerNumber, to: dialedNumber, channelId: recent.id };
    }

    const { data: call, error: insErr } = await context.supabase
      .from("calls")
      .insert({
        agent_id: context.userId,
        customer_phone: dialedNumber,
        direction: "outbound",
        status: "ringing",
        disposition: "DIALING",
      })
      .select("id")
      .single();
    if (insErr) throw new Error(insErr.message);

    return { callId: call.id, from: callerNumber, to: dialedNumber, channelId: call.id };
  });

// Mark the calls row as ended. Twilio Voice SDK handles the actual leg
// teardown in the browser.
export const hangupCall = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ channelId: z.string().min(1) }).parse(input))
  .handler(async ({ data, context }) => {
    await context.supabase
      .from("calls")
      .update({ status: "ended", ended_at: new Date().toISOString() })
      .eq("id", data.channelId);
    return { ok: true };
  });

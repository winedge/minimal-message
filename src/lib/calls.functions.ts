import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Decrypt SIP password and return the agent's own SIP credentials
// for JsSIP registration in the browser.
export const getSipCredentials = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { decryptSecret } = await import("@/lib/crypto.server");

    const { data, error } = await supabaseAdmin
      .from("sip_endpoints")
      .select("sip_username, sip_password_encrypted, extension")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return { provisioned: false as const };

    return {
      provisioned: true as const,
      username: data.sip_username,
      password: decryptSecret(data.sip_password_encrypted),
      extension: data.extension,
      wssUrl: process.env.ASTERISK_WSS_URL ?? "",
      sipDomain: process.env.ASTERISK_SIP_DOMAIN ?? "",
    };
  });

// Originate a call via Asterisk ARI. Leg A rings the agent's webrtc endpoint;
// once answered, dialplan bridges leg B to the customer via the Telnyx trunk.
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
    const ariUrl = process.env.ASTERISK_ARI_URL;
    const ariUser = process.env.ASTERISK_ARI_USER;
    const ariPass = process.env.ASTERISK_ARI_PASSWORD;
    if (!ariUrl || !ariUser || !ariPass) throw new Error("Asterisk ARI not configured");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: sip } = await supabaseAdmin
      .from("sip_endpoints")
      .select("extension")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!sip) throw new Error("SIP endpoint not provisioned for this agent");

    // Resolve outbound Caller ID (DID). Preference: explicit id → default → agent extension.
    let callerNumber = sip.extension;
    const didQuery = data.outboundDidId
      ? await supabaseAdmin.from("outbound_dids").select("phone_number").eq("id", data.outboundDidId).maybeSingle()
      : await supabaseAdmin.from("outbound_dids").select("phone_number").eq("is_default", true).maybeSingle();
    if (didQuery.data?.phone_number) callerNumber = didQuery.data.phone_number;

    // Insert call row (ringing)
    const { data: call, error: insErr } = await context.supabase
      .from("calls")
      .insert({
        agent_id: context.userId,
        customer_phone: data.customerPhone,
        direction: "outbound",
        status: "ringing",
      })
      .select("id")
      .single();
    if (insErr) throw new Error(insErr.message);

    const auth = Buffer.from(`${ariUser}:${ariPass}`).toString("base64");
    const body = {
      endpoint: `PJSIP/${sip.extension}`,
      extension: data.customerPhone,
      context: "from-internal",
      priority: 1,
      callerId: `"Agent" <${callerNumber}>`,
      variables: {
        LOVABLE_CALL_ID: call.id,
        LOVABLE_AGENT_ID: context.userId,
        CALLERID_NUM: callerNumber,
      },
    };
    const res = await fetch(`${ariUrl.replace(/\/$/, "")}/channels`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      await context.supabase
        .from("calls")
        .update({ status: "failed", ended_at: new Date().toISOString() })
        .eq("id", call.id);
      throw new Error(`ARI originate failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const channel = (await res.json()) as { id: string };
    await context.supabase
      .from("calls")
      .update({ asterisk_channel_id: channel.id })
      .eq("id", call.id);

    return { callId: call.id, channelId: channel.id };
  });

export const hangupCall = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ channelId: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const ariUrl = process.env.ASTERISK_ARI_URL;
    const ariUser = process.env.ASTERISK_ARI_USER;
    const ariPass = process.env.ASTERISK_ARI_PASSWORD;
    if (!ariUrl || !ariUser || !ariPass) throw new Error("Asterisk ARI not configured");
    const auth = Buffer.from(`${ariUser}:${ariPass}`).toString("base64");
    const res = await fetch(
      `${ariUrl.replace(/\/$/, "")}/channels/${encodeURIComponent(data.channelId)}`,
      { method: "DELETE", headers: { Authorization: `Basic ${auth}` } },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`ARI hangup failed: ${res.status}`);
    }
    return { ok: true };
  });

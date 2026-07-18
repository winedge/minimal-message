import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin only");
}

// Originate a ChanSpy leg from the admin's own SIP endpoint against the
// target agent's PJSIP channel. Requires the [lovable-spy] dialplan
// context on the VPS (see docs/ASTERISK_SETUP.md).
async function originateSpy(mode: "q" | "qw" | "qB", adminExt: string, targetExt: string) {
  const ariUrl = process.env.ASTERISK_ARI_URL;
  const ariUser = process.env.ASTERISK_ARI_USER;
  const ariPass = process.env.ASTERISK_ARI_PASSWORD;
  if (!ariUrl || !ariUser || !ariPass) throw new Error("Asterisk ARI not configured");
  const auth = Buffer.from(`${ariUser}:${ariPass}`).toString("base64");
  const res = await fetch(`${ariUrl.replace(/\/$/, "")}/channels`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: `PJSIP/${adminExt}`,
      extension: targetExt,
      context: "lovable-spy",
      priority: 1,
      callerId: `"Supervisor" <${adminExt}>`,
      variables: { SPY_MODE: mode },
    }),
  });
  if (!res.ok) throw new Error(`ARI spy failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as { id: string };
}

const Input = z.object({ agentId: z.string().uuid() });

async function resolveExtensions(adminId: string, agentId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: rows, error } = await supabaseAdmin
    .from("sip_endpoints")
    .select("user_id, extension")
    .in("user_id", [adminId, agentId]);
  if (error) throw new Error(error.message);
  const admin = rows?.find((r: any) => r.user_id === adminId);
  const agent = rows?.find((r: any) => r.user_id === agentId);
  if (!admin) throw new Error("Your admin account has no SIP endpoint provisioned");
  if (!agent) throw new Error("Target agent has no SIP endpoint provisioned");
  return { adminExt: admin.extension as string, targetExt: agent.extension as string };
}

export const spyCall = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => Input.parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { adminExt, targetExt } = await resolveExtensions(context.userId, data.agentId);
    return originateSpy("q", adminExt, targetExt);
  });

export const whisperCall = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => Input.parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { adminExt, targetExt } = await resolveExtensions(context.userId, data.agentId);
    return originateSpy("qw", adminExt, targetExt);
  });

export const bargeCall = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => Input.parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { adminExt, targetExt } = await resolveExtensions(context.userId, data.agentId);
    return originateSpy("qB", adminExt, targetExt);
  });

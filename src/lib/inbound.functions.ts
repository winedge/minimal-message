import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin only");
}

const RouteInput = z.object({
  did: z.string().trim().min(3).max(32),
  strategy: z.enum(["direct", "roundrobin"]),
  target_user_id: z.string().uuid().nullable().optional(),
  ring_group: z.array(z.string().uuid()).default([]),
  ring_seconds: z.number().int().min(5).max(120).default(20),
  fallback_extension: z.string().trim().max(32).nullable().optional(),
});

export const upsertInboundRoute = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({ id: z.string().uuid().optional(), route: RouteInput }).parse(i),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const payload = {
      did: data.route.did,
      strategy: data.route.strategy,
      target_user_id: data.route.target_user_id ?? null,
      ring_group: data.route.ring_group,
      ring_seconds: data.route.ring_seconds,
      fallback_extension: data.route.fallback_extension ?? null,
      updated_at: new Date().toISOString(),
    };
    if (data.id) {
      const { error } = await supabaseAdmin.from("inbound_routes").update(payload).eq("id", data.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabaseAdmin.from("inbound_routes").insert(payload);
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

export const deleteInboundRoute = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("inbound_routes").delete().eq("id", data.id);
    return { ok: true };
  });

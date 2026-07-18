import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertAdmin(ctx: any) {
  const { data: isAdmin } = await ctx.supabase.rpc("has_role", {
    _user_id: ctx.userId,
    _role: "admin",
  });
  if (!isAdmin) throw new Error("Forbidden");
}

export const upsertOutboundDid = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        id: z.string().uuid().optional(),
        phone_number: z
          .string()
          .trim()
          .regex(/^\+?[1-9]\d{6,15}$/, "Use E.164 e.g. +14155551234"),
        label: z.string().trim().max(64).optional().nullable(),
        is_default: z.boolean().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    if (data.is_default) {
      await supabaseAdmin.from("outbound_dids").update({ is_default: false }).neq("id", data.id ?? "00000000-0000-0000-0000-000000000000");
    }
    const row = {
      phone_number: data.phone_number.startsWith("+") ? data.phone_number : `+${data.phone_number}`,
      label: data.label ?? null,
      is_default: data.is_default ?? false,
    };
    if (data.id) {
      const { error } = await supabaseAdmin.from("outbound_dids").update(row).eq("id", data.id);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: ins, error } = await supabaseAdmin
      .from("outbound_dids")
      .insert(row)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: ins.id };
  });

export const deleteOutboundDid = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("outbound_dids").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin only");
}

// Create an agent: creates auth user, profile, agent role, SIP endpoint.
export const createAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        email: z.string().email(),
        password: z.string().min(8).max(128),
        fullName: z.string().trim().min(1).max(100),
        extension: z.string().trim().regex(/^\d{3,6}$/, "3-6 digits"),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { encryptSecret } = await import("@/lib/crypto.server");

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { full_name: data.fullName },
    });
    if (createErr || !created.user) throw new Error(createErr?.message ?? "Create user failed");

    const userId = created.user.id;

    await supabaseAdmin.from("user_roles").insert({ user_id: userId, role: "agent" });

    const sipUsername = `agent_${data.extension}`;
    const sipPassword = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    await supabaseAdmin.from("sip_endpoints").insert({
      user_id: userId,
      sip_username: sipUsername,
      sip_password_encrypted: encryptSecret(sipPassword),
      extension: data.extension,
    });

    // Return credentials once so admin can configure Asterisk / share with agent.
    return { userId, sipUsername, sipPassword, extension: data.extension };
  });

export const listAgents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: profiles } = await supabaseAdmin
      .from("profiles")
      .select("id, full_name, disabled, created_at")
      .order("created_at", { ascending: false });
    const { data: roles } = await supabaseAdmin.from("user_roles").select("user_id, role");
    const { data: sips } = await supabaseAdmin
      .from("sip_endpoints")
      .select("user_id, sip_username, extension");
    return (profiles ?? []).map((p) => ({
      ...p,
      role:
        roles?.find((r) => r.user_id === p.id && r.role === "admin")
          ? "admin"
          : roles?.find((r) => r.user_id === p.id && r.role === "agent")
            ? "agent"
            : null,
      sip: sips?.find((s) => s.user_id === p.id) ?? null,
    }));
  });

export const setAgentDisabled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ userId: z.string().uuid(), disabled: z.boolean() }).parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("profiles").update({ disabled: data.disabled }).eq("id", data.userId);
    if (data.disabled) {
      await supabaseAdmin.auth.admin.updateUserById(data.userId, { ban_duration: "876000h" });
    } else {
      await supabaseAdmin.auth.admin.updateUserById(data.userId, { ban_duration: "none" });
    }
    return { ok: true };
  });

// Promote the CURRENT user to admin ONLY if no admin exists yet (bootstrap).
export const claimFirstAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { count } = await supabaseAdmin
      .from("user_roles")
      .select("*", { count: "exact", head: true })
      .eq("role", "admin");
    if ((count ?? 0) > 0) throw new Error("An admin already exists");
    await supabaseAdmin.from("user_roles").insert({ user_id: context.userId, role: "admin" });
    return { ok: true };
  });

// CRM field defs
const FieldInput = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]*$/, "lowercase, digits, underscore"),
  label: z.string().trim().min(1).max(100),
  type: z.enum(["text", "textarea", "number", "select", "date", "checkbox"]),
  options: z.array(z.string().min(1).max(100)).optional(),
  sort_order: z.number().int().default(0),
  required: z.boolean().default(false),
});

export const upsertField = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid().optional(), field: FieldInput }).parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const payload = {
      ...data.field,
      options: data.field.options ? data.field.options : null,
    };
    if (data.id) {
      await supabaseAdmin.from("crm_field_defs").update(payload).eq("id", data.id);
    } else {
      await supabaseAdmin.from("crm_field_defs").insert(payload);
    }
    return { ok: true };
  });

export const deleteField = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("crm_field_defs").delete().eq("id", data.id);
    return { ok: true };
  });

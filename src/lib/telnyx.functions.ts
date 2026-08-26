import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listTelnyxNumbers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // admin only
    const { data: isAdmin } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (!isAdmin) throw new Error("Forbidden");

    const key = process.env.TELNYX_API_KEY;
    // Telnyx is optional (Twilio is the primary provider) — never throw, just
    // return an empty list so the UI falls back to manual DID entry.
    if (!key) return [];

    const numbers: { phone_number: string; status: string | null; tag: string | null }[] = [];
    let page = 1;
    // Paginate up to 10 pages (2500 numbers) to be safe
    while (page <= 10) {
      const url = `https://api.telnyx.com/v2/phone_numbers?page[number]=${page}&page[size]=250`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      });
      if (!res.ok) {
        console.error(`Telnyx API ${res.status}: ${await res.text()}`);
        return numbers; // degrade gracefully; UI allows manual DID entry
      }
      const json: any = await res.json();
      const items: any[] = json.data ?? [];
      for (const it of items) {
        numbers.push({
          phone_number: it.phone_number,
          status: it.status ?? null,
          tag: (it.tags && it.tags[0]) ?? null,
        });
      }
      const totalPages = json?.meta?.total_pages ?? 1;
      if (page >= totalPages) break;
      page++;
    }
    return numbers;
  });

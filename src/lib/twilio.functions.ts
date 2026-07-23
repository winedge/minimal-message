import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listTwilioNumbers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: isAdmin } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (!isAdmin) throw new Error("Forbidden");

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new Error("Twilio not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing)");

    const numbers: { phone_number: string; status: string | null; tag: string | null }[] = [];
    let url: string | null = `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PageSize=100`;
    const auth = "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
    let guard = 0;
    while (url && guard++ < 20) {
      const res: Response = await fetch(url, { headers: { Authorization: auth, Accept: "application/json" } });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Twilio API ${res.status}: ${body}`);
      }
      const json: any = await res.json();
      for (const it of json.incoming_phone_numbers ?? []) {
        numbers.push({
          phone_number: it.phone_number,
          status: it.status ?? null,
          tag: it.friendly_name ?? null,
        });
      }
      url = json.next_page_uri ? `https://api.twilio.com${json.next_page_uri}` : null;
    }
    return numbers;
  });

export function identityForExt(ext: string | number) {
  return `ext_${ext}`;
}

export function normalizeDialedNumber(raw: string) {
  const dialedNumber = raw.replace(/[^0-9+*#]/g, "");
  if (dialedNumber.replace(/[^0-9]/g, "").length < 3) {
    throw new Error("Enter a valid phone number");
  }
  return dialedNumber;
}

export async function resolveOutboundCallerId(
  supabaseAdmin: any,
  outboundDidId?: string | null,
) {
  const didQuery = outboundDidId
    ? await supabaseAdmin
        .from("outbound_dids")
        .select("phone_number")
        .eq("id", outboundDidId)
        .maybeSingle()
    : await supabaseAdmin
        .from("outbound_dids")
        .select("phone_number")
        .eq("is_default", true)
        .maybeSingle();

  const callerNumber = didQuery.data?.phone_number;
  if (!callerNumber) {
    throw new Error(
      "No outbound caller ID configured. Add a DID under Admin → Outbound DIDs and mark one as default.",
    );
  }
  return callerNumber as string;
}

export async function findRecentActiveOutboundCall(
  supabase: any,
  agentId: string,
  dialedNumber: string,
) {
  const since = new Date(Date.now() - 90_000).toISOString();
  try {
    const { data, error } = await supabase
      .from("calls")
      .select("id")
      .eq("agent_id", agentId)
      .eq("customer_phone", dialedNumber)
      .eq("direction", "outbound")
      .is("ended_at", null)
      .gte("started_at", since)
      .in("status", ["dialing", "ringing", "answered"])
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("[originateCall] recent call lookup failed", error);
      return null;
    }
    return data?.id ? { id: data.id as string } : null;
  } catch (e) {
    console.error("[originateCall] recent call lookup failed", e);
    return null;
  }
}
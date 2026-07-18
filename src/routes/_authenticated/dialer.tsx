import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Softphone, type SoftphoneState, type IncomingCallInfo } from "@/lib/softphone";
import { getSipCredentials, originateCall, hangupCall } from "@/lib/calls.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Mic, MicOff, Pause, Play, PhoneOff, Phone } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dialer")({
  head: () => ({ meta: [{ title: "Dialer" }] }),
  component: DialerPage,
});

type FieldDef = {
  id: string;
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "select" | "date" | "checkbox";
  options: string[] | null;
  sort_order: number;
  required: boolean;
};

function DialerPage() {
  const qc = useQueryClient();
  const getCreds = useServerFn(getSipCredentials);
  const originate = useServerFn(originateCall);
  const hangup = useServerFn(hangupCall);

  const creds = useQuery({ queryKey: ["sip-creds"], queryFn: () => getCreds() });
  const fields = useQuery({
    queryKey: ["field-defs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("crm_field_defs")
        .select("*")
        .order("sort_order");
      if (error) throw error;
      return (data ?? []) as FieldDef[];
    },
  });

  const [phone, setPhone] = useState("");
  const [state, setState] = useState<SoftphoneState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [activeChannel, setActiveChannel] = useState<string | null>(null);
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const softphoneRef = useRef<Softphone | null>(null);

  useEffect(() => {
    if (!creds.data || creds.data.provisioned === false) return;
    const c = creds.data;
    const sp = new Softphone({
      onState: setState,
      onError: (m) => {
        setError(m);
        toast.error(m);
      },
    });
    softphoneRef.current = sp;
    sp.register({
      username: c.username,
      password: c.password,
      wssUrl: c.wssUrl,
      sipDomain: c.sipDomain,
    });
    return () => {
      sp.stop();
      softphoneRef.current = null;
    };
  }, [creds.data]);

  const dial = useMutation({
    mutationFn: async () => originate({ data: { customerPhone: phone } }),
    onSuccess: (r) => {
      setActiveCallId(r.callId);
      setActiveChannel(r.channelId);
      setValues({});
      toast.success("Dialing…");
    },
    onError: (e: any) => toast.error(e.message ?? "Failed"),
  });

  async function endCall() {
    if (activeChannel) await hangup({ data: { channelId: activeChannel } });
    softphoneRef.current?.hangup();
    // Save CRM entry
    if (activeCallId) {
      // upsert customer by phone
      const { data: cust } = await supabase
        .from("customers")
        .insert({ phone, created_by: (await supabase.auth.getUser()).data.user?.id })
        .select("id")
        .single();
      await supabase.from("crm_entries").insert({
        call_id: activeCallId,
        customer_id: cust?.id ?? null,
        agent_id: (await supabase.auth.getUser()).data.user?.id,
        values,
      });
      toast.success("Call notes saved");
    }
    setActiveChannel(null);
    setActiveCallId(null);
    qc.invalidateQueries({ queryKey: ["history"] });
  }

  if (creds.isLoading) return <p className="text-muted-foreground">Loading softphone…</p>;
  if (creds.data && creds.data.provisioned === false) {
    return (
      <div className="rounded border p-6">
        <h2 className="text-lg font-semibold">SIP not provisioned</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Ask an admin to create a SIP endpoint for your account.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      <section className="space-y-4 rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Softphone</h2>
          <span className="rounded bg-muted px-2 py-0.5 text-xs uppercase">{state}</span>
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone">Customer number</Label>
          <Input
            id="phone"
            inputMode="tel"
            placeholder="+1..."
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            disabled={!!activeChannel}
          />
        </div>
        <div className="flex gap-2">
          <Button
            className="flex-1"
            disabled={!phone || !!activeChannel || state !== "registered"}
            onClick={() => dial.mutate()}
          >
            {dial.isPending ? "Dialing…" : "Dial"}
          </Button>
          <Button variant="destructive" disabled={!activeChannel} onClick={endCall}>
            Hang up
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </section>

      <section className="space-y-4 rounded-lg border p-4">
        <h2 className="font-semibold">Call notes</h2>
        {!fields.data?.length && (
          <p className="text-sm text-muted-foreground">
            No CRM fields yet. Ask an admin to add fields under CRM fields.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {(fields.data ?? []).map((f) => (
            <FieldInput
              key={f.id}
              field={f}
              value={values[f.key]}
              onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = (
    <Label>
      {field.label}
      {field.required && <span className="text-destructive"> *</span>}
    </Label>
  );
  const common = { id: field.id };
  switch (field.type) {
    case "textarea":
      return (
        <div className="space-y-2 sm:col-span-2">
          {label}
          <Textarea
            {...common}
            value={(value as string) ?? ""}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
    case "number":
      return (
        <div className="space-y-2">
          {label}
          <Input
            {...common}
            type="number"
            value={(value as string) ?? ""}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
    case "date":
      return (
        <div className="space-y-2">
          {label}
          <Input
            {...common}
            type="date"
            value={(value as string) ?? ""}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
    case "checkbox":
      return (
        <div className="flex items-center gap-2">
          <input
            {...common}
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
          />
          {label}
        </div>
      );
    case "select":
      return (
        <div className="space-y-2">
          {label}
          <select
            {...common}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={(value as string) ?? ""}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">—</option>
            {(field.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
      );
    default:
      return (
        <div className="space-y-2">
          {label}
          <Input
            {...common}
            value={(value as string) ?? ""}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
  }
}

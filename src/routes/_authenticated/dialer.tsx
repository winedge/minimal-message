import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  Softphone,
  testSoftphoneWebSocket,
  type SoftphoneState,
  type IncomingCallInfo,
} from "@/lib/softphone";
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
  const [muted, setMuted] = useState(false);
  const [held, setHeld] = useState(false);
  const [incoming, setIncoming] = useState<IncomingCallInfo | null>(null);
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [inputId, setInputId] = useState<string>("");
  const [outputId, setOutputId] = useState<string>("");
  const [showKeypad, setShowKeypad] = useState(false);
  const [wsProbe, setWsProbe] = useState<string | null>(null);
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
      onIncoming: (info) => {
        setIncoming(info);
        toast.info(`Incoming call from ${info.displayName ?? info.from}`);
      },
      onMuteChange: setMuted,
      onHoldChange: setHeld,
    });
    softphoneRef.current = sp;
    sp.register({
      username: c.username,
      password: c.password,
      wssUrl: c.wssUrl,
      sipDomain: c.sipDomain,
    });
    sp.listDevices().then(({ inputs, outputs }) => {
      setInputs(inputs);
      setOutputs(outputs);
    });
    return () => {
      sp.stop();
      softphoneRef.current = null;
    };
  }, [creds.data]);

  useEffect(() => {
    if (state === "registered") {
      setMuted(false);
      setHeld(false);
      setIncoming(null);
      setShowKeypad(false);
    }
  }, [state]);

  // Heartbeat presence
  useEffect(() => {
    let cancelled = false;
    const push = async () => {
      const u = (await supabase.auth.getUser()).data.user;
      if (!u || cancelled) return;
      const s =
        state === "in_call" || activeChannel
          ? "on_call"
          : state === "registered"
            ? "available"
            : "offline";
      const { error } = await supabase.from("agent_status").upsert({
        user_id: u.id,
        state: s,
        current_call_id: activeCallId,
        updated_at: new Date().toISOString(),
      });
      if (error) console.error("[heartbeat] upsert failed:", error);
      else console.log("[heartbeat] ok state=", s);
    };
    push();
    const t = window.setInterval(push, 10_000);
    const offline = async () => {
      const u = (await supabase.auth.getUser()).data.user;
      if (!u) return;
      await supabase.from("agent_status").upsert({
        user_id: u.id,
        state: "offline",
        current_call_id: null,
        updated_at: new Date().toISOString(),
      });
    };
    window.addEventListener("beforeunload", offline);
    return () => {
      cancelled = true;
      clearInterval(t);
      window.removeEventListener("beforeunload", offline);
      offline();
    };
  }, [state, activeChannel, activeCallId]);


  const acceptIncoming = useCallback(() => {
    softphoneRef.current?.answer();
    setIncoming(null);
  }, []);
  const rejectIncoming = useCallback(() => {
    softphoneRef.current?.reject();
    setIncoming(null);
  }, []);

  const runWsProbe = useCallback(async () => {
    if (!creds.data || creds.data.provisioned === false) return;
    setWsProbe("Testing PBX WebSocket…");
    const result = await testSoftphoneWebSocket(creds.data.wssUrl);
    const suffix = result.code ? ` (close ${result.code}${result.reason ? `: ${result.reason}` : ""})` : "";
    setWsProbe(`${result.ok ? "OK" : "FAILED"}: ${result.message}${suffix}. Origin: ${result.origin}. URL: ${result.url}`);
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

  const inCall = state === "in_call" || !!activeChannel;
  const handleKey = (k: string) => {
    if (inCall) softphoneRef.current?.sendDtmf(k);
    else if (!activeChannel) setPhone((p) => p + k);
  };
  const statusLabel: Record<SoftphoneState, string> = {
    idle: "Offline",
    registering: "Connecting…",
    registered: "Ready",
    calling: "Calling…",
    incoming: "Incoming",
    in_call: "In call",
    failed: "Offline",
  };
  const statusColor =
    state === "registered" || state === "in_call"
      ? "bg-emerald-500"
      : state === "failed" || state === "idle"
        ? "bg-red-500"
        : "bg-amber-500";

  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <section className="mx-auto w-full max-w-[340px] space-y-4">
        {/* Handset */}
        <div className="rounded-[2.5rem] border border-neutral-800 bg-neutral-900 p-4 shadow-2xl">
          {/* Screen */}
          <div className="rounded-2xl bg-gradient-to-b from-neutral-800 to-neutral-950 p-4 text-neutral-100">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-neutral-400">
              <span className="flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 rounded-full ${statusColor}`} />
                {statusLabel[state]}
              </span>
              <span>{creds.data?.provisioned ? `ext ${creds.data.extension}` : ""}</span>
            </div>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Enter number"
              inputMode="tel"
              disabled={!!activeChannel}
              className="mt-3 w-full bg-transparent text-center text-3xl font-light tracking-wider text-white placeholder:text-neutral-600 focus:outline-none"
            />
            <div className="mt-1 h-4 text-center text-xs text-neutral-500">
              {incoming
                ? `Incoming: ${incoming.displayName ?? incoming.from}`
                : inCall
                  ? "Connected"
                  : ""}
            </div>
          </div>

          {/* Keypad */}
          <div className="mt-4 grid grid-cols-3 gap-2">
            {[
              ["1", ""],
              ["2", "ABC"],
              ["3", "DEF"],
              ["4", "GHI"],
              ["5", "JKL"],
              ["6", "MNO"],
              ["7", "PQRS"],
              ["8", "TUV"],
              ["9", "WXYZ"],
              ["*", ""],
              ["0", "+"],
              ["#", ""],
            ].map(([k, sub]) => (
              <button
                key={k}
                type="button"
                onClick={() => handleKey(k)}
                className="flex h-14 flex-col items-center justify-center rounded-full bg-neutral-800 text-white transition active:scale-95 active:bg-neutral-700"
              >
                <span className="text-xl font-medium leading-none">{k}</span>
                {sub && <span className="mt-0.5 text-[9px] tracking-widest text-neutral-400">{sub}</span>}
              </button>
            ))}
          </div>

          {/* Call actions */}
          <div className="mt-5 flex items-center justify-center gap-4">
            {incoming ? (
              <>
                <button
                  onClick={rejectIncoming}
                  className="flex h-14 w-14 items-center justify-center rounded-full bg-red-600 text-white shadow-lg active:scale-95"
                >
                  <PhoneOff className="h-6 w-6" />
                </button>
                <button
                  onClick={acceptIncoming}
                  className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg active:scale-95"
                >
                  <Phone className="h-6 w-6" />
                </button>
              </>
            ) : inCall ? (
              <button
                onClick={endCall}
                className="flex h-14 w-16 items-center justify-center rounded-full bg-red-600 text-white shadow-lg active:scale-95"
              >
                <PhoneOff className="h-6 w-6" />
              </button>
            ) : (
              <>
                <button
                  onClick={() => setPhone((p) => p.slice(0, -1))}
                  disabled={!phone}
                  className="text-sm text-neutral-400 hover:text-white disabled:opacity-30"
                >
                  ⌫
                </button>
                <button
                  onClick={() => dial.mutate()}
                  disabled={!phone || state !== "registered" || dial.isPending}
                  className="flex h-14 w-16 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg transition active:scale-95 disabled:opacity-40"
                >
                  <Phone className="h-6 w-6" />
                </button>
                <button
                  onClick={() => setPhone("")}
                  disabled={!phone}
                  className="text-xs text-neutral-400 hover:text-white disabled:opacity-30"
                >
                  Clear
                </button>
              </>
            )}
          </div>

          {/* In-call mute/hold */}
          {inCall && (
            <div className="mt-4 flex justify-center gap-2">
              <button
                onClick={() => softphoneRef.current?.toggleMute()}
                className={`flex items-center gap-1.5 rounded-full px-4 py-2 text-xs ${muted ? "bg-white text-neutral-900" : "bg-neutral-800 text-white"}`}
              >
                {muted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                {muted ? "Unmute" : "Mute"}
              </button>
              <button
                onClick={() => softphoneRef.current?.toggleHold()}
                className={`flex items-center gap-1.5 rounded-full px-4 py-2 text-xs ${held ? "bg-white text-neutral-900" : "bg-neutral-800 text-white"}`}
              >
                {held ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                {held ? "Resume" : "Hold"}
              </button>
            </div>
          )}
        </div>

        {/* Devices + diagnostics */}
        <details className="rounded-lg border p-3 text-sm">
          <summary className="cursor-pointer font-medium">Audio & diagnostics</summary>
          <div className="mt-3 space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Microphone</Label>
              <select
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                value={inputId}
                onChange={(e) => {
                  setInputId(e.target.value);
                  softphoneRef.current?.setInputDevice(e.target.value);
                }}
              >
                <option value="">Default</option>
                {inputs.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Speaker</Label>
              <select
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                value={outputId}
                onChange={(e) => {
                  setOutputId(e.target.value);
                  softphoneRef.current?.setOutputDevice(e.target.value);
                }}
              >
                <option value="">Default</option>
                {outputs.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId.slice(0, 8)}</option>
                ))}
              </select>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={runWsProbe}>
              Test PBX WebSocket
            </Button>
            {wsProbe && <p className="break-words text-xs text-muted-foreground">{wsProbe}</p>}
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </details>
      </section>



      <div className="space-y-4">
        <ContactsPanel
          disabled={!!activeChannel}
          onPick={(p) => setPhone(p)}
        />
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
    </div>
  );
}

type ContactRow = {
  id: string;
  phone: string;
  first_name: string | null;
  last_name: string | null;
  list_id: string | null;
};

function ContactsPanel({
  onPick,
  disabled,
}: {
  onPick: (phone: string) => void;
  disabled: boolean;
}) {
  const [lists, setLists] = useState<{ id: string; name: string }[]>([]);
  const [listId, setListId] = useState<string>("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ContactRow[]>([]);

  useEffect(() => {
    supabase
      .from("contact_lists")
      .select("id, name")
      .order("name")
      .then(({ data }) => setLists((data ?? []) as any));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      let query = supabase
        .from("contacts")
        .select("id, phone, first_name, last_name, list_id")
        .order("created_at", { ascending: false })
        .limit(25);
      if (listId) query = query.eq("list_id", listId);
      if (q.trim()) {
        const s = q.trim();
        query = query.or(
          `phone.ilike.%${s}%,first_name.ilike.%${s}%,last_name.ilike.%${s}%`,
        );
      }
      const { data } = await query;
      if (!cancelled) setRows((data ?? []) as ContactRow[]);
    };
    const t = setTimeout(run, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, listId]);

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Contacts</h2>
        <select
          className="rounded-md border bg-background px-2 py-1 text-xs"
          value={listId}
          onChange={(e) => setListId(e.target.value)}
        >
          <option value="">All lists</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      </div>
      <Input
        placeholder="Search name or number"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <ul className="max-h-64 divide-y overflow-y-auto rounded border">
        {rows.map((c) => (
          <li key={c.id} className="flex items-center justify-between px-3 py-2 text-sm">
            <div>
              <div>{[c.first_name, c.last_name].filter(Boolean).join(" ") || "—"}</div>
              <div className="font-mono text-xs text-muted-foreground">{c.phone}</div>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => onPick(c.phone)}
            >
              Load
            </Button>
          </li>
        ))}
        {!rows.length && (
          <li className="px-3 py-4 text-center text-xs text-muted-foreground">
            No contacts.
          </li>
        )}
      </ul>
    </section>
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

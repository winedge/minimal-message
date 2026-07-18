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
import { Mic, MicOff, Pause, Play, PhoneOff, Phone, Search, Clock, PhoneCall, CheckCircle2, Grid3x3, Delete } from "lucide-react";

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

  const todayStats = useQuery({
    queryKey: ["dialer-today"],
    queryFn: async () => {
      const u = (await supabase.auth.getUser()).data.user;
      if (!u) return { count: 0, talkSec: 0, answered: 0 };
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      const { data, error } = await supabase
        .from("calls")
        .select("id, duration, status")
        .eq("agent_id", u.id)
        .gte("started_at", since.toISOString());
      if (error) return { count: 0, talkSec: 0, answered: 0 };
      const rows = data ?? [];
      return {
        count: rows.length,
        talkSec: rows.reduce((a: number, r: any) => a + (r.duration ?? 0), 0),
        answered: rows.filter((r: any) => r.status === "answered" || r.status === "ended").length,
      };
    },
    refetchInterval: 15_000,
  });

  const DEFAULT_PHONE = "+1";
  const [phone, setPhone] = useState(DEFAULT_PHONE);
  const [outboundDidId, setOutboundDidId] = useState<string>("");
  const outboundDids = useQuery({
    queryKey: ["outbound_dids"],
    queryFn: async () => {
      const { data } = await supabase.from("outbound_dids").select("id, phone_number, label, is_default").order("phone_number");
      return data ?? [];
    },
  });
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
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(0);
  const [wsProbe, setWsProbe] = useState<string | null>(null);
  const softphoneRef = useRef<Softphone | null>(null);
  const presenceRef = useRef({ state, activeChannel, activeCallId });

  useEffect(() => {
    presenceRef.current = { state, activeChannel, activeCallId };
  }, [state, activeChannel, activeCallId]);

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
      setCallStartedAt(null);
    }
    if (state === "in_call" && !callStartedAt) setCallStartedAt(Date.now());
  }, [state, callStartedAt]);

  useEffect(() => {
    if (state !== "in_call") return;
    const t = window.setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  const pushPresence = useCallback(async (forceOffline = false) => {
      const u = (await supabase.auth.getUser()).data.user;
      if (!u) return;
      const current = presenceRef.current;
      const s =
        forceOffline
          ? "offline"
          : current.state === "in_call" || current.activeChannel
          ? "on_call"
          : current.state === "registered"
            ? "available"
            : "offline";
      const { error } = await supabase.from("agent_status").upsert({
        user_id: u.id,
        state: s,
        current_call_id: forceOffline ? null : current.activeCallId,
        updated_at: new Date().toISOString(),
      });
      if (error) console.error("[heartbeat] upsert failed:", error);
      else console.log("[heartbeat] ok state=", s);
  }, []);

  // Heartbeat presence
  useEffect(() => {
    void pushPresence();
  }, [state, activeChannel, activeCallId, pushPresence]);

  useEffect(() => {
    let cancelled = false;
    const push = () => {
      if (!cancelled) void pushPresence();
    };
    push();
    const t = window.setInterval(push, 10_000);
    const offline = () => {
      void pushPresence(true);
    };
    window.addEventListener("beforeunload", offline);
    return () => {
      cancelled = true;
      clearInterval(t);
      window.removeEventListener("beforeunload", offline);
      offline();
    };
  }, [pushPresence]);


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
    mutationFn: async () => originate({ data: { customerPhone: phone, outboundDidId: outboundDidId || null } }),
    onMutate: () => {
      toast.info("Starting call…");
    },
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
    setPhone(DEFAULT_PHONE);
    qc.invalidateQueries({ queryKey: ["history"] });
    qc.invalidateQueries({ queryKey: ["dialer-today"] });
  }

  const fmtDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  };

  const inCall = state === "in_call" || !!activeChannel;
  const handleKey = useCallback((k: string) => {
    if (inCall) softphoneRef.current?.sendDtmf(k);
    else if (!activeChannel) setPhone((p) => p + k);
  }, [activeChannel, inCall]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t as any)?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      if (/^[0-9*#]$/.test(k)) {
        e.preventDefault();
        handleKey(k);
      } else if (k === "+") {
        e.preventDefault();
        if (!inCall && !activeChannel) setPhone((p) => p + "+");
      } else if (k === "Backspace") {
        e.preventDefault();
        if (!inCall && !activeChannel) setPhone((p) => (p.length > DEFAULT_PHONE.length ? p.slice(0, -1) : DEFAULT_PHONE));
      } else if (k === "Enter") {
        if (!inCall && !activeChannel && phone && !dial.isPending) {
          e.preventDefault();
          dial.mutate();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeChannel, dial, handleKey, inCall, phone]);

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

  const stats = todayStats.data ?? { count: 0, talkSec: 0, answered: 0 };

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Top status bar */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl border bg-card p-3 sm:flex sm:flex-wrap sm:justify-between sm:p-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="relative flex h-3 w-3 shrink-0">
            <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${statusColor}`} />
            <span className={`relative inline-flex h-3 w-3 rounded-full ${statusColor}`} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold leading-tight">{statusLabel[state]}</div>
            <div className="truncate text-xs text-muted-foreground">
              {creds.data?.provisioned ? `Ext ${creds.data.extension}` : "Not provisioned"}
              {inCall && phone ? ` · ${phone}` : ""}
            </div>
          </div>
        </div>
        <div className="col-span-2 grid grid-cols-3 gap-2 sm:flex sm:items-center sm:gap-3">
          <StatChip icon={<PhoneCall className="h-3.5 w-3.5" />} label="Calls" value={String(stats.count)} />
          <StatChip icon={<CheckCircle2 className="h-3.5 w-3.5" />} label="Answered" value={String(stats.answered)} />
          <StatChip icon={<Clock className="h-3.5 w-3.5" />} label="Talk" value={fmtDuration(stats.talkSec)} />
        </div>
      </div>

    <div className="grid gap-4 sm:gap-6 lg:grid-cols-[280px_360px_1fr]">
      <section className="mx-auto w-full max-w-[360px] space-y-4 lg:order-2">

        {/* Handset */}
        <div className="rounded-[2.5rem] border border-neutral-800 bg-neutral-900 p-4 shadow-2xl">
          {(() => {
            const callView = incoming || inCall || state === "calling" || dial.isPending;
            const elapsedSec = callStartedAt ? Math.floor((Date.now() - callStartedAt) / 1000) : 0;
            void nowTick;
            const callStatusText = incoming
              ? "Incoming call"
              : state === "in_call"
                ? held ? "On hold" : "Connected"
                : "Calling…";

            if (callView) {
              return (
                <>
                  {/* Call screen */}
                  <div className="rounded-2xl bg-gradient-to-b from-neutral-800 to-neutral-950 p-6 text-center text-neutral-100">
                    <div className="text-[10px] uppercase tracking-widest text-neutral-400">{callStatusText}</div>
                    <div className="mt-4 text-3xl font-light tracking-wider text-white">
                      {incoming ? (incoming.displayName ?? incoming.from) : phone}
                    </div>
                    <div className="mt-2 h-5 text-sm tabular-nums text-neutral-400">
                      {state === "in_call" ? fmtDuration(elapsedSec) : incoming ? "Ringing…" : "Dialing…"}
                    </div>
                  </div>

                  {/* In-call DTMF keypad (toggle) */}
                  {showKeypad && inCall && (
                    <div className="mt-4 grid grid-cols-3 gap-2">
                      {[
                        ["1", ""], ["2", "ABC"], ["3", "DEF"],
                        ["4", "GHI"], ["5", "JKL"], ["6", "MNO"],
                        ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"],
                        ["*", ""], ["0", "+"], ["#", ""],
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
                  )}

                  {/* In-call control row */}
                  {inCall && (
                    <div className="mt-5 grid grid-cols-3 gap-3">
                      <CircleAction
                        active={muted}
                        onClick={() => softphoneRef.current?.toggleMute()}
                        icon={muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                        label={muted ? "Unmute" : "Mute"}
                      />
                      <CircleAction
                        active={showKeypad}
                        onClick={() => setShowKeypad((s) => !s)}
                        icon={<Grid3x3 className="h-5 w-5" />}
                        label="Keypad"
                      />
                      <CircleAction
                        active={held}
                        onClick={() => softphoneRef.current?.toggleHold()}
                        icon={held ? <Play className="h-5 w-5" /> : <Pause className="h-5 w-5" />}
                        label={held ? "Resume" : "Hold"}
                      />
                    </div>
                  )}

                  {/* Bottom action */}
                  <div className="mt-6 flex items-center justify-center gap-6">
                    {incoming ? (
                      <>
                        <button
                          onClick={rejectIncoming}
                          className="flex h-16 w-16 items-center justify-center rounded-full bg-red-600 text-white shadow-lg active:scale-95"
                          aria-label="Reject"
                        >
                          <PhoneOff className="h-7 w-7" />
                        </button>
                        <button
                          onClick={acceptIncoming}
                          className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg active:scale-95"
                          aria-label="Answer"
                        >
                          <Phone className="h-7 w-7" />
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={endCall}
                        className="flex h-16 w-16 items-center justify-center rounded-full bg-red-600 text-white shadow-lg active:scale-95"
                        aria-label="End call"
                      >
                        <PhoneOff className="h-7 w-7" />
                      </button>
                    )}
                  </div>
                </>
              );
            }

            // Idle dialer view
            return (
              <>
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
                    className="mt-3 w-full bg-transparent text-center text-3xl font-light tracking-wider text-white placeholder:text-neutral-600 focus:outline-none"
                  />
                  <div className="mt-1 h-4" />
                  {(outboundDids.data?.length ?? 0) > 0 && (
                    <div className="mt-2 flex items-center justify-center gap-2 text-[10px] uppercase tracking-wider text-neutral-400">
                      <span>Caller ID</span>
                      <select
                        className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-100 focus:outline-none"
                        value={outboundDidId}
                        onChange={(e) => setOutboundDidId(e.target.value)}
                      >
                        <option value="">
                          {outboundDids.data?.find((d: any) => d.is_default)?.phone_number ?? "default"}
                        </option>
                        {outboundDids.data?.map((d: any) => (
                          <option key={d.id} value={d.id}>
                            {d.phone_number}{d.label ? ` — ${d.label}` : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                {/* Keypad */}
                <div className="mt-4 grid grid-cols-3 gap-2">
                  {[
                    ["1", ""], ["2", "ABC"], ["3", "DEF"],
                    ["4", "GHI"], ["5", "JKL"], ["6", "MNO"],
                    ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"],
                    ["*", ""], ["0", "+"], ["#", ""],
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

                {/* Dial actions */}
                <div className="mt-5 grid grid-cols-[1fr_auto_1fr] items-center gap-4">
                  <button
                    type="button"
                    onClick={() => setPhone(DEFAULT_PHONE)}
                    className="justify-self-end text-xs text-neutral-400 hover:text-white"
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      console.log("[dial] click", { phone, state, pending: dial.isPending });
                      if (!phone) {
                        toast.error("Enter a number first");
                        return;
                      }
                      if (dial.isPending) return;
                      if (state !== "registered") {
                        toast.warning(`Softphone state: ${state}. Attempting call anyway…`);
                      }
                      dial.mutate();
                    }}
                    disabled={!phone || dial.isPending}
                    className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg transition active:scale-95 disabled:opacity-40"
                    aria-label="Call"
                  >
                    <Phone className="h-7 w-7" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setPhone((p) => (p.length > DEFAULT_PHONE.length ? p.slice(0, -1) : DEFAULT_PHONE))}
                    className="justify-self-start flex h-10 w-10 items-center justify-center rounded-full text-neutral-300 hover:bg-neutral-800 hover:text-white active:scale-95"
                    aria-label="Backspace"
                  >
                    <Delete className="h-5 w-5" />
                  </button>
                </div>
              </>
            );
          })()}
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



      <div className="lg:order-1">
        <ContactsPanel
          disabled={!!activeChannel}
          onPick={(p) => setPhone(p)}
        />
      </div>

      <section className="space-y-4 rounded-xl border bg-card p-5 lg:order-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Call notes</h2>
          {inCall && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600">Recording notes</span>}
        </div>
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

function CircleAction({ icon, label, onClick, active }: { icon: React.ReactNode; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-1.5 text-[10px] uppercase tracking-wider text-neutral-400 active:scale-95"
    >
      <span
        className={`flex h-14 w-14 items-center justify-center rounded-full ${active ? "bg-white text-neutral-900" : "bg-neutral-800 text-white"}`}
      >
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );
}

function StatChip({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5">
      <span className="text-muted-foreground">{icon}</span>
      <div className="leading-tight">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="text-sm font-semibold tabular-nums">{value}</div>
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
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Contacts</h2>
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
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search name or number"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="pl-8"
        />
      </div>
      <ul className="max-h-[320px] divide-y overflow-y-auto rounded-lg border lg:max-h-[520px]">
        {rows.map((c) => {
          const name = [c.first_name, c.last_name].filter(Boolean).join(" ") || "Unknown";
          const initials = name === "Unknown" ? "?" : name.split(" ").map((n) => n[0]).slice(0, 2).join("").toUpperCase();
          return (
            <li key={c.id} className="group flex items-center gap-3 px-3 py-2.5 text-sm transition hover:bg-muted/50">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                {initials}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{name}</div>
                <div className="truncate font-mono text-xs text-muted-foreground">{c.phone}</div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => onPick(c.phone)}
                className="opacity-70 group-hover:opacity-100"
              >
                <Phone className="mr-1 h-3.5 w-3.5" /> Dial
              </Button>
            </li>
          );
        })}
        {!rows.length && (
          <li className="px-3 py-6 text-center text-xs text-muted-foreground">
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

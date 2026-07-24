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
import { Mic, MicOff, Pause, Play, PhoneOff, Phone, Search, Clock, PhoneCall, CheckCircle2, Grid3x3, Delete, TrendingUp, Wifi, WifiOff, StickyNote } from "lucide-react";

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
  const [dialMessage, setDialMessage] = useState<string | null>(null);
  const [outboundDialing, setOutboundDialing] = useState(false);
  const [callProgress, setCallProgress] = useState<{ label: string; kind: "dialing" | "ringing" | "answered" | "failed" } | null>(null);
  const softphoneRef = useRef<Softphone | null>(null);
  const pendingOutboundRef = useRef(false);
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
        // If we just initiated an outbound originate, Asterisk calls the agent
        // endpoint first. Auto-answer it and keep the UI in outbound mode.
        if (pendingOutboundRef.current) {
          pendingOutboundRef.current = false;
          setIncoming(null);
          setOutboundDialing(true);
          return "auto-answer";
        }
        setIncoming(info);
        setOutboundDialing(false);
        toast.info(`Incoming call from ${info.displayName ?? info.from}`);
      },
      onEnded: () => {
        pendingOutboundRef.current = false;
        setOutboundDialing(false);
        setActiveChannel(null);
        setActiveCallId(null);
        setIncoming(null);
        setDialMessage(null);
        setShowKeypad(false);
        setCallStartedAt(null);
        setMuted(false);
        setHeld(false);
        setPhone(DEFAULT_PHONE);
        void qc.invalidateQueries({ queryKey: ["history"] });
        void qc.invalidateQueries({ queryKey: ["dialer-today"] });
      },
      onMuteChange: setMuted,
      onHoldChange: setHeld,
    });
    softphoneRef.current = sp;
    sp.register({ token: c.token, identity: c.identity });
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
      setOutboundDialing(false);
      pendingOutboundRef.current = false;
    }
    if (state === "in_call") {
      setOutboundDialing(false);
      if (!callStartedAt) setCallStartedAt(Date.now());
    }
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


  const testIncomingRef = useRef(false);
  const [testInCall, setTestInCall] = useState(false);
  const testRingRef = useRef<{ ctx: AudioContext; stop: () => void } | null>(null);
  const stopTestRing = useCallback(() => {
    testRingRef.current?.stop();
    testRingRef.current = null;
  }, []);
  const startTestRing = useCallback(() => {
    stopTestRing();
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      const master = ctx.createGain();
      master.gain.value = 0.18;
      master.connect(ctx.destination);
      // Pleasant marimba-style arpeggio: E6 G6 B6 E7, then pause, repeat
      const notes = [1318.5, 1568.0, 1975.5, 2637.0];
      const noteDur = 0.18;
      const patternDur = notes.length * noteDur + 1.2; // gap after pattern
      const playPattern = (startAt: number) => {
        notes.forEach((freq, i) => {
          const t = startAt + i * noteDur;
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.type = "triangle";
          osc.frequency.value = freq;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(0.9, t + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, t + noteDur);
          osc.connect(g);
          g.connect(master);
          osc.start(t);
          osc.stop(t + noteDur + 0.02);
        });
      };
      playPattern(ctx.currentTime + 0.05);
      const iv = window.setInterval(() => playPattern(ctx.currentTime + 0.02), patternDur * 1000);
      testRingRef.current = {
        ctx,
        stop: () => {
          clearInterval(iv);
          try { ctx.close(); } catch {}
        },
      };
    } catch {}
  }, [stopTestRing]);
  const simulateIncoming = useCallback(() => {
    testIncomingRef.current = true;
    setIncoming({ from: "+15558675309", displayName: "Test Caller" });
    setOutboundDialing(false);
    startTestRing();
    toast.info("Simulated incoming call — this is a UI preview only");
  }, [startTestRing]);
  const acceptIncoming = useCallback(() => {
    if (testIncomingRef.current) {
      stopTestRing();
      setTestInCall(true);
      setCallStartedAt(Date.now());
      toast.success("Test call connected");
      return;
    }
    softphoneRef.current?.answer();
    setIncoming(null);
  }, [stopTestRing]);
  const rejectIncoming = useCallback(() => {
    if (testIncomingRef.current) {
      testIncomingRef.current = false;
      stopTestRing();
      setTestInCall(false);
      setCallStartedAt(null);
      setIncoming(null);
      return;
    }
    softphoneRef.current?.reject();
    setIncoming(null);
  }, [stopTestRing]);

  type CallerInfo = {
    id?: string;
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
    notes?: string | null;
    list_name?: string | null;
    last_called_at?: string | null;
    matched: boolean;
  };
  const [callerInfo, setCallerInfo] = useState<CallerInfo | null>(null);
  useEffect(() => {
    if (!incoming) { setCallerInfo(null); return; }
    if (testIncomingRef.current) {
      setCallerInfo({
        first_name: "Test",
        last_name: "Caller",
        email: "test.caller@example.com",
        notes: "Simulated inbound call for UI preview.",
        list_name: "Preview",
        matched: true,
      });
      return;
    }
    let cancelled = false;
    const digits = (incoming.from || "").replace(/\D/g, "");
    const last10 = digits.slice(-10);
    if (!last10) { setCallerInfo({ matched: false }); return; }
    (async () => {
      const { data } = await supabase
        .from("contacts")
        .select("id, first_name, last_name, email, notes, phone, list_id, contact_lists(name)")
        .ilike("phone", `%${last10}`)
        .limit(1);
      if (cancelled) return;
      const row = (data ?? [])[0] as any;
      if (!row) { setCallerInfo({ matched: false }); return; }
      const { data: lastCall } = await supabase
        .from("calls")
        .select("created_at")
        .eq("customer_phone", row.phone)
        .order("created_at", { ascending: false })
        .limit(1);
      if (cancelled) return;
      setCallerInfo({
        id: row.id,
        first_name: row.first_name,
        last_name: row.last_name,
        email: row.email,
        notes: row.notes,
        list_name: row.contact_lists?.name ?? null,
        last_called_at: (lastCall ?? [])[0]?.created_at ?? null,
        matched: true,
      });
    })();
    return () => { cancelled = true; };
  }, [incoming]);


  const runWsProbe = useCallback(async () => {
    if (!creds.data || creds.data.provisioned === false) return;
    setWsProbe("Testing PBX WebSocket…");
    const result = await testSoftphoneWebSocket(creds.data.wssUrl);
    const suffix = result.code ? ` (close ${result.code}${result.reason ? `: ${result.reason}` : ""})` : "";
    setWsProbe(`${result.ok ? "OK" : "FAILED"}: ${result.message}${suffix}. Origin: ${result.origin}. URL: ${result.url}`);
  }, [creds.data]);


  const dial = useMutation({
    mutationFn: async () => {
      const r = await originate({ data: { customerPhone: phone, outboundDidId: outboundDidId || null } });
      await softphoneRef.current?.dialOut({ to: r.to, from: r.from, callId: r.callId });
      return r;
    },
    onMutate: () => {
      pendingOutboundRef.current = false; // Twilio outbound doesn't ring the agent leg
      setOutboundDialing(true);
      setIncoming(null);
      setDialMessage("Connecting to Twilio…");
      toast.info("Starting call…");
    },
    onSuccess: (r) => {
      setActiveCallId(r.callId);
      setActiveChannel(r.channelId);
      setValues({});
      setDialMessage(null);
      toast.success("Dialing…");
    },
    onError: (e: any) => {
      pendingOutboundRef.current = false;
      setOutboundDialing(false);
      const msg = e.message ?? "Call failed";
      setDialMessage(msg);
      toast.error(msg);
      console.error("[dial] originate failed", e);
    },
  });

  async function endCall() {
    pendingOutboundRef.current = false;
    setOutboundDialing(false);
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
    setIncoming(null);
    setDialMessage(null);
    setShowKeypad(false);
    setCallStartedAt(null);
    setMuted(false);
    setHeld(false);
    setPhone(DEFAULT_PHONE);
    setState((s) => (s === "failed" || s === "idle" ? s : "registered"));
    qc.invalidateQueries({ queryKey: ["history"] });
    qc.invalidateQueries({ queryKey: ["dialer-today"] });
  }

  const fmtDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  };

  const inCall = state === "in_call" || !!activeChannel;

  // Local ringback tone while we're waiting for the callee to pick up.
  // Keep playing until the SIP session is fully established (state === "in_call"),
  // NOT just when the agent leg auto-answers — otherwise there's silence between
  // agent-leg answer and Telnyx delivering ringback / early media.
  useEffect(() => {
    const sp = softphoneRef.current;
    if (!sp) return;
    const shouldRing = (outboundDialing || dial.isPending) && state !== "in_call" && !incoming;
    if (shouldRing) sp.startRingback();
    else sp.stopRingback();
  }, [outboundDialing, dial.isPending, state, incoming]);

  // Poll the call row so the UI reflects real PBX progress: dialing → ringing
  // customer → answered → ended (with disposition). Driven by AMI events
  // written to `calls` via the /api/public/asterisk-events webhook.
  useEffect(() => {
    if (!activeCallId || !outboundDialing) {
      setCallProgress(null);
      return;
    }
    setCallProgress({ label: "Dialing customer…", kind: "dialing" });
    let cancelled = false;
    const tick = async () => {
      const { data } = await supabase
        .from("calls")
        .select("status, disposition")
        .eq("id", activeCallId)
        .maybeSingle();
      if (cancelled || !data) return;
      const s = data.status as string | null;
      const disp = (data.disposition as string | null) ?? null;
      if (s === "dialing" || disp === "DIALING") setCallProgress({ label: "Dialing customer…", kind: "dialing" });
      else if (s === "ringing") setCallProgress({ label: "Ringing customer…", kind: "ringing" });
      else if (s === "answered") setCallProgress({ label: "Customer answered", kind: "answered" });
      else if (s === "ended" || s === "failed") {
        const nice =
          disp === "ANSWER" ? "Call ended"
          : disp === "BUSY" ? "Customer is busy"
          : disp === "NOANSWER" ? "No answer"
          : disp === "CONGESTION" ? "Network congestion"
          : disp === "CHANUNAVAIL" ? "Customer unreachable"
          : disp ? `Call failed (${disp})` : "Call did not connect";
        setCallProgress({ label: nice, kind: "failed" });
        setDialMessage(nice);
        // Do NOT force-hangup the softphone here — the Twilio SDK fires its
        // own `disconnect` event when the media leg actually ends, and that
        // drives onEnded/cleanup. Hanging up from a poller tick can cut a
        // live call if a webhook arrives out of order.
      }
    };
    void tick();
    const id = window.setInterval(tick, 1500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeCallId, outboundDialing]);




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
  const visibleStatusLabel = outboundDialing && !incoming
    ? state === "in_call"
      ? "In call"
      : "Calling…"
    : statusLabel[state];

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const agentName = creds.data?.provisioned ? `Ext ${creds.data.extension}` : "Agent";
  const answerRate = stats.count > 0 ? Math.round((stats.answered / stats.count) * 100) : 0;
  const online = state === "registered" || state === "in_call";

  return (
    <div className="space-y-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:space-y-6">
      {/* Hero header */}
      <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-primary/10 via-card to-card p-3 sm:p-6">
        <div className="absolute -right-16 -top-16 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 sm:flex sm:flex-wrap sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground sm:text-xs">{greeting}</div>
            <h1 className="truncate text-xl font-semibold tracking-tight sm:mt-0.5 sm:text-3xl">Welcome, {agentName}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 sm:mt-2 sm:gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium sm:px-2.5 sm:text-xs ${online ? "bg-emerald-500/15 text-emerald-600" : "bg-red-500/15 text-red-600"}`}>
                {online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                {visibleStatusLabel}
              </span>
              {inCall && phone && (
                <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] sm:px-2.5 sm:text-xs">{phone}</span>
              )}
            </div>
          </div>
          <div className="col-span-2 grid w-full grid-cols-4 gap-1.5 sm:w-auto sm:grid-cols-4 sm:gap-3">
            <StatChip icon={<PhoneCall className="h-4 w-4" />} label="Calls" value={String(stats.count)} tone="primary" />
            <StatChip icon={<CheckCircle2 className="h-4 w-4" />} label="Ans" value={String(stats.answered)} tone="emerald" />
            <StatChip icon={<Clock className="h-4 w-4" />} label="Talk" value={fmtDuration(stats.talkSec)} tone="sky" />
            <StatChip icon={<TrendingUp className="h-4 w-4" />} label="Rate" value={`${answerRate}%`} tone="amber" />
          </div>
        </div>
      </div>


    <div className="grid gap-4 sm:gap-6 lg:grid-cols-[280px_360px_1fr]">
      <section className="mx-auto w-full max-w-[380px] space-y-4 lg:order-2">

        {/* Incoming caller card */}
        {incoming && (
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4 shadow-sm">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-600">Incoming call</p>
            </div>
            {callerInfo?.matched ? (
              <div className="mt-2 space-y-1.5">
                <p className="text-base font-semibold leading-tight">
                  {[callerInfo.first_name, callerInfo.last_name].filter(Boolean).join(" ") || "Contact"}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">{incoming.from}</p>
                {callerInfo.email && (
                  <p className="text-xs text-muted-foreground truncate">{callerInfo.email}</p>
                )}
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {callerInfo.list_name && (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                      {callerInfo.list_name}
                    </span>
                  )}
                  {callerInfo.last_called_at && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                      Last call {new Date(callerInfo.last_called_at).toLocaleDateString()}
                    </span>
                  )}
                </div>
                {callerInfo.notes && (
                  <p className="mt-1 line-clamp-3 rounded-md bg-background/60 p-2 text-xs text-muted-foreground">
                    {callerInfo.notes}
                  </p>
                )}
              </div>
            ) : (
              <div className="mt-2">
                <p className="text-base font-semibold leading-tight">Unknown caller</p>
                <p className="text-xs text-muted-foreground tabular-nums">{incoming.from}</p>
                <p className="mt-1 text-xs text-muted-foreground">No matching contact in CRM.</p>
              </div>
            )}
          </div>
        )}

        {/* Handset */}
        <div className="rounded-[2.5rem] border border-neutral-800 bg-neutral-900 p-4 shadow-2xl">
          {(() => {
            const callView = incoming || inCall || state === "calling" || dial.isPending || outboundDialing;
            const elapsedSec = callStartedAt ? Math.floor((Date.now() - callStartedAt) / 1000) : 0;
            void nowTick;
            const callStatusText = incoming
              ? "Incoming call"
              : state === "in_call"
                ? held ? "On hold" : "Connected"
                : callProgress?.label ?? "Calling…";

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
                      {state === "in_call"
                        ? fmtDuration(elapsedSec)
                        : incoming
                          ? "Ringing…"
                          : callProgress?.kind === "ringing"
                            ? "Ringing customer"
                            : callProgress?.kind === "failed"
                              ? "Ending…"
                              : "Dialing…"}
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
                  {dialMessage && (
                    <div className="mx-auto mt-2 max-w-[280px] break-words rounded-lg bg-neutral-800 px-3 py-2 text-center text-[11px] leading-snug text-neutral-300">
                      {dialMessage}
                    </div>
                  )}
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
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={runWsProbe}>
                Test PBX WebSocket
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={simulateIncoming} disabled={!!incoming || !!activeChannel}>
                Simulate inbound call
              </Button>
            </div>
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

      <section className="space-y-4 rounded-2xl border bg-card p-3 shadow-sm sm:p-5 lg:order-3">
        <div className="flex items-center justify-between border-b pb-3">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <StickyNote className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">Call notes</h2>
              <p className="text-xs text-muted-foreground">Capture details during the call</p>
            </div>
          </div>
          {inCall && <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />Live</span>}
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

function StatChip({ icon, label, value, tone = "primary" }: { icon: React.ReactNode; label: string; value: string; tone?: "primary" | "emerald" | "sky" | "amber" }) {
  const toneMap: Record<string, string> = {
    primary: "bg-primary/10 text-primary",
    emerald: "bg-emerald-500/10 text-emerald-600",
    sky: "bg-sky-500/10 text-sky-600",
    amber: "bg-amber-500/10 text-amber-600",
  };
  return (
    <div className="flex items-center gap-1.5 rounded-lg border bg-card/80 px-1.5 py-1.5 backdrop-blur sm:gap-2.5 sm:rounded-xl sm:px-3 sm:py-2">
      <span className={`hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg sm:flex ${toneMap[tone]}`}>{icon}</span>
      <div className="min-w-0 leading-tight">
        <div className="truncate text-[9px] font-medium uppercase tracking-wider text-muted-foreground sm:text-[10px]">{label}</div>
        <div className="truncate text-sm font-semibold tabular-nums sm:text-base">{value}</div>
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
    <section className="space-y-3 rounded-2xl border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between border-b pb-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Phone className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Contacts</h2>
            <p className="text-xs text-muted-foreground">{rows.length} shown</p>
          </div>
        </div>
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

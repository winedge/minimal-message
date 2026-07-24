import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useRole } from "@/hooks/use-role";
import { Button } from "@/components/ui/button";
import { bargeCall, spyCall, whisperCall } from "@/lib/admin-spy.functions";
import { toast } from "sonner";
import { Ear, MessageSquare, PhoneCall } from "lucide-react";

type Status = {
  user_id: string;
  state: "offline" | "available" | "on_call";
  current_call_id: string | null;
  updated_at: string;
};
type Profile = { id: string; full_name: string | null };
type Sip = { user_id: string; extension: string };
type Call = {
  id: string;
  agent_id: string | null;
  customer_phone: string;
  started_at: string;
  answered_at: string | null;
  status: string;
};

export const Route = createFileRoute("/_authenticated/admin/live")({
  head: () => ({ meta: [{ title: "Admin — Live" }] }),
  component: LivePage,
});

function LivePage() {
  const { role } = useRole();
  const spy = useServerFn(spyCall);
  const whisper = useServerFn(whisperCall);
  const barge = useServerFn(bargeCall);

  const [statuses, setStatuses] = useState<Status[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [sips, setSips] = useState<Sip[]>([]);
  const [liveCalls, setLiveCalls] = useState<Call[]>([]);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (role !== "admin") return;
    let alive = true;
    async function loadAll() {
      const [{ data: st }, { data: pr }, { data: sp }, { data: ca }] = await Promise.all([
        supabase.from("agent_status").select("*"),
        supabase.from("profiles").select("id, full_name"),
        supabase.from("sip_endpoints").select("user_id, extension"),
        supabase
          .from("calls")
          .select("id, agent_id, customer_phone, started_at, answered_at, status")
          .in("status", ["ringing", "answered"])
          .order("started_at", { ascending: false }),
      ]);
      if (!alive) return;
      setStatuses((st ?? []) as Status[]);
      setProfiles((pr ?? []) as Profile[]);
      setSips((sp ?? []) as Sip[]);
      setLiveCalls((ca ?? []) as Call[]);
    }
    loadAll();
    const ch = supabase
      .channel("live-admin")
      .on("postgres_changes", { event: "*", schema: "public", table: "agent_status" }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "calls" }, loadAll)
      .subscribe();
    const refresh = window.setInterval(loadAll, 5_000);
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      supabase.removeChannel(ch);
      clearInterval(refresh);
      clearInterval(t);
    };
  }, [role]);

  if (role !== "admin") return <p className="text-sm">Admin only.</p>;

  const nameOf = (id: string) =>
    profiles.find((p) => p.id === id)?.full_name || id.slice(0, 8);
  const extOf = (id: string) => sips.find((s) => s.user_id === id)?.extension ?? "—";
  const callFor = (uid: string) => liveCalls.find((c) => c.agent_id === uid) ?? null;

  const fmtDuration = (startIso: string) => {
    const s = Math.max(0, Math.floor((now - new Date(startIso).getTime()) / 1000));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  };

  const doAction = async (fn: (a: { data: { agentId: string } }) => Promise<any>, agentId: string, label: string) => {
    try {
      await fn({ data: { agentId } });
      toast.success(`${label} started`);
    } catch (e: any) {
      toast.error(e.message ?? "Failed");
    }
  };

  const stateColor: Record<Status["state"], string> = {
    on_call: "bg-red-500/15 text-red-600",
    available: "bg-emerald-500/15 text-emerald-600",
    offline: "bg-muted text-muted-foreground",
  };

  // Treat stale heartbeats (>60s) as offline — logout/tab-close doesn't always update state.
  const STALE_MS = 60_000;
  const effectiveState = (s: Status): Status["state"] => {
    const age = now - new Date(s.updated_at).getTime();
    if (s.state !== "offline" && age > STALE_MS) return "offline";
    return s.state;
  };

  const displayed = statuses.map((s) => ({ ...s, state: effectiveState(s) }));

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Live agent status</h1>
        <p className="text-xs text-muted-foreground">
          {displayed.filter((s) => s.state !== "offline").length} online · {liveCalls.length} active calls
        </p>
      </div>


      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {statuses.map((s) => {
          const call = callFor(s.user_id);
          const onCall = s.state === "on_call" && !!call;
          return (
            <div key={s.user_id} className="rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{nameOf(s.user_id)}</div>
                  <div className="text-xs text-muted-foreground">ext {extOf(s.user_id)}</div>
                </div>
                <span className={`rounded px-2 py-0.5 text-xs uppercase ${stateColor[s.state]}`}>
                  {s.state.replace("_", " ")}
                </span>
              </div>

              {call ? (
                <div className="mt-3 rounded bg-muted/40 p-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-mono">{call.customer_phone}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {fmtDuration(call.answered_at ?? call.started_at)}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {call.status === "answered" ? "In call" : "Ringing"}
                  </div>
                </div>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">
                  Last update {new Date(s.updated_at).toLocaleTimeString()}
                </p>
              )}

              <div className="mt-3 grid grid-cols-3 gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!onCall}
                  onClick={() => doAction(spy, s.user_id, "Listen")}
                >
                  <Ear className="mr-1 h-3.5 w-3.5" /> Listen
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!onCall}
                  onClick={() => doAction(whisper, s.user_id, "Whisper")}
                >
                  <MessageSquare className="mr-1 h-3.5 w-3.5" /> Whisper
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!onCall}
                  onClick={() => doAction(barge, s.user_id, "Barge")}
                >
                  <PhoneCall className="mr-1 h-3.5 w-3.5" /> Barge
                </Button>
              </div>
            </div>
          );
        })}
        {!statuses.length && (
          <p className="text-sm text-muted-foreground">No agents online.</p>
        )}
      </div>
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useRole } from "@/hooks/use-role";

type Row = { user_id: string; state: string; current_call_id: string | null; updated_at: string; full_name?: string };

export const Route = createFileRoute("/_authenticated/admin/live")({
  head: () => ({ meta: [{ title: "Admin — Live" }] }),
  component: LivePage,
});

function LivePage() {
  const { role } = useRole();
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    if (role !== "admin") return;
    async function load() {
      const { data: status } = await supabase.from("agent_status").select("*");
      const { data: profiles } = await supabase.from("profiles").select("id, full_name");
      const merged = (status ?? []).map((s: any) => ({
        ...s,
        full_name: profiles?.find((p: any) => p.id === s.user_id)?.full_name ?? "",
      }));
      setRows(merged);
    }
    load();
    const ch = supabase
      .channel("agent_status")
      .on("postgres_changes", { event: "*", schema: "public", table: "agent_status" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "calls" }, load)
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [role]);

  if (role !== "admin") return <p className="text-sm">Admin only.</p>;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Live agent status</h1>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((r) => (
          <div key={r.user_id} className="rounded border p-4">
            <div className="flex items-center justify-between">
              <div className="font-medium">{r.full_name || r.user_id.slice(0, 8)}</div>
              <span
                className={
                  r.state === "on_call"
                    ? "rounded bg-red-500/20 px-2 py-0.5 text-xs text-red-600"
                    : r.state === "available"
                      ? "rounded bg-green-500/20 px-2 py-0.5 text-xs text-green-600"
                      : "rounded bg-muted px-2 py-0.5 text-xs"
                }
              >
                {r.state}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Updated {new Date(r.updated_at).toLocaleTimeString()}
            </p>
          </div>
        ))}
        {!rows.length && <p className="text-sm text-muted-foreground">No agents online.</p>}
      </div>
    </div>
  );
}

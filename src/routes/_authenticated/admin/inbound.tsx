import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useRole } from "@/hooks/use-role";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteInboundRoute, upsertInboundRoute } from "@/lib/inbound.functions";
import { listTelnyxNumbers } from "@/lib/telnyx.functions";
import { listTwilioNumbers, syncTwilioWebhooks } from "@/lib/twilio.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/admin/inbound")({
  head: () => ({ meta: [{ title: "Admin — Inbound" }] }),
  component: InboundPage,
});

type Route = {
  id: string;
  did: string;
  strategy: "direct" | "roundrobin";
  target_user_id: string | null;
  ring_group: string[];
  ring_seconds: number;
  fallback_extension: string | null;
};
type Agent = { id: string; full_name: string | null };

function InboundPage() {
  const { role } = useRole();
  const qc = useQueryClient();
  const upsert = useServerFn(upsertInboundRoute);
  const remove = useServerFn(deleteInboundRoute);
  const fetchTelnyx = useServerFn(listTelnyxNumbers);
  const fetchTwilio = useServerFn(listTwilioNumbers);
  const syncHooks = useServerFn(syncTwilioWebhooks);

  const [editing, setEditing] = useState<Partial<Route> | null>(null);
  const [source, setSource] = useState<"twilio" | "telnyx">("twilio");

  const routes = useQuery({
    queryKey: ["inbound_routes"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("inbound_routes")
        .select("*")
        .order("did");
      if (error) throw error;
      return (data ?? []) as Route[];
    },
  });

  const agents = useQuery({
    queryKey: ["agents-all"],
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("id, full_name");
      if (error) throw error;
      return (data ?? []) as Agent[];
    },
  });

  const telnyxNumbers = useQuery({
    queryKey: ["telnyx-numbers"],
    queryFn: () => fetchTelnyx(),
    enabled: source === "telnyx",
    staleTime: 60_000,
    retry: false,
  });

  const twilioNumbers = useQuery({
    queryKey: ["twilio-numbers"],
    queryFn: () => fetchTwilio(),
    enabled: source === "twilio",
    staleTime: 60_000,
    retry: false,
  });

  const providerQuery = source === "twilio" ? twilioNumbers : telnyxNumbers;

  const syncWebhooks = useMutation({
    mutationFn: async () => syncHooks({ data: {} }),
    onSuccess: (r: any) => {
      const failed = r?.failed?.length ?? 0;
      if (failed > 0) toast.warning(`Updated ${r.updated} number(s); ${failed} failed`);
      else toast.success(`Synced inbound webhooks on ${r.updated} Twilio number(s)`);
      twilioNumbers.refetch();
    },
    onError: (e: any) => toast.error(e.message ?? "Failed to sync webhooks"),
  });

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!editing) return;
      await upsert({
        data: {
          id: editing.id,
          route: {
            did: editing.did ?? "",
            strategy: (editing.strategy ?? "direct") as "direct" | "roundrobin",
            target_user_id: editing.target_user_id ?? null,
            ring_group: editing.ring_group ?? [],
            ring_seconds: editing.ring_seconds ?? 20,
            fallback_extension: editing.fallback_extension ?? null,
          },
        },
      });
    },
    onSuccess: () => {
      toast.success("Saved");
      setEditing(null);
      qc.invalidateQueries({ queryKey: ["inbound_routes"] });
    },
    onError: (e: any) => toast.error(e.message ?? "Failed"),
  });

  if (role !== "admin") return <p className="text-sm">Admin only.</p>;

  const startNew = () =>
    setEditing({
      did: "",
      strategy: "direct",
      target_user_id: null,
      ring_group: [],
      ring_seconds: 20,
      fallback_extension: "",
    });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Inbound routing</h1>
        <Button size="sm" onClick={startNew}>Add DID</Button>
      </div>

      <div className="rounded border">
        <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-sm">
          <thead className="bg-muted text-left">
            <tr>
              <th className="px-3 py-2">DID</th>
              <th className="px-3 py-2">Strategy</th>
              <th className="px-3 py-2">Target(s)</th>
              <th className="px-3 py-2">Ring (s)</th>
              <th className="px-3 py-2">Fallback ext</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {(routes.data ?? []).map((r) => {
              const names = (ids: string[] | null) =>
                (ids ?? [])
                  .map((id) => agents.data?.find((a) => a.id === id)?.full_name ?? id.slice(0, 6))
                  .join(", ");
              return (
                <tr key={r.id} className="border-t">
                  <td className="px-3 py-2 font-mono">{r.did}</td>
                  <td className="px-3 py-2">{r.strategy}</td>
                  <td className="px-3 py-2">
                    {r.strategy === "direct"
                      ? names(r.target_user_id ? [r.target_user_id] : [])
                      : names(r.ring_group)}
                  </td>
                  <td className="px-3 py-2">{r.ring_seconds}</td>
                  <td className="px-3 py-2">{r.fallback_extension ?? "—"}</td>
                  <td className="space-x-2 px-3 py-2 text-right">
                    <button
                      className="text-xs hover:underline"
                      onClick={() => setEditing(r)}
                    >
                      Edit
                    </button>
                    <button
                      className="text-xs text-destructive hover:underline"
                      onClick={async () => {
                        if (!confirm(`Delete route for ${r.did}?`)) return;
                        await remove({ data: { id: r.id } });
                        qc.invalidateQueries({ queryKey: ["inbound_routes"] });
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
            {!routes.data?.length && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No inbound routes configured.
                </td>
              </tr>
            )}
          </tbody>
        </table></div>
      </div>

      {editing && (
        <form
          className="space-y-4 rounded border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            saveMut.mutate();
          }}
        >
          <h2 className="font-semibold">{editing.id ? "Edit route" : "New route"}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>DID (from Telnyx)</Label>
              {telnyxNumbers.isLoading ? (
                <div className="rounded-md border bg-muted px-2 py-2 text-sm text-muted-foreground">
                  Loading Telnyx numbers…
                </div>
              ) : telnyxNumbers.error || !(telnyxNumbers.data ?? []).length ? (
                <>
                  <Input
                    placeholder="+15551234567"
                    value={editing.did ?? ""}
                    onChange={(e) => setEditing({ ...editing, did: e.target.value })}
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    No Telnyx numbers available — enter the DID manually.
                  </p>
                </>
              ) : (
                <select
                  className="w-full rounded-md border bg-background px-2 py-2 text-sm"
                  value={editing.did ?? ""}
                  onChange={(e) => setEditing({ ...editing, did: e.target.value })}
                  required
                >
                  <option value="">— choose number —</option>
                  {/* keep current value visible even if not in list (e.g. released number) */}
                  {editing.did &&
                    !(telnyxNumbers.data ?? []).some((n) => n.phone_number === editing.did) && (
                      <option value={editing.did}>{editing.did} (not in Telnyx)</option>
                    )}
                  {(telnyxNumbers.data ?? []).map((n) => (
                    <option key={n.phone_number} value={n.phone_number}>
                      {n.phone_number}
                      {n.tag ? ` — ${n.tag}` : ""}
                      {n.status && n.status !== "active" ? ` (${n.status})` : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="space-y-1">
              <Label>Strategy</Label>
              <select
                className="w-full rounded-md border bg-background px-2 py-2 text-sm"
                value={editing.strategy ?? "direct"}
                onChange={(e) =>
                  setEditing({ ...editing, strategy: e.target.value as "direct" | "roundrobin" })
                }
              >
                <option value="direct">Direct (ring one agent)</option>
                <option value="roundrobin">Round-robin (ring group)</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label>Ring seconds</Label>
              <Input
                type="number"
                min={5}
                max={120}
                value={editing.ring_seconds ?? 20}
                onChange={(e) =>
                  setEditing({ ...editing, ring_seconds: Number(e.target.value) })
                }
              />
            </div>
            <div className="space-y-1">
              <Label>Fallback extension (optional)</Label>
              <Input
                placeholder="e.g. voicemail@default or another ext"
                value={editing.fallback_extension ?? ""}
                onChange={(e) => setEditing({ ...editing, fallback_extension: e.target.value })}
              />
            </div>
          </div>

          {editing.strategy === "direct" ? (
            <div className="space-y-1">
              <Label>Target agent</Label>
              <select
                className="w-full rounded-md border bg-background px-2 py-2 text-sm"
                value={editing.target_user_id ?? ""}
                onChange={(e) =>
                  setEditing({ ...editing, target_user_id: e.target.value || null })
                }
              >
                <option value="">— choose agent —</option>
                {(agents.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>{a.full_name || a.id.slice(0, 8)}</option>
                ))}
              </select>
            </div>
          ) : (
            <div className="space-y-1">
              <Label>Ring group (round-robin, in order)</Label>
              <div className="grid gap-1 sm:grid-cols-2">
                {(agents.data ?? []).map((a) => {
                  const checked = editing.ring_group?.includes(a.id) ?? false;
                  return (
                    <label key={a.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const cur = editing.ring_group ?? [];
                          setEditing({
                            ...editing,
                            ring_group: e.target.checked
                              ? [...cur, a.id]
                              : cur.filter((id) => id !== a.id),
                          });
                        }}
                      />
                      {a.full_name || a.id.slice(0, 8)}
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <Button type="submit" disabled={saveMut.isPending}>
              {saveMut.isPending ? "Saving…" : "Save"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

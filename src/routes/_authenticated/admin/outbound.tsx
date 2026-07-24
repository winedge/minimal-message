import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useRole } from "@/hooks/use-role";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { listTelnyxNumbers } from "@/lib/telnyx.functions";
import { listTwilioNumbers, syncTwilioWebhooks, syncTwilioTwimlApp } from "@/lib/twilio.functions";
import { upsertOutboundDid, deleteOutboundDid } from "@/lib/outbound.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/admin/outbound")({
  head: () => ({ meta: [{ title: "Admin — Outbound DIDs" }] }),
  component: OutboundPage,
});

type DID = { id: string; phone_number: string; label: string | null; is_default: boolean };

function OutboundPage() {
  const { role } = useRole();
  const qc = useQueryClient();
  const upsert = useServerFn(upsertOutboundDid);
  const remove = useServerFn(deleteOutboundDid);
  const fetchTelnyx = useServerFn(listTelnyxNumbers);
  const fetchTwilio = useServerFn(listTwilioNumbers);
  const syncHooks = useServerFn(syncTwilioWebhooks);

  const [selected, setSelected] = useState("");
  const [label, setLabel] = useState("");
  const [source, setSource] = useState<"telnyx" | "twilio">("twilio");

  const dids = useQuery({
    queryKey: ["outbound_dids"],
    queryFn: async () => {
      const { data, error } = await supabase.from("outbound_dids").select("*").order("phone_number");
      if (error) throw error;
      return (data ?? []) as DID[];
    },
  });

  const telnyx = useQuery({
    queryKey: ["telnyx-numbers"],
    queryFn: () => fetchTelnyx(),
    enabled: role === "admin" && source === "telnyx",
    retry: false,
  });

  const twilio = useQuery({
    queryKey: ["twilio-numbers"],
    queryFn: () => fetchTwilio(),
    enabled: role === "admin" && source === "twilio",
    retry: false,
  });

  const providerQuery = source === "twilio" ? twilio : telnyx;

  const available = useMemo(() => {
    const owned = new Set((dids.data ?? []).map((d) => d.phone_number));
    return (providerQuery.data ?? []).filter((n: any) => !owned.has(n.phone_number));
  }, [providerQuery.data, dids.data]);

  const add = useMutation({
    mutationFn: async () =>
      upsert({ data: { phone_number: selected, label: label || null } }),
    onSuccess: () => {
      setSelected(""); setLabel("");
      qc.invalidateQueries({ queryKey: ["outbound_dids"] });
      toast.success("DID added");
    },
    onError: (e: any) => toast.error(e.message ?? "Failed"),
  });

  const setDefault = useMutation({
    mutationFn: async (d: DID) =>
      upsert({ data: { id: d.id, phone_number: d.phone_number, label: d.label, is_default: true } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["outbound_dids"] }),
    onError: (e: any) => toast.error(e.message ?? "Failed"),
  });

  const del = useMutation({
    mutationFn: async (id: string) => remove({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["outbound_dids"] }),
    onError: (e: any) => toast.error(e.message ?? "Failed"),
  });

  const syncWebhooks = useMutation({
    mutationFn: async () => syncHooks({ data: {} }),
    onSuccess: (r: any) => {
      const failed = r?.failed?.length ?? 0;
      if (failed > 0) {
        toast.warning(`Updated ${r.updated} number(s); ${failed} failed`);
      } else {
        toast.success(`Synced webhooks on ${r.updated} Twilio number(s)`);
      }
      twilio.refetch();
    },
    onError: (e: any) => toast.error(e.message ?? "Failed to sync webhooks"),
  });

  if (role !== "admin") return <div>Admin only.</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Outbound Caller IDs</h1>
        <p className="text-sm text-muted-foreground">
          Numbers agents can present as Caller ID on outbound calls. Sync from Twilio or Telnyx.
        </p>
      </div>

      <div className="rounded border p-4 space-y-3">
        <h2 className="font-medium">Add DID</h2>
        <div className="flex items-center gap-2">
          <Label className="text-xs">Source:</Label>
          <div className="inline-flex rounded border overflow-hidden">
            <button
              type="button"
              className={`px-3 py-1 text-xs ${source === "twilio" ? "bg-primary text-primary-foreground" : "bg-background"}`}
              onClick={() => { setSource("twilio"); setSelected(""); }}
            >
              Twilio
            </button>
            <button
              type="button"
              className={`px-3 py-1 text-xs ${source === "telnyx" ? "bg-primary text-primary-foreground" : "bg-background"}`}
              onClick={() => { setSource("telnyx"); setSelected(""); }}
            >
              Telnyx
            </button>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => providerQuery.refetch()}
            disabled={providerQuery.isFetching}
          >
            {providerQuery.isFetching ? "Syncing…" : "Sync numbers"}
          </Button>
          {source === "twilio" && (
            <Button
              size="sm"
              onClick={() => syncWebhooks.mutate()}
              disabled={syncWebhooks.isPending}
              title="Set VoiceUrl + StatusCallback on every Twilio number to this app's inbound webhooks"
            >
              {syncWebhooks.isPending ? "Configuring…" : "Sync webhooks to Twilio"}
            </Button>
          )}
        </div>
        <div className="grid gap-3 md:grid-cols-[2fr_2fr_auto]">
          <div>
            <Label>{source === "twilio" ? "Twilio number" : "Telnyx number"}</Label>
            <select
              className="w-full rounded border bg-background px-2 py-2 text-sm"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">
                {providerQuery.isLoading
                  ? "Loading…"
                  : providerQuery.error
                    ? `${source === "twilio" ? "Twilio" : "Telnyx"} unavailable — type below`
                    : "Choose number"}
              </option>
              {available.map((n: any) => (
                <option key={n.phone_number} value={n.phone_number}>
                  {n.phone_number} {n.tag ? `— ${n.tag}` : ""}
                </option>
              ))}
            </select>
            <Input
              className="mt-2"
              placeholder="or enter manually (+14155551234)"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            />
          </div>
          <div>
            <Label>Label (optional)</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Sales line" />
          </div>
          <div className="flex items-end">
            <Button onClick={() => add.mutate()} disabled={!selected || add.isPending}>
              {add.isPending ? "Saving…" : "Add"}
            </Button>
          </div>
        </div>
      </div>

      <div className="rounded border">
        <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="p-2">Number</th>
              <th className="p-2">Label</th>
              <th className="p-2">Default</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {(dids.data ?? []).map((d) => (
              <tr key={d.id} className="border-t">
                <td className="p-2 font-mono">{d.phone_number}</td>
                <td className="p-2">{d.label ?? "—"}</td>
                <td className="p-2">
                  {d.is_default ? (
                    <span className="rounded bg-primary/10 px-2 py-0.5 text-xs">DEFAULT</span>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => setDefault.mutate(d)}>
                      Make default
                    </Button>
                  )}
                </td>
                <td className="p-2 text-right">
                  <Button size="sm" variant="ghost" onClick={() => del.mutate(d.id)}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
            {(dids.data ?? []).length === 0 && (
              <tr>
                <td colSpan={4} className="p-4 text-center text-muted-foreground">
                  No outbound DIDs yet. Add one above.
                </td>
              </tr>
            )}
          </tbody>
        </table></div>
      </div>
    </div>
  );
}

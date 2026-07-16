import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { upsertField, deleteField } from "@/lib/admin.functions";
import { useRole } from "@/hooks/use-role";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_authenticated/admin/fields")({
  head: () => ({ meta: [{ title: "Admin — CRM fields" }] }),
  component: FieldsPage,
});

const TYPES = ["text", "textarea", "number", "select", "date", "checkbox"] as const;

function FieldsPage() {
  const { role } = useRole();
  const qc = useQueryClient();
  const upsert = useServerFn(upsertField);
  const del = useServerFn(deleteField);

  const q = useQuery({
    queryKey: ["field-defs-admin"],
    queryFn: async () => {
      const { data, error } = await supabase.from("crm_field_defs").select("*").order("sort_order");
      if (error) throw error;
      return data;
    },
    enabled: role === "admin",
  });

  const [form, setForm] = useState({
    key: "",
    label: "",
    type: "text" as (typeof TYPES)[number],
    optionsText: "",
    sort_order: 0,
    required: false,
  });

  const save = useMutation({
    mutationFn: async () =>
      upsert({
        data: {
          field: {
            key: form.key,
            label: form.label,
            type: form.type,
            options:
              form.type === "select"
                ? form.optionsText.split(",").map((s) => s.trim()).filter(Boolean)
                : undefined,
            sort_order: Number(form.sort_order) || 0,
            required: form.required,
          },
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["field-defs-admin"] });
      qc.invalidateQueries({ queryKey: ["field-defs"] });
      toast.success("Field saved");
      setForm({ key: "", label: "", type: "text", optionsText: "", sort_order: 0, required: false });
    },
    onError: (e: any) => toast.error(e.message ?? "Failed"),
  });

  if (role !== "admin") return <p className="text-sm">Admin only.</p>;

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      <section className="space-y-3 rounded border p-4">
        <h2 className="font-semibold">Add field</h2>
        <div className="space-y-1">
          <Label>Key (machine name)</Label>
          <Input value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="e.g. disposition" />
        </div>
        <div className="space-y-1">
          <Label>Label</Label>
          <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label>Type</Label>
          <select
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value as any })}
          >
            {TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>
        {form.type === "select" && (
          <div className="space-y-1">
            <Label>Options (comma separated)</Label>
            <Input value={form.optionsText} onChange={(e) => setForm({ ...form, optionsText: e.target.value })} />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>Order</Label>
            <Input
              type="number"
              value={form.sort_order}
              onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })}
            />
          </div>
          <label className="mt-6 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.required}
              onChange={(e) => setForm({ ...form, required: e.target.checked })}
            />
            Required
          </label>
        </div>
        <Button onClick={() => save.mutate()} disabled={save.isPending} className="w-full">
          {save.isPending ? "Saving…" : "Add field"}
        </Button>
      </section>

      <section className="rounded border">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left">
            <tr>
              <th className="p-2">Order</th>
              <th className="p-2">Key</th>
              <th className="p-2">Label</th>
              <th className="p-2">Type</th>
              <th className="p-2">Required</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((f: any) => (
              <tr key={f.id} className="border-t">
                <td className="p-2">{f.sort_order}</td>
                <td className="p-2"><code>{f.key}</code></td>
                <td className="p-2">{f.label}</td>
                <td className="p-2">{f.type}</td>
                <td className="p-2">{f.required ? "yes" : "no"}</td>
                <td className="p-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={async () => {
                      if (!confirm("Delete this field?")) return;
                      await del({ data: { id: f.id } });
                      qc.invalidateQueries({ queryKey: ["field-defs-admin"] });
                      qc.invalidateQueries({ queryKey: ["field-defs"] });
                    }}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

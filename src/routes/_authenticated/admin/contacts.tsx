import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import Papa from "papaparse";
import { supabase } from "@/integrations/supabase/client";
import { useRole } from "@/hooks/use-role";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  bulkImportContacts,
  createList,
  deleteContact,
  deleteList,
} from "@/lib/contacts.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/admin/contacts")({
  head: () => ({ meta: [{ title: "Admin — Contacts" }] }),
  component: ContactsAdminPage,
});

type List = { id: string; name: string };
type Contact = {
  id: string;
  list_id: string | null;
  phone: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  notes: string | null;
};

const FIELDS = ["phone", "first_name", "last_name", "email", "notes"] as const;
type Field = (typeof FIELDS)[number];

function ContactsAdminPage() {
  const { role } = useRole();
  const qc = useQueryClient();
  const create = useServerFn(createList);
  const drop = useServerFn(deleteList);
  const imp = useServerFn(bulkImportContacts);
  const delContact = useServerFn(deleteContact);

  const [selected, setSelected] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<Field, string>>({
    phone: "",
    first_name: "",
    last_name: "",
    email: "",
    notes: "",
  });
  const fileRef = useRef<HTMLInputElement | null>(null);

  const lists = useQuery({
    queryKey: ["contact_lists"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contact_lists")
        .select("id, name")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as List[];
    },
  });

  const contacts = useQuery({
    enabled: !!selected,
    queryKey: ["contacts", selected],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contacts")
        .select("id, list_id, phone, first_name, last_name, email, notes")
        .eq("list_id", selected)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as Contact[];
    },
  });

  const createMut = useMutation({
    mutationFn: async () => create({ data: { name: newName } }),
    onSuccess: (row) => {
      setNewName("");
      qc.invalidateQueries({ queryKey: ["contact_lists"] });
      setSelected(row.id);
    },
    onError: (e: any) => toast.error(e.message ?? "Failed"),
  });

  const dropMut = useMutation({
    mutationFn: async (id: string) => drop({ data: { id } }),
    onSuccess: () => {
      setSelected(null);
      qc.invalidateQueries({ queryKey: ["contact_lists"] });
    },
  });

  const importMut = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("Pick a list first");
      if (!mapping.phone) throw new Error("Map the phone column");
      const rows = csvRows.map((r) => ({
        phone: r[mapping.phone]?.toString().trim() ?? "",
        first_name: mapping.first_name ? r[mapping.first_name] : undefined,
        last_name: mapping.last_name ? r[mapping.last_name] : undefined,
        email: mapping.email ? r[mapping.email] : undefined,
        notes: mapping.notes ? r[mapping.notes] : undefined,
      })).filter((r) => r.phone.length >= 3);
      return imp({ data: { listId: selected, rows } });
    },
    onSuccess: (r) => {
      toast.success(`Imported ${r.inserted} contacts`);
      setCsvHeaders([]);
      setCsvRows([]);
      if (fileRef.current) fileRef.current.value = "";
      qc.invalidateQueries({ queryKey: ["contacts", selected] });
    },
    onError: (e: any) => toast.error(e.message ?? "Failed"),
  });

  const handleFile = (file: File) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const rows = (results.data as Record<string, string>[]).filter((r) => Object.keys(r).length);
        const headers = results.meta.fields ?? [];
        setCsvHeaders(headers);
        setCsvRows(rows);
        // best-effort auto-map
        const guess = (needle: string) =>
          headers.find((h) => h.toLowerCase().includes(needle)) ?? "";
        setMapping({
          phone: guess("phone") || guess("number") || guess("mobile"),
          first_name: guess("first"),
          last_name: guess("last"),
          email: guess("email"),
          notes: guess("note"),
        });
      },
    });
  };

  const preview = useMemo(() => csvRows.slice(0, 5), [csvRows]);

  if (role !== "admin") return <p className="text-sm">Admin only.</p>;

  return (
    <div className="grid gap-6 md:grid-cols-[260px_1fr]">
      <aside className="space-y-4">
        <h1 className="text-lg font-semibold">Contact lists</h1>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (newName.trim()) createMut.mutate();
          }}
        >
          <Input
            placeholder="New list name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <Button size="sm" type="submit" disabled={!newName.trim() || createMut.isPending}>
            Create list
          </Button>
        </form>
        <ul className="space-y-1">
          {(lists.data ?? []).map((l) => (
            <li key={l.id}>
              <button
                onClick={() => setSelected(l.id)}
                className={`w-full rounded px-2 py-1.5 text-left text-sm ${
                  selected === l.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
              >
                {l.name}
              </button>
            </li>
          ))}
          {!lists.data?.length && (
            <p className="text-xs text-muted-foreground">No lists yet.</p>
          )}
        </ul>
      </aside>

      <section className="space-y-6">
        {!selected ? (
          <p className="text-sm text-muted-foreground">Select or create a list to import contacts.</p>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {lists.data?.find((l) => l.id === selected)?.name}
              </h2>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (confirm("Delete this list and all its contacts?")) dropMut.mutate(selected);
                }}
              >
                Delete list
              </Button>
            </div>

            <div className="space-y-3 rounded border p-4">
              <Label>Upload CSV</Label>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
                className="text-sm"
              />
              {csvHeaders.length > 0 && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {FIELDS.map((f) => (
                      <div key={f} className="space-y-1">
                        <Label className="text-xs">
                          {f} {f === "phone" && <span className="text-destructive">*</span>}
                        </Label>
                        <select
                          className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                          value={mapping[f]}
                          onChange={(e) => setMapping((m) => ({ ...m, [f]: e.target.value }))}
                        >
                          <option value="">— skip —</option>
                          {csvHeaders.map((h) => (
                            <option key={h} value={h}>{h}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                  <div className="rounded border">
                    <table className="w-full text-xs">
                      <thead className="bg-muted text-left">
                        <tr>
                          {FIELDS.map((f) => (
                            <th key={f} className="px-2 py-1.5">{f}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.map((r, i) => (
                          <tr key={i} className="border-t">
                            {FIELDS.map((f) => (
                              <td key={f} className="px-2 py-1">
                                {mapping[f] ? r[mapping[f]] ?? "" : ""}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{csvRows.length} rows in file</span>
                    <Button
                      size="sm"
                      disabled={!mapping.phone || importMut.isPending}
                      onClick={() => importMut.mutate()}
                    >
                      {importMut.isPending ? "Importing…" : "Import"}
                    </Button>
                  </div>
                </>
              )}
            </div>

            <div className="rounded border">
              <table className="w-full text-sm">
                <thead className="bg-muted text-left">
                  <tr>
                    <th className="px-3 py-2">Phone</th>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2">Notes</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {(contacts.data ?? []).map((c) => (
                    <tr key={c.id} className="border-t">
                      <td className="px-3 py-2 font-mono">{c.phone}</td>
                      <td className="px-3 py-2">
                        {[c.first_name, c.last_name].filter(Boolean).join(" ")}
                      </td>
                      <td className="px-3 py-2">{c.email}</td>
                      <td className="px-3 py-2 text-muted-foreground">{c.notes}</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          className="text-xs text-destructive hover:underline"
                          onClick={async () => {
                            await delContact({ data: { id: c.id } });
                            qc.invalidateQueries({ queryKey: ["contacts", selected] });
                          }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!contacts.data?.length && (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">
                        No contacts yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

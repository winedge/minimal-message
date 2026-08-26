import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { createAgent, listAgents, setAgentDisabled, claimFirstAdmin } from "@/lib/admin.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRole } from "@/hooks/use-role";

export const Route = createFileRoute("/_authenticated/admin/agents")({
  head: () => ({ meta: [{ title: "Admin — Agents" }] }),
  component: AgentsPage,
});

function AgentsPage() {
  const { role } = useRole();
  const qc = useQueryClient();
  const list = useServerFn(listAgents);
  const create = useServerFn(createAgent);
  const setDisabled = useServerFn(setAgentDisabled);
  const claim = useServerFn(claimFirstAdmin);

  const agents = useQuery({ queryKey: ["agents"], queryFn: () => list(), enabled: role === "admin" });

  const [form, setForm] = useState({ email: "", password: "", fullName: "", extension: "" });
  const [lastCreated, setLastCreated] = useState<null | {
    sipUsername: string;
    sipPassword: string;
    extension: string;
  }>(null);

  const createMut = useMutation({
    mutationFn: async () => create({ data: form }),
    onSuccess: (r) => {
      setLastCreated({ sipUsername: r.sipUsername, sipPassword: r.sipPassword, extension: r.extension });
      setForm({ email: "", password: "", fullName: "", extension: "" });
      qc.invalidateQueries({ queryKey: ["agents"] });
      toast.success("Agent created");
    },
    onError: (e: any) => toast.error(e.message ?? "Failed"),
  });

  const claimMut = useMutation({
    mutationFn: async () => claim(),
    onSuccess: () => {
      toast.success("You are now admin — reload");
      setTimeout(() => window.location.reload(), 800);
    },
    onError: (e: any) => toast.error(e.message ?? "Failed"),
  });

  if (role !== "admin") {
    return (
      <div className="space-y-4 rounded border p-6">
        <p className="text-sm">You are not an admin.</p>
        <p className="text-xs text-muted-foreground">
          If this is a fresh install with no admin yet, claim admin below.
        </p>
        <Button onClick={() => claimMut.mutate()} disabled={claimMut.isPending}>
          Claim first admin
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[420px_1fr]">
      <section className="space-y-3 rounded border p-4">
        <h2 className="font-semibold">Create agent</h2>
        {(["fullName", "email", "password", "extension"] as const).map((k) => (
          <div key={k} className="space-y-1">
            <Label htmlFor={k}>{k}{k === "extension" ? " (3-6 digits, e.g. 1001)" : ""}</Label>
            <Input
              id={k}
              type={k === "password" ? "password" : k === "email" ? "email" : "text"}
              inputMode={k === "extension" ? "numeric" : undefined}
              pattern={k === "extension" ? "\\d{3,6}" : undefined}
              value={form[k]}
              onChange={(e) => setForm({ ...form, [k]: e.target.value })}
            />
          </div>
        ))}
        <Button className="w-full" onClick={() => createMut.mutate()} disabled={createMut.isPending}>
          {createMut.isPending ? "Creating…" : "Create agent"}
        </Button>
        {lastCreated && (
          <div className="rounded border border-amber-500/50 bg-amber-500/10 p-3 text-xs">
            <p className="font-semibold">Save these — SIP password shown once</p>
            <p>Username: <code>{lastCreated.sipUsername}</code></p>
            <p>Password: <code>{lastCreated.sipPassword}</code></p>
            <p>Extension: <code>{lastCreated.extension}</code></p>
            <p className="mt-1 text-muted-foreground">Add this to Asterisk pjsip config (see docs).</p>
          </div>
        )}
      </section>

      <section className="rounded border">
        <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
          <thead className="bg-muted text-left">
            <tr>
              <th className="p-2">Name</th>
              <th className="p-2">Email</th>
              <th className="p-2">Role</th>
              <th className="p-2">Extension</th>
              <th className="p-2">Status</th>
              <th className="p-2">Manage</th>
            </tr>
          </thead>
          <tbody>
            {agents.data?.map((a: any) => (
              <tr key={a.id} className="border-t align-top">
                <td className="p-2">{a.full_name || "—"}</td>
                <td className="p-2 text-xs text-muted-foreground">{a.email ?? "—"}</td>
                <td className="p-2">{a.role ?? "—"}</td>
                <td className="p-2">{a.sip?.extension ?? "—"}</td>
                <td className="p-2">{a.disabled ? "disabled" : "active"}</td>
                <td className="p-2">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={roleMut.isPending}
                      onClick={() =>
                        roleMut.mutate({ userId: a.id, role: a.role === "admin" ? "agent" : "admin" })
                      }
                    >
                      {a.role === "admin" ? "Demote to agent" : "Promote to admin"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        await setDisabled({ data: { userId: a.id, disabled: !a.disabled } });
                        qc.invalidateQueries({ queryKey: ["agents"] });
                      }}
                    >
                      {a.disabled ? "Enable" : "Disable"}
                    </Button>
                    {resetFor === a.id ? (
                      <div className="flex items-center gap-2">
                        <Input
                          className="h-8 w-44"
                          type="text"
                          placeholder="New password (min 8)"
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                        />
                        <Button
                          size="sm"
                          disabled={pwMut.isPending}
                          onClick={() => pwMut.mutate({ userId: a.id, password: newPassword })}
                        >
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setResetFor(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setResetFor(a.id);
                          setNewPassword("");
                        }}
                      >
                        Set password
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>

    </div>
  );
}

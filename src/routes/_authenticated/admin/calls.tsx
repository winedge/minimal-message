import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRole } from "@/hooks/use-role";

export const Route = createFileRoute("/_authenticated/admin/calls")({
  head: () => ({ meta: [{ title: "Admin — All calls" }] }),
  component: AllCallsPage,
});

function AllCallsPage() {
  const { role } = useRole();
  const q = useQuery({
    queryKey: ["admin-calls"],
    enabled: role === "admin",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("calls")
        .select("id, agent_id, customer_phone, status, started_at, duration, disposition, recording_url")
        .order("started_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return data;
    },
  });
  if (role !== "admin") return <p className="text-sm">Admin only.</p>;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">All calls</h1>
      <div className="overflow-x-auto rounded border">
        <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-sm">
          <thead className="bg-muted text-left">
            <tr>
              <th className="p-2">Started</th>
              <th className="p-2">Agent</th>
              <th className="p-2">Customer</th>
              <th className="p-2">Status</th>
              <th className="p-2">Duration</th>
              <th className="p-2">Disposition</th>
              <th className="p-2">Rec</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((c: any) => (
              <tr key={c.id} className="border-t">
                <td className="p-2">{new Date(c.started_at).toLocaleString()}</td>
                <td className="p-2">{c.agent_id?.slice(0, 8)}</td>
                <td className="p-2">{c.customer_phone}</td>
                <td className="p-2">{c.status}</td>
                <td className="p-2">{c.duration ? `${c.duration}s` : "—"}</td>
                <td className="p-2">{c.disposition ?? "—"}</td>
                <td className="p-2">
                  {c.recording_url ? <audio controls src={c.recording_url} className="h-8" /> : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
    </div>
  );
}

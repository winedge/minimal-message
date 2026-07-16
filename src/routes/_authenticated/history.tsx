import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated/history")({
  head: () => ({ meta: [{ title: "Call history" }] }),
  component: HistoryPage,
});

function HistoryPage() {
  const q = useQuery({
    queryKey: ["history"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("calls")
        .select("id, customer_phone, status, started_at, ended_at, duration, disposition, recording_url")
        .order("started_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data;
    },
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Your calls</h1>
      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left">
            <tr>
              <th className="p-2">Started</th>
              <th className="p-2">Customer</th>
              <th className="p-2">Status</th>
              <th className="p-2">Duration</th>
              <th className="p-2">Disposition</th>
              <th className="p-2">Recording</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((c) => (
              <tr key={c.id} className="border-t">
                <td className="p-2">{new Date(c.started_at).toLocaleString()}</td>
                <td className="p-2">{c.customer_phone}</td>
                <td className="p-2">{c.status}</td>
                <td className="p-2">{c.duration ? `${c.duration}s` : "—"}</td>
                <td className="p-2">{c.disposition ?? "—"}</td>
                <td className="p-2">
                  {c.recording_url ? (
                    <audio controls src={c.recording_url} className="h-8" />
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
            {!q.data?.length && (
              <tr>
                <td className="p-4 text-center text-muted-foreground" colSpan={6}>
                  No calls yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

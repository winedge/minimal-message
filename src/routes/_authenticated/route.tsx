import { createFileRoute, Outlet, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useRole, useSession } from "@/hooks/use-role";
import { Button } from "@/components/ui/button";
import { useServerFn } from "@tanstack/react-start";
import { claimFirstAdmin } from "@/lib/admin.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  component: AuthenticatedShell,
});

function AuthenticatedShell() {
  const session = useSession();
  const { role, loading } = useRole();
  const navigate = useNavigate();

  useEffect(() => {
    if (session === null) navigate({ to: "/auth" });
  }, [session, navigate]);

  if (session === undefined || loading) {
    return <div className="p-8 text-muted-foreground">Loading…</div>;
  }
  if (!session) return null;

  const isAdmin = role === "admin";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            <Link to="/" className="font-semibold">Dialer</Link>
            <nav className="flex items-center gap-4 text-sm">
              <Link to="/dialer" className="hover:underline">Dialer</Link>
              <Link to="/history" className="hover:underline">History</Link>
              {isAdmin && (
                <>
                  <Link to="/admin/live" className="hover:underline">Live</Link>
                  <Link to="/admin/agents" className="hover:underline">Agents</Link>
                  <Link to="/admin/contacts" className="hover:underline">Contacts</Link>
                  <Link to="/admin/inbound" className="hover:underline">Inbound</Link>
                  <Link to="/admin/fields" className="hover:underline">CRM fields</Link>
                  <Link to="/admin/calls" className="hover:underline">All calls</Link>
                </>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">{session.email}</span>
            <span className="rounded bg-muted px-2 py-0.5 text-xs uppercase">{role ?? "no role"}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await supabase.auth.signOut();
                navigate({ to: "/auth", replace: true });
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        {role === null ? (
          <NoRoleBlock />
        ) : (
          <Outlet />
        )}
      </main>
    </div>
  );
}

function NoRoleBlock() {
  const claim = useServerFn(claimFirstAdmin);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-4 rounded border p-6 text-sm">
      <p>Your account has no role assigned yet.</p>
      <p className="text-muted-foreground text-xs">
        If this is a fresh install with no admin yet, claim admin below. Otherwise ask an existing admin to add you as an agent.
      </p>
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await claim();
            toast.success("You are now admin — reloading");
            setTimeout(() => window.location.reload(), 600);
          } catch (e: any) {
            toast.error(e.message ?? "Failed");
            setBusy(false);
          }
        }}
      >
        {busy ? "Claiming…" : "Claim first admin"}
      </Button>
    </div>
  );
}

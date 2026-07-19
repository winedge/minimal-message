import { createFileRoute, Outlet, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useRole, useSession } from "@/hooks/use-role";
import { Button } from "@/components/ui/button";
import { useServerFn } from "@tanstack/react-start";
import { claimFirstAdmin } from "@/lib/admin.functions";
import { toast } from "sonner";
import { Menu, X, PhoneCall, LogOut, ChevronDown } from "lucide-react";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  component: AuthenticatedShell,
});

function AuthenticatedShell() {
  const session = useSession();
  const { role, loading } = useRole();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (session === null) navigate({ to: "/auth" });
  }, [session, navigate]);

  if (session === undefined || loading) {
    return <div className="p-8 text-muted-foreground">Loading…</div>;
  }
  if (!session) return null;

  const isAdmin = role === "admin";

  const navLinks = (
    <>
      <Link to="/dialer" onClick={() => setMenuOpen(false)} className="hover:underline">Dialer</Link>
      <Link to="/history" onClick={() => setMenuOpen(false)} className="hover:underline">History</Link>
      {isAdmin && (
        <>
          <Link to="/admin/live" onClick={() => setMenuOpen(false)} className="hover:underline">Live</Link>
          <Link to="/admin/agents" onClick={() => setMenuOpen(false)} className="hover:underline">Agents</Link>
          <Link to="/admin/contacts" onClick={() => setMenuOpen(false)} className="hover:underline">Contacts</Link>
          <Link to="/admin/inbound" onClick={() => setMenuOpen(false)} className="hover:underline">Inbound</Link>
          <Link to="/admin/outbound" onClick={() => setMenuOpen(false)} className="hover:underline">Outbound</Link>
          <Link to="/admin/fields" onClick={() => setMenuOpen(false)} className="hover:underline">CRM fields</Link>
          <Link to="/admin/calls" onClick={() => setMenuOpen(false)} className="hover:underline">All calls</Link>
        </>
      )}
    </>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-3 py-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-6">
            <Link to="/" className="font-semibold shrink-0">AiDialX Lite</Link>
            <nav className="hidden items-center gap-4 text-sm lg:flex">
              {navLinks}
            </nav>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="hidden text-muted-foreground sm:inline max-w-[160px] truncate">{session.email}</span>
            <span className="rounded bg-muted px-2 py-0.5 text-[10px] uppercase">{role ?? "no role"}</span>
            <Button
              size="sm"
              variant="outline"
              className="hidden sm:inline-flex"
              onClick={async () => {
                await supabase.auth.signOut();
                navigate({ to: "/auth", replace: true });
              }}
            >
              Sign out
            </Button>
            <button
              type="button"
              aria-label="Menu"
              onClick={() => setMenuOpen((v) => !v)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border lg:hidden"
            >
              {menuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
            </button>
          </div>
        </div>
        {menuOpen && (
          <div className="border-t lg:hidden">
            <nav className="mx-auto flex max-w-6xl flex-col gap-1 px-3 py-3 text-sm">
              {navLinks}
              <div className="mt-2 flex items-center justify-between border-t pt-3 sm:hidden">
                <span className="truncate text-xs text-muted-foreground">{session.email}</span>
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
            </nav>
          </div>
        )}
      </header>
      <main className="mx-auto max-w-6xl px-3 py-4 sm:px-4 sm:py-6">
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

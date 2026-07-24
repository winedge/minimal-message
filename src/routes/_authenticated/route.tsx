import { createFileRoute, Outlet, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useRole, useSession } from "@/hooks/use-role";
import { Button } from "@/components/ui/button";
import { useServerFn } from "@tanstack/react-start";
import { claimFirstAdmin } from "@/lib/admin.functions";
import { toast } from "sonner";
import { Menu, X, LogOut, Phone, Clock, Shield, User as UserIcon } from "lucide-react";

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

  const mainLinks = [
    { to: "/dialer", label: "Dialer" },
    { to: "/history", label: "History" },
  ] as const;
  const adminLinks = [
    { to: "/admin/live", label: "Live" },
    { to: "/admin/agents", label: "Agents" },
    { to: "/admin/contacts", label: "Contacts" },
    { to: "/admin/inbound", label: "Inbound" },
    { to: "/admin/outbound", label: "Outbound" },
    { to: "/admin/fields", label: "CRM fields" },
    { to: "/admin/calls", label: "All calls" },
  ] as const;

  const navLinkClass =
    "rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&.active]:bg-primary/10 [&.active]:text-primary [&.active]:font-medium";

  const desktopNav = (
    <nav className="hidden items-center gap-1 lg:flex">
      {mainLinks.map((l) => (
        <Link key={l.to} to={l.to} className={navLinkClass} activeOptions={{ exact: true }}>
          {l.label}
        </Link>
      ))}
      {isAdmin && (
        <div className="relative ml-1 border-l pl-2">
          <div className="flex items-center gap-1">
            <span className="px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Admin</span>
            {adminLinks.map((l) => (
              <Link key={l.to} to={l.to} className={navLinkClass} activeOptions={{ exact: true }}>
                {l.label}
              </Link>
            ))}
          </div>
        </div>
      )}
    </nav>
  );


  const initials = (session.email ?? "?").slice(0, 2).toUpperCase();

  const signOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  };

  const mobileTabClass =
    "flex flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-2 py-1.5 text-[10px] font-medium text-muted-foreground transition-colors [&.active]:bg-primary/10 [&.active]:text-primary";

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Desktop / tablet header — hidden on phones */}
      <header className="sticky top-0 z-40 hidden border-b bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/60 lg:block">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-4">
            <Link to="/" className="group flex shrink-0 items-center gap-2">
              <span className="flex flex-col leading-none">
                <span className="text-[15px] font-semibold tracking-tight">AiDialX <span className="text-primary">Lite</span></span>
                <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Agent console</span>
              </span>
            </Link>
            {desktopNav}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-full border bg-card px-2 py-1 pr-3">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                {initials}
              </span>
              <span className="max-w-[140px] truncate text-xs text-foreground">{session.email}</span>
              <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${isAdmin ? "bg-amber-500/15 text-amber-600" : role === "agent" ? "bg-sky-500/15 text-sky-600" : "bg-muted text-muted-foreground"}`}>
                {role ?? "no role"}
              </span>
            </div>
            <Button size="sm" variant="ghost" onClick={signOut}>
              <LogOut className="mr-1.5 h-3.5 w-3.5" /> Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-3 pb-[calc(72px+env(safe-area-inset-bottom))] pt-3 sm:px-4 sm:py-6 lg:pb-6">
        {role === null ? <NoRoleBlock /> : <Outlet />}
      </main>

      {/* Mobile bottom tab bar — app-like navigation */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border/60 bg-background/95 backdrop-blur-xl pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <div className="mx-auto flex max-w-md items-stretch gap-1 px-2 py-1.5">
          <Link to="/dialer" className={mobileTabClass} activeOptions={{ exact: true }}>
            <Phone className="h-5 w-5" />
            <span>Dialer</span>
          </Link>
          <Link to="/history" className={mobileTabClass} activeOptions={{ exact: true }}>
            <Clock className="h-5 w-5" />
            <span>History</span>
          </Link>
          {isAdmin && (
            <Link to="/admin/live" className={mobileTabClass}>
              <Shield className="h-5 w-5" />
              <span>Admin</span>
            </Link>
          )}
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            className="flex flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-2 py-1.5 text-[10px] font-medium text-muted-foreground"
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[9px] font-semibold text-primary">
              {initials}
            </span>
            <span>Account</span>
          </button>
        </div>
      </nav>

      {/* Mobile account / admin sheet */}
      {menuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMenuOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 rounded-t-2xl border-t bg-background pb-[env(safe-area-inset-bottom)] shadow-2xl">
            <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-muted" />
            <div className="flex items-center justify-between gap-3 px-4 pt-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                  {initials}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{session.email}</div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{role ?? "no role"}</div>
                </div>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setMenuOpen(false)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {isAdmin && (
              <div className="mt-4 border-t px-2 pt-3">
                <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Admin</div>
                <div className="grid grid-cols-2 gap-1">
                  {adminLinks.map((l) => (
                    <Link
                      key={l.to}
                      to={l.to}
                      onClick={() => setMenuOpen(false)}
                      className="rounded-lg px-3 py-2 text-sm text-foreground hover:bg-muted [&.active]:bg-primary/10 [&.active]:text-primary"
                    >
                      {l.label}
                    </Link>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-4 border-t px-4 py-3">
              <Button variant="outline" className="w-full" onClick={signOut}>
                <LogOut className="mr-2 h-4 w-4" /> Sign out
              </Button>
            </div>
          </div>
        </div>
      )}
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

import { createFileRoute, Outlet, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useRole, useSession } from "@/hooks/use-role";
import { Button } from "@/components/ui/button";
import { useServerFn } from "@tanstack/react-start";
import { claimFirstAdmin } from "@/lib/admin.functions";
import { toast } from "sonner";
import { Menu, X, PhoneCall, LogOut } from "lucide-react";

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

  const mobileNav = (
    <>
      {mainLinks.map((l) => (
        <Link key={l.to} to={l.to} onClick={() => setMenuOpen(false)} className={navLinkClass}>
          {l.label}
        </Link>
      ))}
      {isAdmin && (
        <>
          <div className="mt-2 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Admin</div>
          {adminLinks.map((l) => (
            <Link key={l.to} to={l.to} onClick={() => setMenuOpen(false)} className={navLinkClass}>
              {l.label}
            </Link>
          ))}
        </>
      )}
    </>
  );

  const initials = (session.email ?? "?").slice(0, 2).toUpperCase();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-3 py-2.5 sm:px-4">
          <div className="flex min-w-0 items-center gap-4">
            <Link to="/" className="group flex shrink-0 items-center gap-2">
              <span className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary/60 text-primary-foreground shadow-sm shadow-primary/30 ring-1 ring-primary/20 transition-transform group-hover:scale-105">
                <PhoneCall className="h-4 w-4" />
                <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-background" />
              </span>
              <span className="flex flex-col leading-none">
                <span className="text-[15px] font-semibold tracking-tight">AiDialX <span className="text-primary">Lite</span></span>
                <span className="hidden text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground sm:inline">Agent console</span>
              </span>
            </Link>
            {desktopNav}
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-2 rounded-full border bg-card px-2 py-1 pr-3 sm:flex">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                {initials}
              </span>
              <span className="max-w-[140px] truncate text-xs text-foreground">{session.email}</span>
              <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${isAdmin ? "bg-amber-500/15 text-amber-600" : role === "agent" ? "bg-sky-500/15 text-sky-600" : "bg-muted text-muted-foreground"}`}>
                {role ?? "no role"}
              </span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="hidden sm:inline-flex"
              onClick={async () => {
                await supabase.auth.signOut();
                navigate({ to: "/auth", replace: true });
              }}
            >
              <LogOut className="mr-1.5 h-3.5 w-3.5" /> Sign out
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
          <div className="border-t bg-background lg:hidden">
            <nav className="mx-auto flex max-w-6xl flex-col gap-0.5 px-3 py-3">
              {mobileNav}
              <div className="mt-3 flex items-center justify-between border-t pt-3 sm:hidden">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                    {initials}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">{session.email}</span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    await supabase.auth.signOut();
                    navigate({ to: "/auth", replace: true });
                  }}
                >
                  <LogOut className="mr-1.5 h-3.5 w-3.5" /> Sign out
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

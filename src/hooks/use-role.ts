import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type Role = "admin" | "agent" | null;

export function useSession() {
  const [session, setSession] = useState<
    { userId: string; email: string | null } | null | undefined
  >(undefined); // undefined = loading

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const s = data.session;
      setSession(s ? { userId: s.user.id, email: s.user.email ?? null } : null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s ? { userId: s.user.id, email: s.user.email ?? null } : null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return session;
}

export function useRole(): { role: Role; loading: boolean } {
  const session = useSession();
  const [role, setRole] = useState<Role>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (session === undefined) return;
    if (session === null) {
      setRole(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", session.userId);
      if (cancelled) return;
      const roles = (data ?? []).map((r) => r.role as string);
      setRole(roles.includes("admin") ? "admin" : roles.includes("agent") ? "agent" : null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  return { role, loading };
}

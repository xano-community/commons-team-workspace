// What the signed-in person may do, for the shell and the screens that only ask. It reads the same route as the rbac module's
// provider, without its screens: those load with /team and /profile, which is the one place they're needed.
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { routePath } from "../../../xano/routes.gen.js";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useEntityQuery } from "@/lib/data";
import { request } from "./request";

const Access = createContext<ReadonlySet<string>>(new Set());

export function AccessProvider({ userKey, children }: { userKey: number; children: ReactNode }) {
  const me = useEntityQuery("rbac", ["me", userKey], () => request<{ permissions: string[] }>("GET", routePath("GET rbac/me")));
  // A removal resets every query. What's on screen stays mounted through that, so it can say what happened and keep what was typed.
  const known = useRef(me.data);
  if (me.data) known.current = me.data;
  const held = useMemo(() => new Set(known.current?.permissions ?? []), [known.current]); // eslint-disable-line react-hooks/exhaustive-deps
  if (known.current) return <Access.Provider value={held}>{children}</Access.Provider>;
  if (me.error) return <div role="alert" className="m-6 flex items-center gap-3 text-body text-muted-foreground" data-testid="rbac-error">We couldn't load your access.<Button variant="outline" onClick={() => void me.refetch()}>Try again</Button></div>;
  return <div className="grid min-h-40 place-items-center"><Skeleton className="h-4 w-40" /></div>;
}

export const useCan = (permission: string) => useContext(Access).has(permission);

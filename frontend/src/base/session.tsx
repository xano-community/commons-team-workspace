// The session (AUTH.md §6): signed out by default; a stored token is checked with auth/me on boot and dropped only if
// the server refuses it. A dropped connection or a server error keeps it, and offers to try again. A 401 while someone is working doesn't throw them out: the screen stays as it is, the sign-in dialog opens over
// it, and drafts and unsent writes wait. A demo session stays in its own window, and a real one follows its browser:
// when another tab changes the shared token, this tab reloads as whoever is signed in now.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { queryClient } from "@/lib/data";
import { baseApi, type Me } from "./api";
import { ApiError, onSharedTokenChange, setUnauthorizedHandler, token } from "./request";

type SignInOptions = { windowOnly?: boolean };
type Session = {
  me: Me | null;
  signIn: (authToken: string, opts?: SignInOptions) => Promise<Me>;
  signOut: () => void;
  refresh: () => Promise<void>;
  /** The token stopped working mid-session. The sign-in dialog is open and `me` is still who was here. */
  expired: boolean;
  /** Treat the session as ended: for a module's client, which sees a 401 that request() doesn't. */
  expire: () => void;
  /** Answers the dialog. The same person carries on where they were; anyone else starts clean. */
  resume: (authToken: string, opts?: SignInOptions) => Promise<void>;
  /** Moves each time a session resumes, so the socket and the outbox know there's a token again. */
  epoch: number;
};
const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(() => !token.get());
  const [expired, setExpired] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [unreachable, setUnreachable] = useState(false);
  const signedIn = useRef<Me | null>(null);
  signedIn.current = me;

  /** On boot: a refused token is gone (request() drops it on a 401). Anything else keeps it, so a blip never signs anyone out. */
  const checkToken = useCallback(() => {
    setUnreachable(false);
    baseApi.me()
      .then(setMe)
      .catch((e) => { if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500) setUnreachable(true); else token.set(null); })
      .finally(() => setReady(true));
  }, []);

  const resume = useCallback(async (authToken: string, opts?: SignInOptions) => {
    token.set(authToken, opts);
    const user = await baseApi.me();
    if (user.id !== signedIn.current?.id) { location.assign("/"); return; }
    setMe(user);
    setExpired(false);
    setEpoch((n) => n + 1);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => { if (signedIn.current) setExpired(true); });
    const stopListening = onSharedTokenChange(() => {
      const shared = token.get();
      if (signedIn.current && !signedIn.current.is_demo && shared) resume(shared).catch(() => location.reload());
      else location.reload();
    });
    if (token.get()) checkToken();
    return stopListening;
  }, [resume, checkToken]);

  const signIn = useCallback(async (authToken: string, opts?: SignInOptions) => {
    token.set(authToken, opts);
    const user = await baseApi.me();
    queryClient.clear();
    setMe(user);
    return user;
  }, []);
  const signOut = useCallback(() => { token.set(null); queryClient.clear(); setExpired(false); setMe(null); }, []);
  const expire = useCallback(() => { token.set(null); if (signedIn.current) setExpired(true); }, []);
  /** Re-read auth/me (after a rename, say), so every screen shows the new name. */
  const refresh = useCallback(async () => { setMe(await baseApi.me()); }, []);
  const value = useMemo(() => ({ me, signIn, signOut, refresh, expired, expire, resume, epoch }), [me, signIn, signOut, refresh, expired, expire, resume, epoch]);

  if (unreachable && !me) {
    return (
      <div className="grid min-h-svh place-items-center p-6">
        <div className="max-w-sm text-center" role="alert">
          <p className="text-base font-medium">We can't reach Commons right now</p>
          <p className="mt-1 text-sm text-muted-foreground">You're still signed in. Check your connection, then try again.</p>
          <Button className="mt-4" onClick={checkToken}>Try again</Button>
        </div>
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="grid min-h-svh place-items-center">
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}

/**
 * A guest has only their spaces: no shared channel, no workspace pages. Read from the session because the socket has to
 * know before it connects, which is before the permission map has loaded.
 */
export const isGuest = ({ role }: Me) => role === "guest";

/** The signed-in person. Only inside the shell, which guarantees one. */
export function useMe(): Me {
  const { me } = useSession();
  if (!me) throw new Error("useMe outside the signed-in shell");
  return me;
}

// The dialog a 401 opens. The app stays mounted behind it, so nothing typed is lost, and signing back in as the same
// person carries on from the same screen. It's in the shell's own chunk: a session often ends after a deploy, when a
// lazy chunk from the old build would no longer load.
import { useEffect, useState, type FormEvent } from "react";
import { Avatar } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useOutboxCount } from "@/lib/data";
import { baseApi, type Persona } from "./api";
import { useSession } from "./session";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : "That didn't work. Try again.");

export function SessionDialog() {
  const { me, expired, resume, signOut } = useSession();
  const unsent = useOutboxCount(me?.id ?? 0);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!expired || !me?.is_demo) return;
    baseApi.personas().then((list) => setPersona(list.find((p) => p.label === me.name) ?? null), () => setPersona(null));
  }, [expired, me?.is_demo, me?.name]);

  if (!me) return null;
  const go = async (mint: () => Promise<{ authToken: string }>, opts?: { windowOnly?: boolean }) => {
    setBusy(true); setError(null);
    try { await resume((await mint()).authToken, opts); setPassword(""); }
    catch (e) { setError(messageOf(e)); }
    finally { setBusy(false); }
  };
  const kept = unsent === 1 ? "Your drafts and 1 unsent change are safe, and go out when you're back."
    : unsent > 1 ? `Your drafts and ${unsent} unsent changes are safe, and go out when you're back.`
    : "Your drafts are safe, and this screen stays as you left it.";

  return (
    <Dialog open={expired}>
      <DialogContent data-kit="session-dialog" showCloseButton={false} className="max-w-sm" onEscapeKeyDown={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Sign in to keep working</DialogTitle>
          <DialogDescription>Your session ended. {kept}</DialogDescription>
        </DialogHeader>
        {persona ? (
          <Button variant="outline" className="h-auto justify-start gap-3 py-2 text-left" data-testid="session-demo" disabled={busy}
            onClick={() => void go(() => baseApi.demo(persona.key), { windowOnly: true })}>
            <Avatar name={persona.label} size="md" decorative />
            <span className="font-medium">{busy ? "Signing in…" : `Continue as ${persona.label}`}</span>
          </Button>
        ) : (
          <form id="session-form" className="grid gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); void go(() => baseApi.login(me.email, password)); }}>
            <div className="grid gap-1.5">
              <Label htmlFor="session-email">Email</Label>
              <Input id="session-email" type="email" value={me.email} readOnly autoComplete="username" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="session-password">Password</Label>
              <Input id="session-password" type="password" required autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          </form>
        )}
        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={signOut}>Sign out</Button>
          {!persona && <Button type="submit" form="session-form" size="sm" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

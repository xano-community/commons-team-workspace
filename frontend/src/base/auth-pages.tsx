// The signed-out screens (AUTH.md §6): sign in (one click as a demo person, or email and password), sign up, and
// /join/<token> for an invite or a password reset. Nothing secret is in the bundle: demo sign-in mints a token
// server-side for the listed demo people only.
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router";
import { ArrowRight, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, LoadError } from "@/components/kit";
import { baseApi, type AuthStatus, type LinkInfo, type Persona } from "./api";
import { useSession } from "./session";
import { landingAfterSignIn, readOpenAs } from "@/lib/first-run";

/** `pitch`: what the app is, in one line under its name. The demo people come in the server's order (DEMO_SIGN_IN). */
export type Brand = { name: string; icon: LucideIcon; tagline: string; pitch?: string };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : "That didn't work. Try again.");

/** What the signed-out screens may offer: setup, demo sign-in and open sign-up. */
function useAuthStatus() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => { setError(null); baseApi.status().then(setStatus, setError); }, []);
  useEffect(load, [load]);
  return { status, error, load };
}

function Frame({ brand, title, description, children }: { brand: Brand; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <main className="mx-auto grid min-h-svh w-full max-w-sm content-center gap-6 p-6">
      <div className="flex flex-col gap-2">
        <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground"><brand.icon className="size-5" /></span>
        <h1 className="text-title">{title}</h1>
        {description && <p className="text-body text-muted-foreground">{description}</p>}
      </div>
      {children}
    </main>
  );
}

function PasswordField({ id, label, value, onChange, autoComplete, hint }: { id: string; label: string; value: string; onChange: (v: string) => void; autoComplete: string; hint?: string }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="password" required autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={hint ? `${id}-hint` : undefined} />
      {hint && <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * The demo's ways in. The first person is the one the demo is built around (DEMO_SIGN_IN), so theirs is the filled button with what's
 * waiting for them; the others are a step down. Each is a demo-login button, in the server's order.
 */
function DemoDoors({ personas, busy, onPick }: { personas: Persona[]; busy: string | null; onPick: (p: Persona) => void }) {
  const [first, ...others] = personas;
  const label = (p: Persona) => (busy === p.key ? "Signing in…" : `Continue as ${p.label}`);
  return (
    <div className="grid gap-4">
      <Button size="lg" className="h-auto justify-start gap-3 py-3 text-left" data-testid="demo-login" data-primary disabled={!!busy} onClick={() => onPick(first)}>
        <Avatar name={first.label} size="md" decorative className="ring-2 ring-primary-foreground/20" />
        <span className="min-w-0 flex-1"><span className="block text-body font-medium">{label(first)}</span><span className="block text-caption font-normal text-pretty text-primary-foreground/75">{first.description}</span></span>
        <ArrowRight aria-hidden className="size-4 shrink-0 opacity-75" />
      </Button>
      {others.length > 0 && (
        <div className="grid gap-1.5" role="group" aria-labelledby="other-demo-people">
          <p id="other-demo-people" className="text-caption text-muted-foreground">Or look around as</p>
          {others.map((p) => (
            <Button key={p.key} variant="ghost" className="h-auto justify-start gap-2.5 px-2 py-1.5 text-left" data-testid="demo-login" disabled={!!busy} onClick={() => onPick(p)}>
              <Avatar name={p.label} size="sm" decorative />
              <span className="min-w-0"><span className="block text-body font-medium">{label(p)}</span><span className="block truncate text-caption font-normal text-muted-foreground">{p.description}</span></span>
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SignInPage({ brand }: { brand: Brand }) {
  const { me, signIn } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/";
  // "Open as Avery in a new window" lands here with ?as=admin: this window signs in as that demo person, on its own session.
  const openAs = readOpenAs(location.search);
  const openingAs = useRef(false);
  const { status } = useAuthStatus();
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [personasError, setPersonasError] = useState<unknown>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => { setPersonasError(null); baseApi.personas().then(setPersonas, setPersonasError); }, []);
  useEffect(load, [load]);

  const go = useCallback(async (key: string, mint: () => Promise<{ authToken: string }>, opts?: { windowOnly?: boolean }, to?: string) => {
    setBusy(key); setError(null);
    try { await signIn((await mint()).authToken, opts); navigate(to ?? landingAfterSignIn(from, !!opts?.windowOnly), { replace: true }); }
    catch (e) { setError(messageOf(e)); }
    finally { setBusy(null); }
  }, [signIn, navigate, from]);

  const asPersona = openAs && personas?.find((p) => p.key === openAs.as);
  useEffect(() => {
    if (!openAs || !personas || openingAs.current) return;
    openingAs.current = true;
    if (asPersona) void go(asPersona.key, () => baseApi.demo(asPersona.key), { windowOnly: true }, openAs.to || landingAfterSignIn(null, true));
    else setError("That demo person can't sign in here any more. Sign in with your account instead.");
  }, [openAs, personas, asPersona, go]);

  if (me && !openAs) return <Navigate to={landingAfterSignIn(from, me.is_demo)} replace />;
  if (status?.setup_required) return <Navigate to="/setup" replace />;
  if (openAs && !error) {
    return (
      <Frame brand={brand} title={asPersona ? `Signing in as ${asPersona.label}…` : "Signing in…"} description="This window has its own session, so the other window stays as it was.">
        <Skeleton className="h-14 w-full" />
      </Frame>
    );
  }

  return (
    <Frame brand={brand} title={status?.name || brand.name} description={brand.pitch ?? (personas?.length ? brand.tagline : "Sign in with your account.")}>
      {personasError ? <LoadError error={personasError} onRetry={load} /> : personas === null ? (
        <div className="grid gap-2">{[0, 1].map((i) => <Skeleton key={`skeleton-${i}`} className="h-14 w-full" />)}</div>
      ) : personas.length > 0 && (
        <DemoDoors personas={personas} busy={busy} onPick={(p) => void go(p.key, () => baseApi.demo(p.key), { windowOnly: true })} />
      )}
      {personas && personas.length > 0 && <div className="flex items-center gap-3 text-xs text-muted-foreground"><Separator className="flex-1" />or with your account<Separator className="flex-1" /></div>}
      <form className="grid gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); void go("email", () => baseApi.login(email.trim(), password)); }}>
        <div className="grid gap-1.5">
          <Label htmlFor="sign-in-email">Email</Label>
          <Input id="sign-in-email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <PasswordField id="sign-in-password" label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <Button type="submit" disabled={!!busy}>{busy === "email" ? "Signing in…" : "Sign in"}</Button>
      </form>
      <div className="grid gap-1 text-xs text-muted-foreground">
        {status?.signup_open
          ? <p>New here? <Link to="/sign-up" className="font-medium text-foreground underline underline-offset-4">Create an account</Link></p>
          : status && <p>New here? Ask an admin for an invite.</p>}
        <p>Forgot your password? Ask someone who manages your team for a reset link.</p>
      </div>
    </Frame>
  );
}

export function SignUpPage({ brand }: { brand: Brand }) {
  const { me, signIn } = useSession();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { status } = useAuthStatus();
  if (me) return <Navigate to="/" replace />;
  if (status && !status.signup_open) {
    return (
      <Frame brand={brand} title="Sign-up is closed" description="Ask an admin of this workspace for an invite link.">
        <Link to="/sign-in" className="text-body font-medium underline underline-offset-4">Go to sign in</Link>
      </Frame>
    );
  }
  return (
    <Frame brand={brand} title={`Create your ${brand.name} account`} description="You can explore everything a new member can.">
      <form className="grid gap-3" onSubmit={async (e: FormEvent) => {
        e.preventDefault(); setBusy(true); setError(null);
        try { await signIn((await baseApi.signup(name.trim(), email.trim(), password)).authToken); navigate("/", { replace: true }); }
        catch (err) { setError(messageOf(err)); }
        finally { setBusy(false); }
      }}>
        <div className="grid gap-1.5"><Label htmlFor="sign-up-name">Name</Label><Input id="sign-up-name" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="grid gap-1.5"><Label htmlFor="sign-up-email">Email</Label><Input id="sign-up-email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <PasswordField id="sign-up-password" label="Password" value={password} onChange={setPassword} autoComplete="new-password" hint="At least 8 characters, with a letter and a number." />
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create account"}</Button>
      </form>
      <p className="text-xs text-muted-foreground">Already have one? <Link to="/sign-in" className="font-medium text-foreground underline underline-offset-4">Sign in</Link></p>
    </Frame>
  );
}

/** /setup: the first admin of an empty backend. Needs the backend's SETUP_TOKEN, so nobody else can claim it. */
export function SetupPage({ brand }: { brand: Brand }) {
  const { me, signIn } = useSession();
  const navigate = useNavigate();
  const { status, error: loadError, load } = useAuthStatus();
  const [setupToken, setSetupToken] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (me) return <Navigate to="/" replace />;
  if (loadError) return <Frame brand={brand} title={`Set up ${brand.name}`}><LoadError error={loadError} onRetry={load} /></Frame>;
  if (!status) return <Frame brand={brand} title={`Set up ${brand.name}`}><Skeleton className="h-32 w-full" /></Frame>;
  if (!status.setup_required) return <Navigate to="/sign-in" replace />;
  if (!status.setup_ready) {
    return (
      <Frame brand={brand} title={`Set up ${brand.name}`} description="This backend has no setup token yet, so nobody can claim it. Set one, then come back.">
        <pre className="rounded-lg border bg-muted p-3 font-mono text-xs break-all whitespace-pre-wrap" data-testid="setup-command">npx xanosdk env set SETUP_TOKEN "$(openssl rand -hex 24)"</pre>
        <Button variant="outline" onClick={load}>I've set it</Button>
      </Frame>
    );
  }
  return (
    <Frame brand={brand} title={`Set up ${brand.name}`} description="Name your workspace and create its first admin. You can invite your team next.">
      <form className="grid gap-3" data-testid="setup-form" onSubmit={async (e: FormEvent) => {
        e.preventDefault(); setBusy(true); setError(null);
        try {
          const made = await baseApi.setup({ setup_token: setupToken, workspace_name: workspaceName.trim(), name: name.trim(), email: email.trim(), password });
          await signIn(made.authToken);
          navigate("/", { replace: true });
        } catch (err) { setError(messageOf(err)); }
        finally { setBusy(false); }
      }}>
        <div className="grid gap-1.5"><Label htmlFor="setup-workspace">Workspace name</Label><Input id="setup-workspace" required maxLength={60} value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} /></div>
        <div className="grid gap-1.5"><Label htmlFor="setup-name">Your name</Label><Input id="setup-name" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="grid gap-1.5"><Label htmlFor="setup-email">Email</Label><Input id="setup-email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <PasswordField id="setup-password" label="Password" value={password} onChange={setPassword} autoComplete="new-password" hint="At least 8 characters, with a letter and a number." />
        <PasswordField id="setup-token" label="Setup token" value={setupToken} onChange={setSetupToken} autoComplete="off" hint="The SETUP_TOKEN value you set on this backend." />
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <Button type="submit" disabled={busy}>{busy ? "Setting up…" : "Create workspace"}</Button>
      </form>
    </Frame>
  );
}

/** /join/<token>: accept an invite (name + password) or use a reset link (new password), then you're in. */
export function JoinPage({ brand }: { brand: Brand }) {
  const { token: raw = "" } = useParams();
  const { signIn, signOut, me } = useSession();
  const navigate = useNavigate();
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    baseApi.checkLink(raw).then((i) => { setInfo(i); setName(i.name ?? ""); }, setLoadError);
  }, [raw]);
  if (loadError) return <Frame brand={brand} title="This link can't be used"><LoadError title="This link can't be used" error={loadError} /><Link to="/sign-in" className="text-body font-medium underline underline-offset-4">Go to sign in</Link></Frame>;
  if (!info) return <Frame brand={brand} title={brand.name}><Skeleton className="h-32 w-full" /></Frame>;
  const invite = info.kind === "invite";
  return (
    <Frame brand={brand} title={invite ? `Join ${brand.name}` : "Choose a new password"}
      description={invite ? <>{info.from ?? "Someone"} invited <span className="font-medium text-foreground">{info.email}</span> as {/^[aeiou]/i.test(info.role) ? "an" : "a"} {info.role}.</> : <>For <span className="font-medium text-foreground">{info.email}</span>.</>}>
      {me && <p className="text-xs text-muted-foreground">You're signed in as {me.name}. Continuing signs you in as {info.email} instead.</p>}
      <form className="grid gap-3" data-testid="join-form" onSubmit={async (e: FormEvent) => {
        e.preventDefault(); setBusy(true); setError(null);
        try {
          const r = await baseApi.acceptLink(raw, password, invite ? name.trim() : undefined);
          if (me) signOut();
          await signIn(r.authToken);
          navigate("/", { replace: true });
        } catch (err) { setError(messageOf(err)); }
        finally { setBusy(false); }
      }}>
        {invite && <div className="grid gap-1.5"><Label htmlFor="join-name">Your name</Label><Input id="join-name" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></div>}
        <PasswordField id="join-password" label={invite ? "Choose a password" : "New password"} value={password} onChange={setPassword} autoComplete="new-password" hint="At least 8 characters, with a letter and a number." />
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <Button type="submit" disabled={busy}>{busy ? "One moment…" : invite ? "Join" : "Save and sign in"}</Button>
      </form>
    </Frame>
  );
}

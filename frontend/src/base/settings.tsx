// /settings (BASELINE.md): the workspace (name, time zone, week start: team managers edit, everyone reads), your
// appearance, the keyboard shortcuts, and the way to the other places people look for settings.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, DoorClosed, Eraser, Keyboard, UserRound, Users } from "lucide-react";
import { toast } from "sonner";
import { useCan } from "@/base/access";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { AppearanceSettings, LoadError, PageHeader, ProfileSection, useLoad } from "@/components/kit";
import { baseApi } from "./api";
import { isGuest, useMe } from "./session";
import { openShortcuts } from "./shortcuts";
import { useWorkspace } from "./workspace";
import { FileStorageSection } from "@/pages/files/storage";
import { demoDataLines } from "@/lib/first-run";

const ZONES: string[] = (() => {
  try { return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? ["UTC"]; } catch { return ["UTC"]; }
})();

function WorkspaceSection() {
  const { settings, settingsError, reload } = useWorkspace();
  const canEdit = useCan("team.manage");
  const [name, setName] = useState("");
  const [zone, setZone] = useState("UTC");
  const [week, setWeek] = useState<"monday" | "sunday">("monday");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!settings) return;
    setName(settings.name); setZone(settings.timezone || "UTC"); setWeek(settings.week_start || "monday");
  }, [settings]);
  const zones = useMemo(() => (ZONES.includes(zone) ? ZONES : [zone, ...ZONES]), [zone]);
  const dirty = !!settings && (name.trim() !== settings.name || zone !== (settings.timezone || "UTC") || week !== (settings.week_start || "monday"));

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError("The workspace needs a name."); return; }
    setSaving(true);
    try { await baseApi.updateSettings({ name: name.trim(), timezone: zone, week_start: week }); setError(null); toast.success("Settings saved"); reload(); }
    catch (err) { setError(err instanceof Error ? err.message : "That didn't save. Try again."); }
    finally { setSaving(false); }
  }

  return (
    <ProfileSection title="Workspace" description={canEdit ? "Shown to everyone who signs in. Changes apply in every open tab at once." : "Only people who manage the team change these."}>
      {!settings && settingsError ? <LoadError error={settingsError} onRetry={reload} /> : !settings ? <div className="space-y-3"><Skeleton className="h-8 w-full max-w-sm" /><Skeleton className="h-8 w-full max-w-sm" /></div> : (
        <form onSubmit={save} className="grid max-w-sm gap-4" data-testid="settings-workspace">
          <div className="grid gap-1.5">
            <Label htmlFor="ws-name">Name</Label>
            <Input id="ws-name" value={name} disabled={!canEdit} maxLength={60} aria-invalid={!!error} aria-describedby={error ? "ws-name-error" : undefined}
              onChange={(e) => setName(e.target.value)} />
            {error && <p id="ws-name-error" className="text-xs text-destructive">{error}</p>}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ws-zone">Time zone</Label>
            <Select value={zone} onValueChange={setZone} disabled={!canEdit}>
              <SelectTrigger id="ws-zone" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">{zones.map((z) => <SelectItem key={z} value={z}>{z.replace(/_/g, " ")}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ws-week">Weeks start on</Label>
            <Select value={week} onValueChange={(v) => setWeek(v as "monday" | "sunday")} disabled={!canEdit}>
              <SelectTrigger id="ws-week" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="monday">Monday</SelectItem><SelectItem value="sunday">Sunday</SelectItem></SelectContent>
            </Select>
          </div>
          {canEdit && <div><Button type="submit" size="sm" disabled={!dirty || saving}>{saving ? "Saving…" : "Save changes"}</Button></div>}
        </form>
      )}
    </ProfileSection>
  );
}

/** The accounts that outlive demo mode, for the admin to confirm, then the one way out of it. */
function EndDemoDialog({ open, onOpenChange, onEnded }: { open: boolean; onOpenChange: (o: boolean) => void; onEnded: () => void }) {
  const others = useLoad(() => (open ? baseApi.otherAccounts() : Promise.resolve({ accounts: [] })), [open]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const accounts = others.data?.accounts ?? [];

  async function end() {
    setBusy(true); setError(null);
    try { await baseApi.endDemo(accounts.map((a) => a.id)); toast.success("Demo mode ended"); onOpenChange(false); onEnded(); }
    catch (err) { setError(err instanceof Error ? err.message : "That didn't work. Try again."); others.reload(); }
    finally { setBusy(false); }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="end-demo-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>End demo mode?</AlertDialogTitle>
          <AlertDialogDescription>Demo people sign out for good, open sign-up closes, and every agent key and open invite stops working. This can't be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        {others.error ? <LoadError error={others.error} onRetry={others.reload} /> : !others.data ? <Skeleton className="h-16 w-full" /> : accounts.length === 0
          ? <p className="text-body text-muted-foreground">Nobody else keeps an account. Invite your team when you're done.</p>
          : (
            <div className="grid gap-2">
              <p className="text-body font-medium">These accounts stay. Check you know each one:</p>
              <ul className="max-h-48 divide-y overflow-y-auto rounded-lg border text-body" data-testid="end-demo-accounts">
                {accounts.map((a) => (
                  <li key={a.id} className="flex min-w-0 items-center justify-between gap-3 px-3 py-2">
                    <span className="min-w-0 truncate"><span className="font-medium">{a.name}</span>{a.email && <span className="text-muted-foreground"> · {a.email}</span>}</span>
                    <span className="shrink-0 text-xs text-muted-foreground capitalize">{a.role}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep demo mode</AlertDialogCancel>
          <AlertDialogAction data-testid="end-demo-confirm" disabled={busy || !others.data} onClick={(e) => { e.preventDefault(); void end(); }}>{busy ? "Ending…" : "End demo mode"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Clearing the demo company: what goes, counted, and what stays. It lands on the overview, which now shows only real work. */
function ClearDemoDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const counts = useLoad(() => (open ? baseApi.demoData() : Promise.resolve(null)), [open]);
  const navigate = useNavigate();
  const queries = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lines = counts.data ? demoDataLines(counts.data) : [];

  async function clear() {
    setBusy(true); setError(null);
    try {
      await baseApi.clearDemo();
      onOpenChange(false);
      await queries.invalidateQueries();
      navigate("/");
      toast.success("Demo data cleared", { description: "What's left is your team's own work." });
    } catch (err) { setError(err instanceof Error ? err.message : "That didn't work. Try again."); }
    finally { setBusy(false); }
  }

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <AlertDialogContent data-testid="clear-demo-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Clear demo data?</AlertDialogTitle>
          <AlertDialogDescription>The sample company goes, with the demo people and agents. This can't be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        {counts.error ? <LoadError error={counts.error} onRetry={counts.reload} /> : !counts.data ? <Skeleton className="h-20 w-full" /> : lines.length === 0
          ? <p className="text-body text-muted-foreground">There's no demo data left to clear.</p>
          : (
            <ul className="grid gap-1 rounded-lg border px-3 py-2 text-body" data-testid="clear-demo-counts">
              {lines.map((l) => <li key={l} className="flex items-start gap-2"><span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground" />{l}</li>)}
            </ul>
          )}
        <p className="text-body text-muted-foreground">Anything your team made stays, with the spaces and customers it's in, and so do the pipeline stages. Demo mode stays on: open sign-up stays open until you end it.</p>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
          <AlertDialogAction data-testid="clear-demo-confirm" variant="destructive" disabled={busy || !lines.length} onClick={(e) => { e.preventDefault(); void clear(); }}>{busy ? "Clearing…" : "Clear demo data"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The two ways out of the demo, side by side, for people who manage the team. Clearing removes the sample company; ending closes
 * the doors a demo leaves open. A demo admin can do neither, because their own account is one of the things that stops.
 */
function DemoSection() {
  const { settings, reload } = useWorkspace();
  const me = useMe();
  const canManage = useCan("team.manage");
  const [ending, setEnding] = useState(false);
  const [clearing, setClearing] = useState(false);
  const real = canManage && !me.is_demo;
  const left = useLoad(() => (real ? baseApi.demoData() : Promise.resolve(null)), [real, clearing]);
  const hasData = !!left.data && demoDataLines(left.data).length > 0;
  if (!canManage || (!settings?.demo_mode && !hasData)) return null;
  return (
    <ProfileSection title="Demo" description={!settings?.demo_mode ? "Demo mode is off. The sample company is still here."
      : hasData || !left.data ? "This workspace is open for demos: anyone can sign in as a demo person or create an account."
      : "The demo data is cleared and the demo people are switched off. Open sign-up stays on until you end demo mode."}>
      {me.is_demo
        ? <p className="text-muted-foreground" data-testid="end-demo-blocked">Demo accounts stop working when you clear demo data or end demo mode. <Link to="/team?invite=1" className="font-medium text-foreground underline underline-offset-4">Invite yourself as an admin</Link>, sign in with that account, then do it here.</p>
        : (
          <div className="grid gap-4" data-testid="demo-controls">
            {hasData && <p className="text-muted-foreground">Clear demo data removes the sample company. End demo mode closes demo sign-in and open sign-up. Do both before you invite your team.</p>}
            {hasData && (
              <div className="flex flex-col items-start gap-1.5">
                <Button variant="outline" size="sm" data-testid="clear-demo" onClick={() => setClearing(true)}><Eraser />Clear demo data</Button>
                <p className="text-caption text-muted-foreground">Your own work stays.</p>
              </div>
            )}
            {settings?.demo_mode && (
              <div className="flex flex-col items-start gap-1.5">
                <Button variant="outline" size="sm" data-testid="end-demo" onClick={() => setEnding(true)}><DoorClosed />End demo mode</Button>
                <p className="text-caption text-muted-foreground">{hasData ? "The sample company stays until you clear it." : "Closes open sign-up for good. Do it before you invite your team."}</p>
              </div>
            )}
          </div>
        )}
      <ClearDemoDialog open={clearing} onOpenChange={setClearing} />
      <EndDemoDialog open={ending} onOpenChange={setEnding} onEnded={reload} />
    </ProfileSection>
  );
}

function AppearanceSection() {
  return (
    <ProfileSection title="Appearance" description="On this device. System follows your computer.">
      <AppearanceSettings />
    </ProfileSection>
  );
}

export function SettingsPage() {
  const canManage = useCan("team.manage");
  const guest = isGuest(useMe());
  const more = [
    { href: "/profile", icon: UserRound, label: "Profile", hint: "Your name and password" },
    ...(canManage ? [{ href: "/team", icon: Users, label: "Team", hint: "Roles and invites" }] : []),
    ...(guest ? [] : [{ href: "/agents", icon: Bot, label: "Agents", hint: "Keys and sign-ins for your AI agents" }]),
  ];
  return (
    <div className="flex max-w-3xl flex-col gap-6" data-testid="settings-page">
      <PageHeader title="Settings" description="The workspace, how the app looks for you, and where everything else is set." />
      {!guest && <WorkspaceSection />}
      <DemoSection />
      <FileStorageSection />
      <AppearanceSection />
      <ProfileSection title="Keyboard" description="Everything has a shortcut.">
        <Button variant="outline" size="sm" onClick={openShortcuts}><Keyboard />Show keyboard shortcuts</Button>
      </ProfileSection>
      <ProfileSection title="Elsewhere">
        <ul className="-my-1 divide-y">
          {more.map((m) => (
            <li key={m.href}>
              <Link to={m.href} className="flex items-center gap-3 py-2 hover:text-foreground">
                <m.icon aria-hidden className="size-4 text-muted-foreground" />
                <span className="font-medium">{m.label}</span>
                <span className="text-muted-foreground">{m.hint}</span>
              </Link>
            </li>
          ))}
        </ul>
      </ProfileSection>
    </div>
  );
}

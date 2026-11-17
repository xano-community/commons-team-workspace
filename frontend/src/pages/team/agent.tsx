// /team/agents/:id, an agent's own page (KTD6): what state it's in and what its role lets it do, what it's for and who answers for it,
// its keys, then its runs and what it did. Everything here is read for this viewer: a run from a DM they're not in, or a space they
// can't open, isn't there. Admins change the brief, the spaces and the sponsor, and bring a stopped agent back. The sponsor or an
// admin makes and revokes keys. Guests never reach this page.
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Link, Navigate, useParams } from "react-router";
import { ArrowLeft, Check, CircleSlash, Copy, KeyRound, Pencil, Plus, Power, ShieldCheck, Terminal, UserRoundCog, Users } from "lucide-react";
import { mcpUrl, serverSlug } from "@xano-sdk/agents/react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Ago, Avatar, EmptyState, LoadError, PanelList, StatusBadge } from "@/components/kit";
import { AgentMark } from "@/components/workspace/agent-mark";
import { Person } from "@/components/workspace/person";
import { RunSteps } from "@/components/workspace/run-steps";
import { MemberActivity } from "@/base/activity";
import { ApiError, XANO_HOST, request } from "@/base/request";
import { isGuest, useMe } from "@/base/session";
import { useWorkspace } from "@/base/workspace";
import { useAgentKeys, useAgentProfile, useAgentRuns, useKeyActions, useManageAgent, useRunActions, useSponsorChoices } from "@/lib/agents/client";
import { keyCommand, runLine, type AgentRun } from "@/lib/agents/model";
import { useShowsKeyCommand } from "@/lib/first-run";
import { useAllSpaces } from "@/lib/data";
import { routePath } from "../../../../xano/routes.gen.js";
import type { AgentKey, AgentProfile } from "../../../../xano/query/agents.js";
import { shellToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const BRIEF_MAX = 1000;
const KEY_DAYS = [7, 30, 90] as const;
const DOT = { live: "bg-agent-text motion-safe:animate-pulse", waiting: "bg-muted-foreground", done: "bg-muted-foreground/60", failed: "bg-destructive" } as const;

async function copyText(text: string, what = "Copied") {
  try { await navigator.clipboard.writeText(text); shellToast.show(what); }
  catch { shellToast.error("Your browser wouldn't copy that. Select the text instead."); }
}

/** A titled card. Each section of the page is one, with its own empty state. */
function Section({ title, action, children, className, testId }: { title: string; action?: ReactNode; children: ReactNode; className?: string; testId?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} data-testid={testId} className={cn("flex min-w-0 flex-col rounded-lg border bg-card", className)}>
      <header className="flex min-h-12 items-center justify-between gap-2 border-b px-4 py-2">
        <h2 id={id} className="text-heading">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

/** One plain line for where an agent stands now. */
function stateOf(a: AgentProfile): { label: string; detail: ReactNode; tone: "live" | "waiting" | "done" | "failed" } {
  if (a.status === "removed") return { label: "Removed", detail: "It left the workspace. Its name stays on its past work.", tone: "done" };
  if (a.status === "disabled") return { label: "Stopped", detail: "It isn't working, and its keys have ended. Its past work stays as it was.", tone: "failed" };
  if (a.paused) return { label: "Paused", detail: "Every agent is paused. Requests wait here until an admin turns agents back on.", tone: "waiting" };
  if (a.mode === "hosted") {
    if (!a.model_ready) return { label: "Waiting for a model key", detail: `Mentions and tasks queue until ${a.key_name} is set.`, tone: "waiting" };
    return { label: "Ready", detail: "It starts when someone mentions it or gives it a task in one of its spaces.", tone: "live" };
  }
  if (a.last_seen) return { label: "Connected", detail: <>Last seen <Ago value={a.last_seen} />. It picks up work when it next runs.</>, tone: "live" };
  return { label: a.has_key ? "Not seen yet" : "Needs a key", detail: a.has_key ? "It has a key and hasn't called in yet. It picks up work when it first runs." : "It runs somewhere else, with a key made here. Make one below to connect it.", tone: "waiting" };
}

function Header({ a }: { a: AgentProfile }) {
  const state = stateOf(a);
  return (
    <header data-testid="agent-header" className="overflow-hidden rounded-lg border bg-card">
      <div aria-hidden className="h-8 bg-agent-wash/70" />
      <div className="-mt-4 flex flex-wrap items-end gap-x-4 gap-y-3 px-4 pb-4 sm:px-5">
        <Avatar name={a.name} kind="agent" size="lg" className="size-16 text-title ring-4 ring-card" decorative />
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="min-w-0 text-title wrap-anywhere text-agent-text" data-testid="agent-name">{a.name}</h1>
            <AgentMark />
          </div>
          <p className="mt-0.5 text-body text-muted-foreground">{a.mode === "hosted" ? "Works here, when it's asked" : "Connects from elsewhere, with its own key"}</p>
        </div>
        <div role="status" data-testid="agent-state" data-state={state.label} className="flex min-w-0 items-center gap-2 rounded-full border bg-background px-3 py-1 text-caption font-medium">
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[state.tone])} />{state.label}
        </div>
      </div>
    </header>
  );
}

/** A sponsor picker, for handing an agent over and for bringing one back. Follows the Team page's Remove dialog. */
function SponsorDialog({ a, mode, open, onOpenChange }: { a: AgentProfile; mode: "change" | "revive"; open: boolean; onOpenChange: (o: boolean) => void }) {
  const choices = useSponsorChoices(open);
  const manage = useManageAgent();
  const [sponsor, setSponsor] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = (o: boolean) => { onOpenChange(o); if (!o) { setSponsor(""); setError(null); } };
  const people = (choices.data ?? []).filter((p) => mode === "revive" || p.id !== a.sponsor.id);
  async function go() {
    setBusy(true); setError(null);
    try {
      if (mode === "change") {
        const moved = await manage.sponsor(a.id, Number(sponsor));
        shellToast.show(moved.revoked ? `${a.name} has a new sponsor. Its ${moved.revoked === 1 ? "key" : `${moved.revoked} keys`} ended.` : `${a.name} has a new sponsor`);
      } else {
        await manage.revive(a.id, Number(sponsor));
        shellToast.show(`${a.name} is back`);
      }
      close(false);
    } catch (e) { setError(e instanceof Error ? e.message : "That didn't go through. Try again."); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md" data-testid={mode === "change" ? "sponsor-dialog" : "revive-dialog"}>
        <DialogHeader>
          <DialogTitle>{mode === "change" ? `Who sponsors ${a.name} next?` : `Bring ${a.name} back?`}</DialogTitle>
          <DialogDescription>
            {mode === "change"
              ? `The sponsor answers for ${a.name} and decides what it asks to do. ${a.mode === "connected" ? "Its keys end, so the new sponsor makes fresh ones. " : ""}What it's waiting on moves to them, and its history stays as it was.`
              : `It starts working again under the sponsor you choose. ${a.mode === "connected" ? "Its old keys stay ended, so they make a new one." : "Mentions and tasks reach it again."}`}
          </DialogDescription>
        </DialogHeader>
        {choices.error ? <LoadError error={choices.error} onRetry={() => void choices.refetch()} /> : (
          <div className="grid gap-1.5">
            <Label htmlFor="sponsor-pick">Sponsor</Label>
            <Select value={sponsor} onValueChange={setSponsor} disabled={!choices.data}>
              <SelectTrigger id="sponsor-pick" className="w-full" data-testid="sponsor-pick"><SelectValue placeholder={choices.data ? "Choose a member or an admin" : "Loading people…"} /></SelectTrigger>
              <SelectContent>{people.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}</SelectContent>
            </Select>
            <p className="text-caption text-muted-foreground">Guests can't sponsor an agent.</p>
          </div>
        )}
        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
          <Button data-testid="sponsor-confirm" disabled={busy || !sponsor} onClick={() => void go()}>
            {mode === "change" ? <UserRoundCog /> : <Power />}{busy ? "Saving…" : mode === "change" ? "Hand it over" : "Bring it back"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StoppedBanner({ a }: { a: AgentProfile }) {
  const [reviving, setReviving] = useState(false);
  if (a.status === "active") return null;
  const removed = a.status === "removed";
  return (
    <div role="status" data-testid="agent-stopped" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-muted/50 px-4 py-3 text-body">
      <CircleSlash aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 basis-60 text-pretty">
        <span className="font-medium">{removed ? `${a.name} was removed.` : `${a.name} is stopped.`}</span>{" "}
        <span className="text-muted-foreground">
          {removed ? "Its name stays on what it did. Add a new agent to take on its work."
            : a.sponsor.active ? "Demo mode ended, so it stopped with the demo." : "Its sponsor left, so nobody answers for it."}
          {!removed && !a.can_manage && " An admin can bring it back with a new sponsor."}
        </span>
      </p>
      {!removed && a.can_manage && <Button size="sm" data-testid="agent-revive" onClick={() => setReviving(true)} className="max-sm:min-h-11"><Power />Bring it back</Button>}
      <SponsorDialog a={a} mode="revive" open={reviving} onOpenChange={setReviving} />
    </div>
  );
}

function StateAndRole({ a }: { a: AgentProfile }) {
  const state = stateOf(a);
  const { name } = useWorkspace();
  const showsCommand = useShowsKeyCommand();
  return (
    <Section title="State and role" testId="agent-role">
      <dl className="grid gap-3 px-4 py-3 text-body">
        <div>
          <dt className="text-caption text-muted-foreground">Now</dt>
          <dd className="mt-0.5 text-pretty"><span className="font-medium">{state.label}.</span> {state.detail}</dd>
          {a.mode === "hosted" && a.status === "active" && !a.model_ready && (showsCommand ? (
            <dd className="mt-1.5 flex min-w-0 items-center gap-1" data-testid="agent-key-command">
              <code className="min-w-0 flex-1 rounded-sm bg-muted px-1.5 py-0.5 text-caption wrap-anywhere">{keyCommand(a.key_name)}</code>
              <Button type="button" size="icon-sm" variant="ghost" aria-label="Copy command" className="max-md:size-11" onClick={() => void copyText(keyCommand(a.key_name))}><Copy /></Button>
            </dd>
          ) : <dd className="mt-1 text-caption text-muted-foreground" data-testid="agent-ask-admin">Ask an admin to add a model key. Its work starts by itself once they have.</dd>)}
        </div>
        <div>
          <dt className="text-caption text-muted-foreground">Role</dt>
          <dd className="mt-0.5 flex items-start gap-2 text-pretty">
            <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>Agent. It works in its spaces like a member of {name ?? "the team"}. It can't manage the team, approve anything or change settings, and anything a guest could see waits for a person first.</span>
          </dd>
        </div>
      </dl>
    </Section>
  );
}

function BriefAndSponsor({ a }: { a: AgentProfile }) {
  const manage = useManageAgent();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(a.brief);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handing, setHanding] = useState(false);
  const canEdit = a.can_manage && a.status === "active";
  useEffect(() => { if (!editing) setDraft(a.brief); }, [a.brief, editing]);
  async function save() {
    setBusy(true); setError(null);
    try { await manage.update(a.id, { brief: draft.trim() }); setEditing(false); shellToast.show("Brief saved"); }
    catch (e) { setError(e instanceof Error ? e.message : "That didn't save. Try again."); }
    finally { setBusy(false); }
  }
  return (
    <Section title="Brief and sponsor" testId="agent-brief-section"
      action={canEdit && !editing ? <Button size="sm" variant="ghost" data-testid="brief-edit" onClick={() => setEditing(true)} className="max-md:min-h-11"><Pencil />Edit brief</Button> : undefined}>
      <div className="flex flex-col gap-4 px-4 py-3">
        {editing ? (
          <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <Label htmlFor="brief-text" className="sr-only">Brief</Label>
            <Textarea id="brief-text" data-testid="brief-input" autoFocus value={draft} maxLength={BRIEF_MAX} rows={5} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setEditing(false); } }} aria-describedby="brief-help" />
            <p id="brief-help" className="text-caption text-muted-foreground">{a.mode === "hosted" ? "Every run starts from this. Say what it's for and how it should work, in plain words." : "Shown to the team, so they know what it's for."} {BRIEF_MAX - draft.length} characters left.</p>
            {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setEditing(false)} className="max-md:min-h-11">Cancel</Button>
              <Button type="submit" size="sm" data-testid="brief-save" disabled={busy || (a.mode === "hosted" && !draft.trim()) || draft.trim() === a.brief} className="max-md:min-h-11"><Check />{busy ? "Saving…" : "Save brief"}</Button>
            </div>
          </form>
        ) : a.brief ? (
          <p data-testid="agent-page-brief" className="text-body text-pretty whitespace-pre-line">{a.brief}</p>
        ) : (
          <p className="text-body text-muted-foreground">No brief yet. {canEdit ? "Say what it's for, so the team knows when to ask it." : "An admin can add one."}</p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <div className="min-w-0">
            <p className="text-caption text-muted-foreground">Sponsor</p>
            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-body" data-testid="agent-sponsor">
              {a.sponsor.name ? <Person name={a.sponsor.name} kind="human" size="sm" /> : <span className="text-muted-foreground">Nobody</span>}
              {!a.sponsor.active && a.sponsor.name && <StatusBadge>Left</StatusBadge>}
            </div>
            <p className="mt-1 text-caption text-pretty text-muted-foreground">Answers for {a.name}, and decides what it asks to do.</p>
          </div>
          {canEdit && !a.is_demo && <Button size="sm" variant="outline" data-testid="sponsor-change" onClick={() => setHanding(true)} className="max-md:min-h-11"><UserRoundCog />Change sponsor</Button>}
        </div>
      </div>
      <SponsorDialog a={a} mode="change" open={handing} onOpenChange={setHanding} />
    </Section>
  );
}

function SpacesDialog({ a, open, onOpenChange }: { a: AgentProfile; open: boolean; onOpenChange: (o: boolean) => void }) {
  const spaces = useAllSpaces();
  const manage = useManageAgent();
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setPicked(a.spaces.map((s) => s.id)); setError(null); } }, [open, a.spaces]);
  const toggle = (id: number, on: boolean) => setPicked((p) => (on ? [...new Set([...p, id])] : p.filter((x) => x !== id)));
  const open_ = (spaces.data?.spaces ?? []).filter((s) => !s.archived_at || a.spaces.some((m) => m.id === s.id));
  async function save() {
    setBusy(true); setError(null);
    try { await manage.setSpaces(a.id, picked); onOpenChange(false); shellToast.show("Spaces saved"); }
    catch (e) { setError(e instanceof Error ? e.message : "That didn't save. Try again."); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="spaces-dialog">
        <DialogHeader>
          <DialogTitle>Where {a.name} works</DialogTitle>
          <DialogDescription>It reads and writes only in these spaces. Leaving a space ends anything it was doing there.</DialogDescription>
        </DialogHeader>
        {spaces.error ? <LoadError error={spaces.error} onRetry={() => void spaces.refetch()} /> : !spaces.data ? <Skeleton className="h-24 w-full" /> : (
          <ul className="flex max-h-72 flex-col overflow-y-auto rounded-md border">
            {open_.map((s) => (
              <li key={s.id} className="border-b last:border-b-0">
                <label className="flex min-h-10 cursor-pointer items-center gap-3 px-3 py-2 text-body max-sm:min-h-11">
                  <Checkbox checked={picked.includes(s.id)} onCheckedChange={(v) => toggle(s.id, v === true)} aria-label={s.name} />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  {s.archived_at && <StatusBadge>Archived</StatusBadge>}
                </label>
              </li>
            ))}
          </ul>
        )}
        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button data-testid="spaces-save" disabled={busy || !spaces.data} onClick={() => void save()}><Check />{busy ? "Saving…" : "Save spaces"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Spaces({ a }: { a: AgentProfile }) {
  const [editing, setEditing] = useState(false);
  const canEdit = a.can_manage && a.status === "active";
  return (
    <Section title="Spaces" testId="agent-spaces" action={canEdit ? <Button size="sm" variant="ghost" data-testid="spaces-edit" onClick={() => setEditing(true)} className="max-md:min-h-11"><Users />Change</Button> : undefined}>
      <div className="px-4 py-3">
        {a.spaces.length === 0 && !a.hidden_spaces ? (
          <p className="text-body text-muted-foreground">Not in any space yet, so nothing reaches it. {canEdit ? "Add it to the spaces where it should work." : "An admin can add it to a space."}</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {a.spaces.map((s) => <li key={s.id}><Link to={`/chat?space=${s.id}`} className="focus-ring inline-flex min-h-7 items-center gap-1 rounded-md border bg-background px-2 text-caption font-medium hover:bg-muted max-md:min-h-11">{s.name}{s.archived_at && <span className="font-normal text-muted-foreground"> · archived</span>}</Link></li>)}
            {a.hidden_spaces > 0 && <li className="inline-flex min-h-7 items-center px-1 text-caption text-muted-foreground">and {a.hidden_spaces === 1 ? "1 space" : `${a.hidden_spaces} spaces`} you're not in</li>}
          </ul>
        )}
      </div>
      {canEdit && <SpacesDialog a={a} open={editing} onOpenChange={setEditing} />}
    </Section>
  );
}

/** Where an MCP client connects, from the module's own info route. */
function useServer() {
  const info = useQuery({ queryKey: ["agent-info"], queryFn: () => request<{ canonical: string }>("GET", routePath("GET agent/info")), staleTime: Infinity });
  const url = info.data ? mcpUrl(XANO_HOST || location.origin, info.data.canonical) : "";
  return { url, slug: serverSlug(info.data?.canonical ?? "") };
}

/** The one time a key's secret is on screen: copy it, connect with it, and say so before it goes. */
function ShowOnce({ token, onDone }: { token: string; onDone: () => void }) {
  const { url, slug } = useServer();
  const command = `claude mcp add --transport http --scope user ${slug} ${url} --header "Authorization: Bearer ${token}"`;
  const row = (label: string, value: string, testId: string, mono = true) => (
    <div className="grid gap-1">
      <span className="text-caption text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-start gap-1">
        <code data-testid={testId} tabIndex={0} className={cn("max-h-16 min-w-0 flex-1 overflow-y-auto rounded-md border bg-background px-2 py-1.5 text-caption wrap-anywhere select-all focus-ring", !mono && "font-sans")}>{value || "…"}</code>
        <Button type="button" size="icon-sm" variant="ghost" aria-label={`Copy ${label.toLowerCase()}`} disabled={!value} onClick={() => void copyText(value)} className="max-md:size-11"><Copy /></Button>
      </div>
    </div>
  );
  return (
    <div role="region" aria-label="Your new key" data-testid="key-once" className="mx-4 my-3 flex flex-col gap-3 rounded-lg border border-agent/40 bg-agent-wash/40 p-3">
      <div className="flex items-start gap-2">
        <KeyRound aria-hidden className="mt-0.5 size-4 shrink-0 text-agent-text" />
        <p className="text-body text-pretty"><span className="font-medium">Copy this key now.</span> It shows once. If it's lost, revoke it and make another.</p>
      </div>
      {row("Key", token, "key-token")}
      {row("MCP server", url, "key-server")}
      <div className="grid gap-1">
        <span className="flex items-center gap-1 text-caption text-muted-foreground"><Terminal aria-hidden className="size-3.5" />Connect Claude Code</span>
        <div className="flex min-w-0 items-start gap-1">
          <code data-testid="key-command" tabIndex={0} className="max-h-24 min-w-0 flex-1 overflow-y-auto rounded-md border bg-background px-2 py-1.5 text-caption wrap-anywhere select-all focus-ring">{url ? command : "…"}</code>
          <Button type="button" size="icon-sm" variant="ghost" aria-label="Copy the connect command" disabled={!url} onClick={() => void copyText(command)} className="max-md:size-11"><Copy /></Button>
        </div>
        <p className="text-caption text-muted-foreground">Run it in a terminal, then type /mcp in Claude Code: {slug || "the server"} shows as connected. Any MCP client works with the server address and this key as a Bearer token.</p>
      </div>
      <div className="flex justify-end"><Button size="sm" data-testid="key-saved" onClick={onDone} className="max-md:min-h-11"><Check />I have saved it</Button></div>
    </div>
  );
}

function MakeKeyDialog({ a, open, onOpenChange, onMade }: { a: AgentProfile; open: boolean; onOpenChange: (o: boolean) => void; onMade: (token: string) => void }) {
  const keys = useKeyActions(a.id);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "read_write">("read_write");
  const [days, setDays] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = (o: boolean) => { onOpenChange(o); if (!o) { setName(""); setError(null); setScope("read_write"); setDays("30"); } };
  async function make() {
    setBusy(true); setError(null);
    try { const made = await keys.make(name.trim(), scope, Number(days)); close(false); onMade(made.token); }
    catch (e) { setError(e instanceof Error ? e.message : "That didn't go through. Try again."); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md" data-testid="key-dialog">
        <DialogHeader>
          <DialogTitle>A key for {a.name}</DialogTitle>
          <DialogDescription>Whatever holds it acts as {a.name}, in its spaces only. You see it once, then only its name.</DialogDescription>
        </DialogHeader>
        <form id="make-key" className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void make(); }}>
          <div className="grid gap-1.5">
            <Label htmlFor="key-name">Where it runs</Label>
            <Input id="key-name" data-testid="key-name" autoFocus required maxLength={60} placeholder="Morgan's laptop" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="key-scope">What it can do</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as "read" | "read_write")}>
              <SelectTrigger id="key-scope" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="read_write">Read and write</SelectItem>
                <SelectItem value="read">Read only</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="key-days">Lasts</Label>
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger id="key-days" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{KEY_DAYS.map((d) => <SelectItem key={d} value={String(d)}>{d} days</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
          <Button type="submit" form="make-key" data-testid="key-make" disabled={busy || !name.trim()}><KeyRound />{busy ? "Making it…" : "Make the key"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KeyRow({ a, k }: { a: AgentProfile; k: AgentKey }) {
  const keys = useKeyActions(a.id);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const expired = !!k.expires_at && Number(k.expires_at) < Date.now();
  return (
    <li data-testid="key-row" data-revoked={k.revoked || undefined} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
      <KeyRound aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 basis-40">
        <p className={cn("truncate text-body font-medium", (k.revoked || expired) && "text-muted-foreground line-through decoration-muted-foreground/50")}>{k.name}</p>
        <p className="text-caption text-muted-foreground">
          {k.scope === "read" ? "Read only" : "Read and write"} · {k.revoked ? "Revoked" : expired ? "Ran out" : k.expires_at ? <>Ends <Ago value={k.expires_at} /></> : "No end date"}
          {k.last_used_at ? <> · used <Ago value={k.last_used_at} /></> : " · never used"}
        </p>
      </div>
      {!k.revoked && !expired && (asking ? (
        <span className="flex items-center gap-1.5">
          <span className="text-caption text-muted-foreground">It stops at once.</span>
          <Button size="xs" variant="ghost" onClick={() => setAsking(false)} className="max-md:min-h-11">Keep it</Button>
          <Button size="xs" variant="destructive" data-testid="key-revoke-confirm" disabled={busy} className="max-md:min-h-11"
            onClick={() => { setBusy(true); void keys.revoke(k.id).then(() => shellToast.show("Key revoked"), (e: unknown) => shellToast.error(e instanceof Error ? e.message : "That didn't go through. Try again.")).finally(() => { setBusy(false); setAsking(false); }); }}>Revoke</Button>
        </span>
      ) : <Button size="xs" variant="ghost" data-testid="key-revoke" onClick={() => setAsking(true)} className="max-md:min-h-11">Revoke</Button>)}
    </li>
  );
}

function Keys({ a }: { a: AgentProfile }) {
  const list = useAgentKeys(a.id, a.can_keys);
  const [making, setMaking] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  if (a.mode === "hosted") {
    return (
      <Section title="Keys" testId="agent-keys">
        <p className="px-4 py-3 text-body text-pretty text-muted-foreground">It works here, so it needs no key. Each run gets its own short-lived access, made when it starts and gone when it ends.</p>
      </Section>
    );
  }
  if (!a.can_keys) {
    return (
      <Section title="Keys" testId="agent-keys">
        <p className="px-4 py-3 text-body text-pretty text-muted-foreground">{a.status !== "active" ? "Its keys ended when it stopped." : `${a.has_key ? "It has a key." : "It has no key yet."} Its sponsor or an admin makes and revokes them.`}</p>
      </Section>
    );
  }
  const live = (list.data?.items ?? []).filter((k) => !k.revoked);
  return (
    <Section title="Keys" testId="agent-keys" action={!token ? <Button size="sm" variant="outline" data-testid="key-new" onClick={() => setMaking(true)} className="max-md:min-h-11"><Plus />Make a key</Button> : undefined}>
      {token && <ShowOnce token={token} onDone={() => setToken(null)} />}
      <PanelList loading={!list.data && !list.error} error={list.error} onRetry={() => void list.refetch()} rows={2}
        empty={<span>No keys yet. Make one for wherever {a.name} runs, then connect it with what this page shows.</span>}>
        {[...live, ...(list.data?.items ?? []).filter((k) => k.revoked)].map((k) => <KeyRow key={k.id} a={a} k={k} />)}
      </PanelList>
      <MakeKeyDialog a={a} open={making} onOpenChange={setMaking} onMade={setToken} />
    </Section>
  );
}

function RunRow({ run, record }: { run: AgentRun; record?: { state: string; title: string; href: string } }) {
  const { nameOf } = useWorkspace();
  const actions = useRunActions();
  const [busy, setBusy] = useState(false);
  const line = runLine(run, { modelReady: true, nameOf, guest: false });
  const where = record && (record.state === "live" || record.state === "archived") && record.title ? record : null;
  const act = (go: (id: number) => Promise<unknown>) => () => { setBusy(true); void go(run.id).finally(() => setBusy(false)); };
  return (
    <li data-testid="agent-run" data-state={run.status} data-reason={run.reason || undefined} className="flex min-w-0 flex-col gap-1 px-4 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[line.tone])} />
        {/* A run that changes while the page is open is read out, with what it's on (R39). */}
        <span role="status" aria-atomic="true" className={cn("shrink-0 text-caption font-medium", line.tone === "failed" ? "text-destructive" : "text-foreground")}>
          <span data-testid="agent-run-label">{line.label}</span><span className="sr-only">{where ? `, ${where.title}` : ""}</span>
        </span>
        <span className="min-w-0 flex-1 truncate text-body">
          {where ? <Link to={where.href} className="focus-ring rounded-sm underline-offset-2 hover:underline">{where.title}</Link> : <span className="text-muted-foreground">Something you can't open</span>}
        </span>
        <span className="shrink-0 text-caption text-muted-foreground"><Ago value={run.created_at} /></span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-3.5">
        <span className="text-caption text-muted-foreground">Asked by {nameOf(run.requested_by)}</span>
        {line.canStop && <Button size="xs" variant="ghost" disabled={busy} onClick={act(actions.stop)} className="-my-1 max-md:min-h-11">Stop</Button>}
        {line.canRetry && <Button size="xs" variant="outline" disabled={busy} onClick={act(actions.retry)} className="-my-1 max-md:min-h-11">Retry</Button>}
      </div>
      {line.note && <p className="pl-3.5 text-caption text-pretty wrap-anywhere text-muted-foreground">{line.note}</p>}
      {line.worked && <RunSteps run={run} guest={false} className="pl-3" />}
    </li>
  );
}

function Runs({ a }: { a: AgentProfile }) {
  const list = useAgentRuns(a.id);
  return (
    <Section title="Runs" testId="agent-runs">
      <PanelList loading={!list.data && !list.error} error={list.error} onRetry={() => void list.refetch()} rows={3}
        empty={a.mode === "hosted" ? `Nothing yet. Mention ${a.name} in a conversation, or give it a task, and its work shows here.` : `${a.name} works through its inbox, not runs here. What it does shows under Activity.`}>
        {list.data?.items.map((r, i) => <RunRow key={r.id} run={r} record={list.data.records[i]} />)}
      </PanelList>
      {!!list.data?.items.length && <p className="border-t px-4 py-2 text-caption text-muted-foreground">Only runs you can open are listed.</p>}
    </Section>
  );
}

function Activity({ a }: { a: AgentProfile }) {
  return (
    <Section title="Activity" testId="agent-activity">
      <MemberActivity id={a.id} empty={`Nothing recorded yet. When ${a.name} changes a task, doc, customer or file, it shows here.`} />
    </Section>
  );
}

function LoadingPage() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading the agent">
      <Skeleton className="h-32 w-full rounded-lg" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
        <div className="flex flex-col gap-4"><Skeleton className="h-40 rounded-lg" /><Skeleton className="h-48 rounded-lg" /></div>
        <Skeleton className="h-96 rounded-lg" />
      </div>
    </div>
  );
}

export function AgentPage() {
  const me = useMe();
  const id = Number(useParams().id);
  const page = useAgentProfile(id);
  const a = page.data;
  const back = useMemo(() => <Link to="/team" data-kit="back" className="focus-ring -ml-1 inline-flex min-h-7 items-center gap-1 self-start rounded-sm px-1 text-caption text-muted-foreground transition-colors hover:text-foreground max-md:min-h-11"><ArrowLeft aria-hidden className="size-3.5" />Team</Link>, []);
  useEffect(() => { if (a) document.title = `${a.name} · Agents`; }, [a]);
  if (isGuest(me)) return <Navigate to="/" replace />;
  if (page.error) {
    const missing = page.error instanceof ApiError && (page.error.status === 404 || page.error.status === 403);
    return (
      <div className="flex flex-col gap-4">{back}
        {missing ? <EmptyState icon={CircleSlash} title="This agent isn't here" description="It may have been removed, or the link is old. Everyone who works here is on the Team page." action={<Button asChild variant="outline"><Link to="/team">Open Team</Link></Button>} />
          : <LoadError error={page.error} onRetry={() => void page.refetch()} />}
      </div>
    );
  }
  return (
    <div data-signature-view="agent" data-testid="agent-page" className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      {back}
      {!a ? <LoadingPage /> : (
        <>
          <Header a={a} />
          <StoppedBanner a={a} />
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
            <div className="flex min-w-0 flex-col gap-4">
              <StateAndRole a={a} />
              <BriefAndSponsor a={a} />
              <Spaces a={a} />
              <Keys a={a} />
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              <Runs a={a} />
              <Activity a={a} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

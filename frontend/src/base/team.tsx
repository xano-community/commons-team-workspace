// /team (BASELINE.md): RBAC's Team page (roles, safely changed, with a record), plus inviting people, issuing
// password-reset links and removing members. No email is needed: a link is shown once to copy and send however you like.
import { Suspense, lazy, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ArrowRight, Bot, Copy, KeyRound, MailPlus, MoreHorizontal, Plug, ShieldCheck, UserMinus, UserPlus } from "lucide-react";
import { toast } from "sonner";
import type { RbacMember } from "@xano-sdk/rbac";
import { RbacProvider, TeamPage, useRbac } from "@xano-sdk/rbac/react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Ago, LoadError, StatusBadge, useLoad } from "@/components/kit";
import { useManageAgent, useSponsorChoices } from "@/lib/agents/client";
import { useAllSpaces } from "@/lib/data";
import { cn } from "@/lib/utils";
import { AgentMark } from "@/components/workspace/agent-mark";
import { baseApi, joinUrl } from "./api";
import { useLive } from "./live";
import { rbacClient } from "./rbac-client";
import { useMe } from "./session";
import { useWorkspace } from "./workspace";

const HostedAgents = lazy(() => import("@/components/workspace/hosted-agents"));

const title = (r: string) => r.charAt(0).toUpperCase() + r.slice(1);

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); toast.success("Link copied"); }
  catch { toast.error("Couldn't copy. Select the link and copy it yourself."); }
}

/** A link shown once, with Copy. */
function OneTimeLink({ url, note }: { url: string; note: string }) {
  return (
    <div className="grid gap-2" data-testid="one-time-link">
      <div className="flex gap-2">
        <Input readOnly value={url} aria-label="Link" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button type="button" variant="outline" size="sm" onClick={() => void copy(url)}><Copy />Copy</Button>
      </div>
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

function InviteDialog({ open, onOpenChange, onInvited }: { open: boolean; onOpenChange: (o: boolean) => void; onInvited: () => void }) {
  const { me } = useRbac();
  const roles = (me?.roles ?? []).filter((r) => r !== "agent");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const reset = () => { setEmail(""); setName(""); setRole(""); setError(null); setLink(null); };
  const chosen = role || (roles.includes("member") ? "member" : roles[roles.length - 1]) || "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const inv = await baseApi.invite(email.trim(), name.trim(), chosen);
      setLink(joinUrl(inv.token)); setError(null); onInvited();
    } catch (err) { setError(err instanceof Error ? err.message : "That didn't work. Try again."); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="max-w-md" data-testid="invite-dialog">
        <DialogHeader>
          <DialogTitle>{link ? "Send them this link" : "Invite someone"}</DialogTitle>
          <DialogDescription>{link ? `They open it, choose a password, and they're in as ${an(chosen)} ${chosen}.` : "They get a link to join with the role you pick. No email is sent: you share the link."}</DialogDescription>
        </DialogHeader>
        {link ? (
          <>
            <OneTimeLink url={link} note="Shown once. It works for 7 days, one time. Inviting the same email again replaces it." />
            <DialogFooter><Button onClick={() => { onOpenChange(false); reset(); }}>Done</Button></DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="invite-email">Email</Label>
              <Input id="invite-email" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!error} aria-describedby={error ? "invite-error" : undefined} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="invite-name">Name <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Input id="invite-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="invite-role">Role</Label>
              <Select value={chosen} onValueChange={setRole}>
                <SelectTrigger id="invite-role" className="w-full"><SelectValue placeholder="Pick a role" /></SelectTrigger>
                <SelectContent>{roles.map((r) => <SelectItem key={r} value={r}>{title(r)}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {error && <p id="invite-error" role="alert" className="text-xs text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={busy || !email.trim() || !chosen}><MailPlus />{busy ? "Making the link…" : "Make invite link"}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
const an = (r: string) => (/^[aeiou]/i.test(r) ? "an" : "a");

function PendingInvites({ list }: { list: ReturnType<typeof useInvites> }) {
  const [withdraw, setWithdraw] = useState<{ id: number; email: string } | null>(null);
  if (!list.data || list.data.length === 0) return null;
  return (
    <section aria-label="Waiting to join" className="space-y-2" data-testid="pending-invites">
      <h2 className="text-heading">Waiting to join</h2>
      <ul className="divide-y rounded-lg border text-body">
        {list.data.map((i) => (
          <li key={i.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <span className="min-w-0 flex-1 truncate" title={i.email}><span className="font-medium">{i.name || i.email}</span>{i.name && <span className="text-muted-foreground"> · {i.email}</span>}</span>
            <span className="text-xs text-muted-foreground">{title(i.role)} · expires <Ago value={i.expires_at} /></span>
            <Button variant="ghost" size="sm" onClick={() => setWithdraw({ id: i.id, email: i.email })}>Withdraw</Button>
          </li>
        ))}
      </ul>
      <AlertDialog open={!!withdraw} onOpenChange={(o) => !o && setWithdraw(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Withdraw the invite for {withdraw?.email}?</AlertDialogTitle>
            <AlertDialogDescription>Their link stops working at once. You can invite them again later.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={async () => {
              if (!withdraw) return;
              try { await baseApi.revokeInvite(withdraw.id); toast.success("Invite withdrawn"); list.reload(); }
              catch (e) { toast.error(e instanceof Error ? e.message : "That didn't work."); }
              setWithdraw(null);
            }}>Withdraw</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/** The columns xano/rbac.ts adds to each member. */
type Member = RbacMember & { sponsor_id?: number | null; status?: string; is_demo?: boolean };

function ResetLinkDialog({ person, open, onOpenChange }: { person: { id: number; name: string }; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [link, setLink] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setLink(null); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{link ? `Send ${person.name} this link` : `A password reset link for ${person.name}?`}</DialogTitle>
          <DialogDescription>{link ? "They open it and choose a new password." : "For someone who forgot theirs. Their current password keeps working until they use the link."}</DialogDescription>
        </DialogHeader>
        {link ? <OneTimeLink url={link} note="Shown once. It works for 24 hours, one time." /> : null}
        <DialogFooter>
          {link ? <Button onClick={() => { onOpenChange(false); setLink(null); }}>Done</Button> : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={async () => {
                try { setLink(joinUrl((await baseApi.resetLink(person.id)).token)); }
                catch (e) { toast.error(e instanceof Error ? e.message : "That didn't work."); }
              }}>Make the link</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Removing someone: says what happens, and asks who sponsors their agents next. */
function RemoveDialog({ member, open, onOpenChange, onRemoved }: { member: Member; open: boolean; onOpenChange: (o: boolean) => void; onRemoved: () => void }) {
  const plan = useLoad(() => (open ? baseApi.offboarding(member.id) : Promise.resolve(null)), [open, member.id]);
  const [sponsor, setSponsor] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const agents = plan.data?.agents ?? [];
  const needsSponsor = agents.length > 0;
  const close = (o: boolean) => { onOpenChange(o); if (!o) { setSponsor(""); setError(null); } };

  async function remove() {
    setBusy(true); setError(null);
    try {
      await baseApi.removeMember(member.id, needsSponsor ? Number(sponsor) : undefined);
      toast.success(`${member.name} removed`);
      close(false);
      onRemoved();
    } catch (e) { setError(e instanceof Error ? e.message : "That didn't work. Try again."); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md" data-testid="remove-dialog">
        <DialogHeader>
          <DialogTitle>Remove {member.name}?</DialogTitle>
          <DialogDescription>{member.kind === "agent" ? "Its keys stop working at once." : "They're signed out everywhere at once, and their agent keys stop working."} Their name stays on their past work.</DialogDescription>
        </DialogHeader>
        {plan.error ? <LoadError error={plan.error} onRetry={plan.reload} /> : !plan.data ? null : needsSponsor && (
          <div className="grid gap-1.5">
            <Label htmlFor="new-sponsor">Who sponsors {agents.map((a) => a.name).join(", ")} next?</Label>
            <Select value={sponsor} onValueChange={setSponsor}>
              <SelectTrigger id="new-sponsor" className="w-full" data-testid="new-sponsor"><SelectValue placeholder="Choose a member" /></SelectTrigger>
              <SelectContent>{plan.data.sponsors.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}</SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">The agent's keys stop working, so the new sponsor makes fresh ones.</p>
          </div>
        )}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
          <Button variant="destructive" data-testid="remove-confirm" disabled={busy || !plan.data || (needsSponsor && !sponsor)} onClick={() => void remove()}><UserMinus />{busy ? "Removing…" : "Remove"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What any agent may read and do, said before it exists. The same words open its page. */
function WhatItReads({ hosted }: { hosted: boolean }) {
  return (
    <div data-testid="add-agent-reads" className="flex gap-2 rounded-md border bg-muted/40 px-3 py-2 text-caption text-pretty text-muted-foreground">
      <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
      <p>It reads and writes only in the spaces you pick: their conversations, tasks, docs and files. It sees customers only when the person asking can. Anything a guest could see waits for a person first, and it can never manage the team, approve anything or change settings.{hosted ? " Each run starts from its brief." : ""}</p>
    </div>
  );
}

/** Add Agent: hosted or connected, what it can read, its brief, its sponsor and its spaces. It lands on the new agent's page. */
function AddAgentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const me = useMe();
  const navigate = useNavigate();
  const manage = useManageAgent();
  const choices = useSponsorChoices(open && !me.is_demo);
  const spaces = useAllSpaces();
  const [mode, setMode] = useState<"hosted" | "connected">("hosted");
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [sponsor, setSponsor] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reset = () => { setMode("hosted"); setName(""); setBrief(""); setSponsor(""); setPicked([]); setError(null); };
  const close = (o: boolean) => { onOpenChange(o); if (!o) reset(); };
  const sponsorId = sponsor || (choices.data?.some((p) => p.id === me.id) ? String(me.id) : "");
  const usable = (spaces.data?.spaces ?? []).filter((s) => !s.archived_at);
  const ready = !!name.trim() && !!sponsorId && (mode === "connected" || !!brief.trim());

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      const made = await manage.create({ name: name.trim(), mode, brief: brief.trim(), sponsor_id: Number(sponsorId), space_ids: picked });
      toast.success(`${name.trim()} added`);
      close(false);
      navigate(`/team/agents/${made.id}`);
    } catch (err) { setError(err instanceof Error ? err.message : "That didn't go through. Try again."); }
    finally { setBusy(false); }
  }

  const choice = (value: "hosted" | "connected", icon: ReactNode, label: string, words: string) => (
    <label className={cn("flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring", mode === value ? "border-agent/50 bg-agent-wash/50" : "hover:bg-muted/50")}>
      <input type="radio" name="agent-mode" value={value} checked={mode === value} onChange={() => setMode(value)} className="sr-only" data-testid={`add-agent-${value}`} />
      <span aria-hidden className={cn("mt-0.5 grid size-8 shrink-0 place-items-center rounded-[28%]", mode === value ? "bg-agent-wash text-agent-text" : "bg-muted text-muted-foreground")}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-body font-medium">{label}</span>
        <span className="block text-caption text-pretty text-muted-foreground">{words}</span>
      </span>
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto" data-testid="add-agent-dialog">
        <DialogHeader>
          <DialogTitle>Add an agent</DialogTitle>
          <DialogDescription>An agent is a member of the team with its own name, spaces and sponsor. People always see when it's an agent.</DialogDescription>
        </DialogHeader>
        {me.is_demo ? (
          <>
            <p role="status" data-testid="add-agent-demo" className="rounded-md border bg-muted/40 px-3 py-2 text-body text-pretty">A demo session can't add agents. Invite yourself as an admin, sign in with that account, then add one here.</p>
            <DialogFooter><Button onClick={() => close(false)}>Got it</Button></DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <fieldset className="grid gap-2">
              <legend className="mb-1.5 text-body font-medium">How it works</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {choice("hosted", <Bot className="size-4" />, "Works here", "Runs in this workspace when someone mentions it or gives it a task, using the workspace's model key.")}
                {choice("connected", <Plug className="size-4" />, "Connects from elsewhere", "Runs on a machine or server you control, with a key you make for it. It picks up work from its inbox.")}
              </div>
            </fieldset>
            <WhatItReads hosted={mode === "hosted"} />
            <div className="grid gap-1.5">
              <Label htmlFor="agent-name">Name</Label>
              <Input id="agent-name" data-testid="add-agent-name" required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ledger" aria-invalid={!!error} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="agent-brief">Brief {mode === "connected" && <span className="font-normal text-muted-foreground">(optional)</span>}</Label>
              <Textarea id="agent-brief" data-testid="add-agent-brief" rows={4} maxLength={1000} value={brief} onChange={(e) => setBrief(e.target.value)}
                placeholder={mode === "hosted" ? "You keep the launch moving. Answer in a few plain lines, and turn agreed next steps into tasks with an owner and a date." : "What it's for, so the team knows when to ask it."} />
              <p className="text-caption text-muted-foreground">{mode === "hosted" ? "What it's for and how it should work, in plain words. Every run starts from this." : "Shown to the team on its page."}</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="agent-sponsor">Sponsor</Label>
              <Select value={sponsorId} onValueChange={setSponsor} disabled={!choices.data}>
                <SelectTrigger id="agent-sponsor" className="w-full" data-testid="add-agent-sponsor"><SelectValue placeholder={choices.data ? "Choose a member or an admin" : "Loading people…"} /></SelectTrigger>
                <SelectContent>{(choices.data ?? []).map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.id === me.id ? `${p.name} (you)` : p.name}</SelectItem>)}</SelectContent>
              </Select>
              <p className="text-caption text-muted-foreground">The person who answers for it and decides what it asks to do. Guests can't sponsor an agent.</p>
            </div>
            <fieldset className="grid gap-1.5">
              <legend className="mb-1 text-body font-medium">Spaces</legend>
              {!spaces.data ? <Skeleton className="h-16 w-full" /> : usable.length === 0 ? <p className="text-caption text-muted-foreground">There are no spaces yet. Add it to one later from its page.</p> : (
                <ul className="flex max-h-44 flex-col overflow-y-auto rounded-md border">
                  {usable.map((s) => (
                    <li key={s.id} className="border-b last:border-b-0">
                      <label className="flex min-h-9 cursor-pointer items-center gap-3 px-3 py-1.5 text-body max-sm:min-h-11">
                        <Checkbox checked={picked.includes(s.id)} onCheckedChange={(v) => setPicked((p) => (v === true ? [...p, s.id] : p.filter((x) => x !== s.id)))} aria-label={s.name} data-testid="add-agent-space" />
                        <span className="min-w-0 truncate">{s.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-caption text-muted-foreground">Nothing reaches it outside these. You can change them on its page.</p>
            </fieldset>
            {error && <p role="alert" data-testid="add-agent-error" className="text-caption text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>Cancel</Button>
              <Button type="submit" data-testid="add-agent-submit" disabled={busy || !ready}><Bot />{busy ? "Adding…" : name.trim() ? `Add ${name.trim()}` : "Add agent"}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A row's last column: who an agent answers to, what happened to a former member, and the actions on the rest. */
function MemberActions({ member, onChanged }: { member: Member; onChanged: () => void }) {
  const { nameOf } = useWorkspace();
  const [dialog, setDialog] = useState<"reset" | "remove" | null>(null);
  const agent = member.kind === "agent";
  if (member.status !== "active") return (
    <div className="flex min-w-0 items-center justify-end gap-2">
      <StatusBadge>{agent && member.status === "disabled" ? "Stopped" : "Former member"}</StatusBadge>
      {agent && <Button asChild variant="ghost" size="sm" className="max-md:min-h-11"><Link to={`/team/agents/${member.id}`} data-testid="team-agent-open" aria-label={`Open ${member.name}'s page`}>Open<ArrowRight /></Link></Button>}
    </div>
  );
  return (
    <div className="flex min-w-0 items-center justify-end gap-2">
      {agent && <AgentMark />}
      {agent && member.sponsor_id ? <span className="truncate text-xs text-muted-foreground" data-testid="team-sponsor">Sponsor: {nameOf(member.sponsor_id)}</span> : null}
      {agent && <Button asChild variant="ghost" size="sm" className="max-md:min-h-11"><Link to={`/team/agents/${member.id}`} data-testid="team-agent-open" aria-label={`Open ${member.name}'s page`}>Open<ArrowRight /></Link></Button>}
      {!member.is_demo && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`More for ${member.name}`}><MoreHorizontal /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {!agent && <DropdownMenuItem onSelect={() => setDialog("reset")} data-testid="reset-link"><KeyRound />Password reset link</DropdownMenuItem>}
            <DropdownMenuItem variant="destructive" onSelect={() => setDialog("remove")} data-testid="remove-member"><UserMinus />Remove from workspace</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <ResetLinkDialog person={member} open={dialog === "reset"} onOpenChange={(o) => setDialog(o ? "reset" : null)} />
      <RemoveDialog member={member} open={dialog === "remove"} onOpenChange={(o) => setDialog(o ? "remove" : null)} onRemoved={onChanged} />
    </div>
  );
}

function useInvites(enabled: boolean) {
  return useLoad(() => (enabled ? baseApi.invites() : Promise.resolve([])), [enabled]);
}

/** /team: roles (RBAC), invites, and reset links. `labels` say each permission in the app's words. */
export function TeamRoute({ labels }: { labels: Record<string, string> }) {
  const me = useMe();
  return <RbacProvider client={rbacClient} userKey={me?.id}><Team labels={labels} /></RbacProvider>;
}

function Team({ labels }: { labels: Record<string, string> }) {
  const { can } = useRbac();
  const manages = can("team.manage");
  const invites = useInvites(manages);
  const [params, setParams] = useSearchParams();
  const [inviting, setInviting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [joined, setJoined] = useState(0);
  // ⌘K's "Invite someone" opens /team?invite=1.
  useEffect(() => {
    if (params.get("invite") !== "1" || !manages) return;
    setInviting(true);
    setParams((p) => { p.delete("invite"); return p; }, { replace: true });
  }, [params, manages, setParams]);
  useLive(["invite", "user"], () => { invites.reload(); setJoined((n) => n + 1); });
  return (
    <div data-signature-view="members">
      <TeamPage labels={labels} reloadKey={joined}
        actions={manages ? <><Button size="sm" variant="outline" onClick={() => setAdding(true)} data-testid="add-agent-button"><Bot />Add agent</Button><Button size="sm" onClick={() => setInviting(true)} data-testid="invite-button"><UserPlus />Invite</Button></> : undefined}
        rowAction={manages ? (m) => <MemberActions member={m} onChanged={() => setJoined((n) => n + 1)} /> : undefined}>
        {manages && <PendingInvites list={invites} />}
      </TeamPage>
      <InviteDialog open={inviting} onOpenChange={setInviting} onInvited={invites.reload} />
      {manages && <AddAgentDialog open={adding} onOpenChange={setAdding} />}
      <Suspense fallback={null}><HostedAgents /></Suspense>
    </div>
  );
}

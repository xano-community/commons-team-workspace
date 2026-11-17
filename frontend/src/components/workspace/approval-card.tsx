// The moment an agent stops and asks. It says who's asking, what will happen and where, shows the exact words at stake, names anyone
// outside the team who'll read them, and leaves the person three moves: yes, change a word then yes, or no. Violet is the agent's
// and nothing else's. The server decides what's allowed, so a refusal stays here in its own words, and the request stays open.
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { Check, Eye, Pencil, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Ago, Avatar, KeyHint } from "@/components/kit";
import { AgentMark } from "@/components/workspace/agent-mark";
import { LinkChip } from "@/components/workspace/link-chip";
import { useWorkspace } from "@/base/workspace";
import { approvalLook, audienceLine, landing, editedValue, expiresLine, outcomeLine, waitingLine, type ApprovalView } from "@/lib/agents/approvals";
import { useApproval, useDecide, useRecordApprovals } from "@/lib/agents/client";
import type { RecordView } from "@/lib/links/resolver";
import { cn } from "@/lib/utils";

const SEND = "Mod+Enter";

export function ApprovalCard({ view, className }: { view: ApprovalView; className?: string }) {
  const { nameOf } = useWorkspace();
  const { approve, decline } = useDecide();
  const look = approvalLook(view, nameOf);
  const where = landing(view.action, look.asks, view.record as RecordView | null);
  const editable = !!view.editable_field && view.can_decide && view.status === "pending";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(look.body);
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [problem, setProblem] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const outcome = useRef<HTMLParagraphElement>(null);
  const labelId = useId();
  const open = view.status === "pending" && view.can_decide;
  const said = outcomeLine(view, look);

  // A person may be reading when the words change under them. Only a card they aren't editing follows along.
  useEffect(() => { if (!editing) setDraft(look.body); }, [look.body, editing]);
  useEffect(() => { if (editing) { box.current?.focus(); box.current?.setSelectionRange(box.current.value.length, box.current.value.length); } }, [editing]);
  useEffect(() => { if (said) outcome.current?.focus({ preventScroll: true }); }, [said]);

  const finish = (go: () => Promise<unknown>, kind: "approve" | "decline") => {
    if (busy) return;
    setBusy(kind);
    setProblem("");
    go().then(() => setEditing(false), (e: unknown) => setProblem(e instanceof Error ? e.message : "That didn't go through. Try again.")).finally(() => setBusy(null));
  };
  const yes = () => finish(() => approve(view.id, editing ? editedValue(draft, look.body) : undefined), "approve");
  const no = () => finish(() => decline(view.id), "decline");
  const stopEditing = () => { setEditing(false); setDraft(look.body); requestAnimationFrame(() => editButton.current?.focus()); };
  const empty = editing && !draft.trim();
  // The demo's sample waits as long as the demo does, so a date decades away would only distract.
  const expires = open && !view.sample ? expiresLine(view.expires_at, Date.now()) : "";
  const audience = audienceLine(view.guests);

  return (
    <article data-testid="approval-card" data-status={view.status} aria-labelledby={labelId} className={cn("flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4", className)}>
      <header className="flex min-w-0 items-start gap-2.5">
        <Avatar name={view.agent_name} kind={view.agent_kind === "agent" ? "agent" : "person"} size="md" decorative />
        <div className="min-w-0 flex-1">
          {/* One sentence, so it wraps as words do: the place it would land is a link in it, not a box that breaks the line. */}
          <h3 id={labelId} className="min-w-0 text-body text-pretty">
            <span className={cn("font-medium", view.agent_kind === "agent" && "text-agent-text")}>{view.agent_name}</span>
            {view.agent_kind === "agent" && <> <AgentMark /></>}
            {" "}{where.asks}{" "}
            {where.record && (where.record.state === "live" || where.record.state === "archived")
              ? <Link to={where.record.href} data-kit="approval-place" data-state={where.record.state} className="focus-ring rounded-sm font-medium hover:underline">{where.asks !== look.asks ? `#${where.record.title}` : where.record.title}</Link>
              : where.record && <LinkChip view={where.record} />}
          </h3>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-caption text-muted-foreground">
            <span>Asked <Ago value={view.created_at} />{view.status === "pending" && !view.can_decide ? ` · Waiting for ${view.waiting_for}` : ""}</span>
            {view.sample && <span data-testid="sample-run" title="Part of the demo: no model wrote this. Deciding it is real." className="rounded-sm border px-1 text-micro font-medium">Sample run</span>}
          </p>
        </div>
      </header>

      {look.reason && <p className="text-body text-pretty wrap-anywhere text-muted-foreground" data-testid="approval-reason">{look.reason}</p>}

      {look.bodyLabel && (editing ? (
        <div className="flex flex-col gap-1.5">
          <Textarea ref={box} data-testid="approval-text" aria-label={`Edit: ${look.bodyLabel}`} value={draft} rows={Math.min(10, Math.max(3, draft.split("\n").length + 1))} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); stopEditing(); }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !empty) { e.preventDefault(); yes(); }
            }} />
          <p className="text-caption text-muted-foreground">Your words go out under {view.agent_name}'s name, with your approval beside them.</p>
        </div>
      ) : (
        <blockquote data-testid="approval-body" aria-label={look.bodyLabel} className="rounded-md border-l-2 border-agent-text/40 bg-muted/50 px-3 py-2 text-body whitespace-pre-wrap wrap-anywhere">{view.status === "pending" ? draft : look.body}</blockquote>
      ))}

      {look.facts.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-caption">
          {look.facts.map((f) => <div key={f.label} className="contents"><dt className="text-muted-foreground">{f.label}</dt><dd className="wrap-anywhere">{f.value}</dd></div>)}
        </dl>
      )}

      {audience && view.status === "pending" && <p data-testid="approval-audience" className="flex items-start gap-1.5 text-caption text-foreground"><Eye aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />{audience}</p>}

      {problem && <p role="alert" data-testid="approval-problem" className="flex items-start gap-1.5 text-caption text-destructive"><TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />{problem}</p>}

      {said ? (
        <p ref={outcome} tabIndex={-1} data-testid="approval-outcome" className="flex items-center gap-1.5 rounded-sm text-body font-medium outline-none">
          {view.status === "approved" ? <Check aria-hidden className="size-4 shrink-0" /> : <X aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 wrap-anywhere">{said}</span>
        </p>
      ) : open ? (
        <footer className="flex flex-wrap items-center gap-2">
          <Button size="sm" data-testid="approval-approve" disabled={!!busy || empty} aria-busy={busy === "approve"} onClick={yes} className="max-sm:min-h-11 max-sm:flex-1"><Check />{busy === "approve" ? "Working…" : view.approve_label || "Approve"}{editing && <KeyHint shortcut={SEND} />}</Button>
          {editable && !editing && <Button ref={editButton} size="sm" variant="outline" data-testid="approval-edit" disabled={!!busy} onClick={() => setEditing(true)} className="max-sm:min-h-11"><Pencil />Edit</Button>}
          {editing && <Button size="sm" variant="ghost" data-testid="approval-cancel-edit" disabled={!!busy} onClick={stopEditing} className="max-sm:min-h-11">Keep the original</Button>}
          <Button size="sm" variant="ghost" data-testid="approval-decline" disabled={!!busy} aria-busy={busy === "decline"} onClick={no} className="max-sm:min-h-11">{busy === "decline" ? "Declining…" : "Decline"}</Button>
          {expires && <span className="ml-auto text-caption text-muted-foreground tabular-nums max-sm:ml-0 max-sm:w-full">{expires}</span>}
        </footer>
      ) : null}
    </article>
  );
}

export function ApprovalCardSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading this request" className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2.5"><Skeleton className="size-8 rounded-md" /><Skeleton className="h-4 w-2/3" /></div>
      <Skeleton className="h-16 w-full" />
      <div className="flex gap-2"><Skeleton className="h-8 w-24" /><Skeleton className="h-8 w-16" /></div>
    </div>
  );
}

/** The card an inbox line opens. Gone and out of reach read the same, so this can't confirm that anything exists. */
export function InboxApproval({ id }: { id: number }) {
  const card = useApproval(id);
  if (card.data) return <ApprovalCard view={card.data} />;
  if (card.error) return <p data-testid="approval-gone" className="rounded-lg border bg-card p-4 text-body text-muted-foreground">This request has been decided, or you can't open it any more.</p>;
  return <ApprovalCardSkeleton />;
}

/** What's waiting on a record: the card for whoever decides, and one quiet line for anyone else who reaches it. */
export default function RecordApprovals({ type, id, threadId, className }: { type: string; id: number; threadId?: number; className?: string }) {
  const { data } = useRecordApprovals(type, id, threadId);
  const items = data?.items ?? [];
  if (!items.length) return null;
  return (
    <section aria-label="Waiting for approval" data-testid="record-approvals" className={cn("flex min-w-0 flex-col gap-2", className)}>
      {items.map((v) => (v.can_decide ? <ApprovalCard key={v.id} view={v} />
        : <p key={v.id} data-testid="approval-waiting-line" className="flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-caption text-muted-foreground"><Avatar name={v.agent_name} kind="agent" size="xs" decorative />{waitingLine(v)}</p>))}
    </section>
  );
}

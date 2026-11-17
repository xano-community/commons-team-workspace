import type { ReactNode } from "react";
import { Link } from "react-router";
import { Archive, Building2, CircleCheck, CircleDollarSign, File, FileText, FolderKanban, Hash, Layers, Lock, MessageSquare, MessageSquareOff, StickyNote, Trash2, User, type LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Ago, Avatar, DueLabel } from "@/components/kit";
import { useWorkspace } from "@/base/workspace";
import { KIND_LABELS, type FileKind } from "@/lib/files/model";
import { useRecord, type RecordView } from "@/lib/links/resolver";
import { cn } from "@/lib/utils";
import { StatusIcon, statusName } from "@/pages/tasks/marks";

const ICONS: Record<string, LucideIcon> = { space: Layers, conversation: Hash, message: MessageSquare, task: CircleCheck, project: FolderKanban, company: Building2, contact: User, deal: CircleDollarSign, crm_note: StickyNote, file: File };
const CHIP = "inline-flex h-5 max-w-56 min-w-0 items-center gap-1 rounded-sm border bg-muted/50 px-1.5 align-middle text-caption";

const chip = (Icon: LucideIcon, text: ReactNode, tone = "text-muted-foreground") => (
  <><Icon aria-hidden className="size-3 shrink-0 text-muted-foreground" /><span className={cn("truncate", tone)}>{text}</span></>
);

/** A record, as this viewer may see it. Pass `view` when the page already has it, or `type` and `id` to resolve it here. */
export function LinkChip({ view, onRestore, className }: { view: RecordView; onRestore?: () => void; className?: string }) {
  const Icon = ICONS[view.type] ?? FileText;
  const face = cn(CHIP, className);
  switch (view.state) {
    case "locked":
      return <span data-kit="link-chip" data-state="locked" className={face} title="You don't have access to this.">{chip(Lock, "No access")}</span>;
    case "tombstone":
      return <span data-kit="link-chip" data-state="tombstone" className={face}>{chip(MessageSquareOff, "Message deleted")}</span>;
    case "deleted":
      return (
        <span data-kit="link-chip" data-state="deleted" className={face}>
          {chip(Trash2, "Deleted", "text-muted-foreground line-through")}
          {view.can_restore && onRestore && <button type="button" onClick={onRestore} className="focus-ring ml-0.5 rounded-sm font-medium text-foreground hover:underline">Restore</button>}
        </span>
      );
    case "archived":
      return (
        <Link to={view.href} data-kit="link-chip" data-state="archived" className={cn(face, "focus-ring hover:bg-muted")}>
          {chip(Icon, view.title, "text-foreground")}
          <span className="ml-0.5 inline-flex shrink-0 items-center gap-0.5 text-muted-foreground"><Archive aria-hidden className="size-3" />Archived</span>
        </Link>
      );
    default:
      return <Link to={view.href} data-kit="link-chip" data-state="live" className={cn(face, "focus-ring hover:bg-muted")}>{chip(Icon, view.title, "text-foreground")}</Link>;
  }
}

/** A record named only by type and id, as a body node stores it. */
export function RecordChip({ type, id, onRestore, className }: { type: string; id: number; onRestore?: () => void; className?: string }) {
  const record = useRecord(type, id);
  if (record.data) return <LinkChip view={record.data} onRestore={onRestore} className={className} />;
  if (record.error) return <LinkChip view={{ type, id, state: "locked", title: "", href: "", can_restore: false }} className={className} />;
  return <Skeleton className="inline-block h-5 w-20 align-middle" />;
}

const TYPE_WORDS: Record<string, string> = { space: "Space", conversation: "Channel", message: "Message", project: "Project", company: "Company", contact: "Contact", deal: "Deal", crm_note: "Note", doc: "Doc", task: "Task", file: "File" };
const ROW = "flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 text-body max-md:h-11";

/** Who's on it, or who wrote it: a face, named for a screen reader and on hover. */
function Face({ id }: { id?: number }) {
  const { people } = useWorkspace();
  const who = id ? people.find((p) => p.id === id) : undefined;
  if (!who) return null;
  return <Avatar name={who.name} kind={who.kind} size="xs" />;
}

/**
 * A record as a full row, for a record's own links: a task shows its status, who's on it and when it's due, a doc who owns it and
 * when it last changed, and anything else what it is. A row the viewer can't open says why, as the chip does.
 */
export function LinkRow({ view, onRestore }: { view: RecordView; onRestore?: () => void }) {
  const Icon = ICONS[view.type] ?? FileText;
  const d = view.detail ?? {};
  const quiet = (Mark: LucideIcon, text: ReactNode, state: string, extra?: ReactNode) => (
    <span data-kit="link-chip" data-state={state} className={cn(ROW, "text-muted-foreground")}>
      <Mark aria-hidden className="size-4 shrink-0" /><span className={cn("min-w-0 flex-1 truncate", state === "deleted" && "line-through")}>{text}</span>{extra}
    </span>
  );
  if (view.state === "locked") return quiet(Lock, "No access", "locked");
  if (view.state === "tombstone") return quiet(MessageSquareOff, "Message deleted", "tombstone");
  if (view.state === "deleted") return quiet(Trash2, "Deleted", "deleted", view.can_restore && onRestore ? <button type="button" onClick={onRestore} className="focus-ring rounded-sm font-medium text-foreground hover:underline">Restore</button> : undefined);
  const task = view.type === "task";
  return (
    <Link to={view.href} data-kit="link-chip" data-state={view.state} className={cn(ROW, "focus-ring transition-colors hover:bg-muted")}>
      {task && d.status ? <span role="img" aria-label={statusName(d.status)} className="flex shrink-0"><StatusIcon status={d.status} /></span> : <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1 truncate">{view.title}</span>
      {view.state === "archived" && <span className="inline-flex shrink-0 items-center gap-1 text-caption text-muted-foreground"><Archive aria-hidden className="size-3" />Archived</span>}
      <span className="flex shrink-0 items-center gap-2 text-caption text-muted-foreground">
        {task ? <>{d.due_on && <DueLabel value={d.due_on} done={d.status === "done" || d.status === "cancelled"} className="max-sm:hidden" />}<Face id={d.person_id} /></>
          : view.type === "doc" ? <>{d.updated_at ? <Ago value={d.updated_at} className="max-sm:hidden" /> : null}<Face id={d.person_id} /></>
          : view.type === "file" ? <span>{d.kind ? KIND_LABELS[d.kind as FileKind] ?? "File" : "File"}</span>
          : <span>{TYPE_WORDS[view.type] ?? ""}</span>}
      </span>
    </Link>
  );
}

/** Where a file is used, for a row in Files: the record it's most likely there for, and how many more. */
export function AttachedTo({ type, id, count }: { type: string; id: number; count: number }) {
  const record = useRecord(type, id);
  const more = count > 1 ? <span className="shrink-0 text-caption text-muted-foreground tabular-nums" title={`Attached to ${count} records`}>+{count - 1}</span> : null;
  if (!record.data && !record.error) return <Skeleton className="h-4 w-28" />;
  const view = record.data ?? { type, id, state: "locked" as const, title: "", href: "", can_restore: false };
  const Icon = ICONS[view.type] ?? FileText;
  if (view.state !== "live" && view.state !== "archived") {
    return <span data-kit="attached-to" data-state={view.state} className="flex min-w-0 items-center gap-1.5 text-muted-foreground"><Lock aria-hidden className="size-3.5 shrink-0" /><span className="truncate">{view.state === "locked" ? "No access" : "Deleted"}</span>{more}</span>;
  }
  const status = view.type === "task" ? view.detail?.status : undefined;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Link to={view.href} data-kit="attached-to" data-state={view.state} className="focus-ring flex min-w-0 items-center gap-1.5 rounded-sm text-foreground hover:underline max-md:min-h-11">
        {status ? <StatusIcon status={status} className="size-3.5" /> : <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="truncate">{view.title}</span>
      </Link>
      {more}
    </span>
  );
}

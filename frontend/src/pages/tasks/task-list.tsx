// The list: one virtual scroller over group headers and rows, so a thousand tasks cost what a screenful does. Selection moves
// focus to the row's link, so a screen reader follows the keyboard, and nothing here animates.
import { memo, useEffect, useMemo, useRef, type MouseEvent } from "react";
import { Link, useLocation } from "react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DueLabel } from "@/components/kit";
import { isOpen, listGroups, type TaskPage, type TaskStatus, type TaskView } from "@/lib/tasks/model";
import { cn } from "@/lib/utils";
import { Assignee, PriorityIcon, StatusIcon, priorityName, statusName } from "./marks";
import type { MenuKind } from "./task-menu";

type Line = { kind: "group"; status: TaskStatus; total: number } | { kind: "task"; task: TaskView } | { kind: "more"; status: TaskStatus; left: number } | { kind: "finished"; count: number };

export function listLines(rows: TaskView[], totals: TaskPage["totals"], showFinished: boolean): Line[] {
  const lines: Line[] = [];
  for (const g of listGroups(rows, showFinished)) {
    const total = Math.max(totals[g.status] ?? 0, g.items.length);
    lines.push({ kind: "group", status: g.status, total }, ...g.items.map((task) => ({ kind: "task" as const, task })));
    if (total > g.items.length) lines.push({ kind: "more", status: g.status, left: total - g.items.length });
  }
  const finished = (totals.done ?? 0) + (totals.cancelled ?? 0);
  if (!showFinished && finished) lines.push({ kind: "finished", count: finished });
  return lines;
}

const CHIP = "focus-ring grid size-7 shrink-0 place-items-center rounded-sm hover:bg-muted max-md:size-11";

const TaskRow = memo(function TaskRow({ task, selected, canEdit, onMenu, onSelect, search }: { task: TaskView; selected: boolean; canEdit: boolean; onMenu: (kind: MenuKind, task: TaskView, el: HTMLElement) => void; onSelect: (id: number) => void; search: string }) {
  const open = (kind: MenuKind) => (e: MouseEvent<HTMLButtonElement>) => { e.preventDefault(); onMenu(kind, task, e.currentTarget); };
  const pending = task.id < 0;
  const finished = !isOpen(task.status);
  return (
    <div role="listitem" data-task-row={task.id} data-selected={selected || undefined} onMouseDown={() => onSelect(task.id)}
      className={cn("flex h-full min-w-0 items-center gap-1 border-b border-border/60 pr-3 pl-2 hover:bg-muted/50 data-[selected]:bg-selected")}>
      <button type="button" tabIndex={-1} disabled={!canEdit} data-menu="status" aria-label={`Status: ${statusName(task.status)}`} onClick={open("status")} className={CHIP}><StatusIcon status={task.status} /></button>
      <button type="button" tabIndex={-1} disabled={!canEdit} data-menu="priority" aria-label={`Priority: ${priorityName(task.priority)}`} onClick={open("priority")} className={cn(CHIP, "max-md:hidden")}><PriorityIcon priority={task.priority} /></button>
      {/* The list's filters ride along, so the list behind the task stays as it was. `opened` says a pointer opened it, which
          is the one way the task slides in: a keyboard open is instant. */}
      <Link to={pending ? "#" : `/tasks/${task.id}${search}`} state={{ opened: "pointer" }} tabIndex={selected ? 0 : -1} aria-disabled={pending || undefined} data-testid="task-row-link" onClick={(e) => { if (pending) e.preventDefault(); }}
        className="focus-ring-inset flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm px-1">
        {/* Blocks, not spans, so the title stays the row's first span: what a test or a screen reader takes as its name. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className={cn("min-w-0 truncate text-body font-medium", finished && "font-normal text-muted-foreground")} title={task.title}>{task.title}</span>
          {/* On a phone, a second line carries what the desktop's columns do: priority, project, when it's due. */}
          <div data-testid="task-row-meta" className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground md:hidden">
            {task.priority !== "none" && <PriorityIcon priority={task.priority} className="size-3.5" />}
            <span className="min-w-0 truncate">{task.project_name}</span>
            {task.due_on && <><span aria-hidden>·</span><DueLabel value={task.due_on} done={finished} className="shrink-0" /></>}
          </div>
        </div>
      </Link>
      <span className="truncate text-caption text-muted-foreground max-md:hidden lg:max-w-48">{task.project_name}</span>
      <button type="button" tabIndex={-1} disabled={!canEdit} data-menu="due" aria-label={task.due_on ? undefined : "Set a due date"} onClick={open("due")} className="focus-ring h-7 shrink-0 rounded-sm px-1.5 text-caption text-muted-foreground hover:bg-muted max-md:hidden">
        {task.due_on ? <DueLabel value={task.due_on} done={finished} /> : <span className="opacity-0 group-hover:opacity-100">Due</span>}
      </button>
      <button type="button" tabIndex={-1} disabled={!canEdit} data-menu="assignee" onClick={open("assignee")} className={CHIP}><span className="sr-only">Assigned to {task.assignee_name ?? "nobody"}</span><Assignee task={task} decorative /></button>
    </div>
  );
});

export function TaskList({ rows, totals, showFinished, selected, canEdit, canAdd, onMenu, onSelect, onAdd, onMore, onShowFinished, keyboard }: {
  rows: TaskView[]; totals: TaskPage["totals"]; showFinished: boolean; selected: number | null; canEdit: (task: TaskView) => boolean; canAdd: boolean; keyboard: boolean;
  onMenu: (kind: MenuKind, task: TaskView, el: HTMLElement) => void; onSelect: (id: number) => void; onAdd: (status: TaskStatus) => void; onMore: () => void; onShowFinished: () => void;
}) {
  const lines = useMemo(() => listLines(rows, totals, showFinished), [rows, totals, showFinished]);
  const scroller = useRef<HTMLDivElement>(null);
  const phone = typeof matchMedia !== "undefined" && matchMedia("(max-width: 767px)").matches;
  const rowHeight = phone ? 60 : 40;
  const { search } = useLocation();
  const v = useVirtualizer({
    count: lines.length, getScrollElement: () => scroller.current, overscan: 12, estimateSize: (i) => (lines[i].kind === "task" ? rowHeight : phone ? 44 : 36),
    getItemKey: (i) => { const l = lines[i]; return l.kind === "task" ? `t${l.task.id}` : l.kind === "finished" ? "finished" : `${l.kind}-${l.status}`; },
  });
  const at = selected === null ? -1 : lines.findIndex((l) => l.kind === "task" && l.task.id === selected);
  useEffect(() => {
    if (at < 0 || !keyboard) return;
    v.scrollToIndex(at, { align: "auto" });
    const id = requestAnimationFrame(() => scroller.current?.querySelector<HTMLElement>(`[data-task-row="${selected}"] a`)?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, [at, selected, keyboard]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={scroller} data-testid="task-list" data-signature-view="tasks" className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
      <div role="list" aria-label="Tasks" className="relative" style={{ height: v.getTotalSize() }}>
        {v.getVirtualItems().map((item) => {
          const line = lines[item.index];
          return (
            <div key={item.key} className="group absolute top-0 left-0 w-full" style={{ height: item.size, transform: `translateY(${item.start}px)` }}>
              {line.kind === "task" ? <TaskRow task={line.task} selected={line.task.id === selected} canEdit={canEdit(line.task)} onMenu={onMenu} onSelect={onSelect} search={search} />
                : line.kind === "group" ? (
                  <div role="listitem" data-testid="task-group" className="flex h-full items-center gap-2 border-b bg-muted/40 pr-2 pl-3.5">
                    <StatusIcon status={line.status} />
                    <h2 className="text-caption font-medium">{statusName(line.status)}</h2>
                    <span className="text-caption text-muted-foreground tabular-nums">{line.total}</span>
                    {canAdd && <button type="button" aria-label={`Add to ${statusName(line.status)}`} onClick={() => onAdd(line.status)} className="focus-ring ml-auto grid size-6 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground max-md:size-11"><Plus className="size-4" /></button>}
                  </div>
                ) : line.kind === "more" ? (
                  <div role="listitem" className="flex h-full items-center border-b pl-3"><Button variant="ghost" size="sm" onClick={onMore} data-testid="task-more" className="text-muted-foreground max-md:min-h-11">Show {line.left} more</Button></div>
                ) : (
                  <div role="listitem" className="flex h-full items-center pl-3"><Button variant="ghost" size="sm" onClick={onShowFinished} data-testid="show-finished" className="text-muted-foreground max-md:min-h-11"><ChevronDown />Show {line.count} finished</Button></div>
                )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

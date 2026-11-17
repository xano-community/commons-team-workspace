// The one menu behind every property: a key, a chip on a row, a chip on a card and a field on a task all open it, so it opens
// once per screen and never once per row. It's a type-ahead list, because a person who knows the word shouldn't have to walk to it.
import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, CalendarOff, Check, User, UserMinus } from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Avatar } from "@/components/kit";
import { AgentMark } from "@/components/workspace/agent-mark";
import { useMe } from "@/base/session";
import { useSpacePeople, useTaskActions } from "@/lib/tasks/client";
import { dayAfter, PRIORITIES, PRIORITY_LABELS, STATUSES, STATUS_LABELS, type TaskPriority, type TaskStatus, type TaskView } from "@/lib/tasks/model";
import { PriorityIcon, StatusIcon } from "./marks";

export type MenuKind = "status" | "priority" | "assignee" | "due";
export type MenuRequest = { kind: MenuKind; task: TaskView; anchor: HTMLElement | null };
const TITLES: Record<MenuKind, string> = { status: "Change status", priority: "Change priority", assignee: "Assign to", due: "Due date" };
const ROW = "max-sm:min-h-11";

export function useTaskMenu() {
  const [request, setRequest] = useState<MenuRequest | null>(null);
  const open = useCallback((kind: MenuKind, task: TaskView, anchor: HTMLElement | null) => { if (task.id > 0) setRequest({ kind, task, anchor }); }, []);
  return { request, open, close: useCallback(() => setRequest(null), []) };
}

function People({ task, done }: { task: TaskView; done: () => void }) {
  const me = useMe()!;
  const actions = useTaskActions();
  const people = useSpacePeople(task.space_id);
  const list = useMemo(() => (people.data?.people ?? []).filter((p) => p.status === "active"), [people.data]);
  const pick = (p: { id: number; name: string; kind: "human" | "agent" } | null) => { actions.assign(task, p); done(); };
  const self = list.find((p) => p.id === me.id);
  return (
    <>
      <CommandEmpty>{people.isPending ? "Loading people" : people.error ? "People didn't load. Close this and try again." : "Nobody in this space matches"}</CommandEmpty>
      <CommandGroup>
        {self && task.assignee_id !== me.id && <CommandItem value="assign to me" className={ROW} onSelect={() => pick(self)}><User aria-hidden />Assign to me</CommandItem>}
        <CommandItem value="nobody unassign" className={ROW} onSelect={() => pick(null)} data-testid="assign-nobody"><UserMinus aria-hidden />Nobody</CommandItem>
        {list.map((p) => (
          <CommandItem key={p.id} value={`${p.name} ${p.id}`} className={ROW} data-testid="assign-option" onSelect={() => pick(p)}>
            <Avatar name={p.name} kind={p.kind} size="xs" decorative />
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            {p.kind === "agent" && <AgentMark />}
          </CommandItem>
        ))}
      </CommandGroup>
    </>
  );
}

function Due({ task, done }: { task: TaskView; done: () => void }) {
  const actions = useTaskActions();
  const pick = (day: string) => { actions.setDue(task, day); done(); };
  const now = new Date();
  const days: [string, string][] = [["Today", dayAfter(now, 0)], ["Tomorrow", dayAfter(now, 1)], ["In a week", dayAfter(now, 7)]];
  return (
    <>
      <CommandEmpty>Pick a day below</CommandEmpty>
      <CommandGroup>
        {days.map(([label, day]) => <CommandItem key={label} value={label} className={ROW} onSelect={() => pick(day)}><CalendarDays aria-hidden /><span className="flex-1">{label}</span><span className="text-caption text-muted-foreground tabular-nums">{day}</span></CommandItem>)}
        {task.due_on && <CommandItem value="no due date clear" className={ROW} onSelect={() => pick("")}><CalendarOff aria-hidden />No due date</CommandItem>}
      </CommandGroup>
      <label className="flex items-center gap-2 border-t p-2 text-caption text-muted-foreground">
        Another day
        <input type="date" data-testid="due-input" defaultValue={task.due_on ?? ""} className="focus-ring h-8 min-w-0 flex-1 rounded-sm border bg-background px-2 text-body text-foreground max-sm:h-11"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (e.currentTarget.value) pick(e.currentTarget.value); } }}
          onBlur={(e) => { if (e.currentTarget.value && e.currentTarget.value !== (task.due_on ?? "")) pick(e.currentTarget.value); }} />
      </label>
    </>
  );
}

export function TaskMenu({ request, close, rows }: { request: MenuRequest | null; close: () => void; rows: TaskView[] }) {
  const actions = useTaskActions();
  const [anchor, setAnchor] = useState<{ current: HTMLElement | null }>({ current: null });
  useEffect(() => { if (request) setAnchor({ current: request.anchor }); }, [request]);
  if (!request) return null;
  const { kind, task } = request;
  return (
    <Popover open onOpenChange={(open) => { if (!open) close(); }}>
      <PopoverAnchor virtualRef={anchor as { current: HTMLElement }} />
      <PopoverContent align="start" className="w-72 max-w-[calc(100vw-1rem)] p-0 !animate-none" data-testid="task-menu" aria-label={TITLES[kind]}
        onCloseAutoFocus={(e) => { e.preventDefault(); request.anchor?.focus(); }}>
        <Command defaultValue={kind === "status" ? STATUS_LABELS[task.status as TaskStatus] : kind === "priority" ? PRIORITY_LABELS[task.priority as TaskPriority] : undefined}>
          <CommandInput placeholder={`${TITLES[kind]}…`} autoFocus />
          <CommandList className="max-h-72">
            {kind === "status" && (
              <><CommandEmpty>No status matches</CommandEmpty><CommandGroup>{STATUSES.map((s: TaskStatus) => (
                <CommandItem key={s} value={STATUS_LABELS[s]} className={ROW} onSelect={() => { void actions.setStatus(task, s, rows); close(); }}><StatusIcon status={s} /><span className="flex-1">{STATUS_LABELS[s]}</span>{s === task.status && <Check aria-label="Current" />}</CommandItem>
              ))}</CommandGroup></>
            )}
            {kind === "priority" && (
              <><CommandEmpty>No priority matches</CommandEmpty><CommandGroup>{PRIORITIES.map((p: TaskPriority) => (
                <CommandItem key={p} value={PRIORITY_LABELS[p]} className={ROW} onSelect={() => { actions.setPriority(task, p); close(); }}><PriorityIcon priority={p} /><span className="flex-1">{PRIORITY_LABELS[p]}</span>{p === task.priority && <Check aria-label="Current" />}</CommandItem>
              ))}</CommandGroup></>
            )}
            {kind === "assignee" && <People task={task} done={close} />}
            {kind === "due" && <Due task={task} done={close} />}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

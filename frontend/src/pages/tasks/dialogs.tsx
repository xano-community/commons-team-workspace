// Starting things: a task, a project (and, in a workspace with nothing yet, the space it goes in), and a saved filter.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AgentMark } from "@/components/workspace/agent-mark";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { tasksApi, type TaskSetup } from "@/lib/tasks/api";
import { useSpacePeople, type NewTask } from "@/lib/tasks/client";
import { PRIORITIES, PRIORITY_LABELS, STATUSES, STATUS_LABELS, type TaskPriority, type TaskStatus } from "@/lib/tasks/model";

const FIELD = "grid min-w-0 grid-cols-1 gap-1.5";
const NOBODY = "0";

/** Unsent words stay with the dialog: a refused task comes back here, as it was. */
export type TaskDraft = { title: string; description: string; project: string; status: TaskStatus; priority: TaskPriority; due: string; assignee: string };

export function NewTaskDialog({ setup, start, onCreate, onClose }: { setup: TaskSetup; start: Partial<TaskDraft>; onCreate: (t: NewTask, draft: TaskDraft) => void; onClose: () => void }) {
  const writable = useMemo(() => setup.projects.filter((p) => setup.spaces.find((s) => s.id === p.space_id)?.can_create), [setup]);
  const [d, setD] = useState<TaskDraft>({ title: "", description: "", project: String(writable[0]?.id ?? ""), status: "todo", priority: "none", due: "", assignee: NOBODY, ...start });
  const [problem, setProblem] = useState("");
  const set = (patch: Partial<TaskDraft>) => setD((was) => ({ ...was, ...patch }));
  const project = writable.find((p) => String(p.id) === d.project);
  const people = useSpacePeople(project?.space_id ?? null);
  const list = (people.data?.people ?? []).filter((p) => p.status === "active");
  const spaceName = (id: number) => setup.spaces.find((s) => s.id === id)?.name ?? "";
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const title = d.title.trim();
    if (!title) { setProblem("Give the task a title."); return; }
    if (!project) { setProblem("Choose a project."); return; }
    const person = list.find((p) => String(p.id) === d.assignee);
    onCreate({ project_id: project.id, space_id: project.space_id, project_name: project.name, title, description: d.description.trim(), status: d.status, priority: d.priority, due_on: d.due, assignee_id: person?.id ?? 0, assignee_name: person?.name ?? null, assignee_kind: person?.kind ?? null }, d);
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg !animate-none" data-testid="new-task" onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}>
        <DialogHeader><DialogTitle>New task</DialogTitle><DialogDescription className="sr-only">Add a task to a project.</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="grid min-w-0 gap-3">
          <div className={FIELD}>
            <Label htmlFor="task-title" className="sr-only">Title</Label>
            <Input id="task-title" autoFocus value={d.title} placeholder="What needs doing?" data-testid="new-task-title" maxLength={200} aria-invalid={!!problem} onChange={(e) => { set({ title: e.target.value }); setProblem(""); }} />
            {problem && <p role="alert" className="text-caption text-destructive">{problem}</p>}
          </div>
          <div className={FIELD}>
            <Label htmlFor="task-description" className="sr-only">Description</Label>
            <Textarea id="task-description" rows={3} value={d.description} placeholder="Add a description" onChange={(e) => set({ description: e.target.value })} />
          </div>
          <div className="grid min-w-0 grid-cols-2 gap-3">
            <div className={FIELD}>
              <Label className="text-caption text-muted-foreground">Project</Label>
              <Select value={d.project} onValueChange={(v) => set({ project: v, assignee: NOBODY })}>
                <SelectTrigger size="sm" aria-label="Project" data-testid="new-task-project" className="w-full max-sm:min-h-11"><SelectValue placeholder="Choose" /></SelectTrigger>
                <SelectContent>{writable.map((p) => <SelectItem key={p.id} value={String(p.id)} title={`${p.name} · ${spaceName(p.space_id)}`}><span className="min-w-0 truncate">{p.name}</span><span className="min-w-0 shrink-[2] truncate text-muted-foreground">{spaceName(p.space_id)}</span></SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className={FIELD}>
              <Label className="text-caption text-muted-foreground">Assignee</Label>
              <Select value={d.assignee} onValueChange={(v) => set({ assignee: v })}>
                <SelectTrigger size="sm" aria-label="Assignee" className="w-full max-sm:min-h-11"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value={NOBODY}>Nobody</SelectItem>{list.map((p) => <SelectItem key={p.id} value={String(p.id)}><span className="min-w-0 truncate">{p.name}</span>{p.kind === "agent" && <AgentMark />}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className={FIELD}>
              <Label className="text-caption text-muted-foreground">Status</Label>
              <Select value={d.status} onValueChange={(v) => set({ status: v as TaskStatus })}>
                <SelectTrigger size="sm" aria-label="Status" className="w-full max-sm:min-h-11"><SelectValue /></SelectTrigger>
                <SelectContent>{STATUSES.map((s) => <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className={FIELD}>
              <Label className="text-caption text-muted-foreground">Priority</Label>
              <Select value={d.priority} onValueChange={(v) => set({ priority: v as TaskPriority })}>
                <SelectTrigger size="sm" aria-label="Priority" className="w-full max-sm:min-h-11"><SelectValue /></SelectTrigger>
                <SelectContent>{PRIORITIES.map((p) => <SelectItem key={p} value={p}>{PRIORITY_LABELS[p]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className={FIELD}>
              <Label htmlFor="task-due" className="text-caption text-muted-foreground">Due date</Label>
              <Input id="task-due" type="date" value={d.due} onChange={(e) => set({ due: e.target.value })} className="h-8 max-sm:min-h-11" />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose} className="max-sm:min-h-11">Cancel</Button>
            <Button type="submit" size="sm" data-testid="new-task-save" className="max-sm:min-h-11">Add task</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A project, in a space the person can work in. With no space to put it in, the same two fields start both. */
export function NewProjectDialog({ setup, space, onMade, onClose }: { setup: TaskSetup; space: number | null; onMade: (project: { id: number; space_id: number }) => void; onClose: () => void }) {
  const writable = setup.spaces.filter((s) => s.can_create);
  const [name, setName] = useState("");
  const [spaceName, setSpaceName] = useState("");
  const [spaceId, setSpaceId] = useState(String(space ?? writable[0]?.id ?? ""));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const first = !writable.length;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem("");
    try {
      const home = first ? (await tasksApi.createSpace(spaceName.trim(), "open")).id : Number(spaceId);
      onMade(await tasksApi.createProject(home, name.trim()));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "That didn't work. Try again.");
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md" data-testid="new-project">
        <DialogHeader>
          <DialogTitle>{first ? "Start a space and a project" : "New project"}</DialogTitle>
          <DialogDescription>{first ? "A space holds a team's channels and tasks. Everyone in the workspace can see and join this one." : "A project groups tasks inside a space. Everyone in the space can see it."}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void submit(e)} className="grid gap-3">
          {first ? (
            <div className={FIELD}><Label htmlFor="space-name">Space</Label><Input id="space-name" autoFocus value={spaceName} maxLength={60} placeholder="Product" data-testid="new-space-name" onChange={(e) => setSpaceName(e.target.value)} /></div>
          ) : (
            <div className={FIELD}>
              <Label>Space</Label>
              <Select value={spaceId} onValueChange={setSpaceId}>
                <SelectTrigger size="sm" aria-label="Space" className="w-full max-sm:min-h-11"><SelectValue placeholder="Choose" /></SelectTrigger>
                <SelectContent>{writable.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          <div className={FIELD}><Label htmlFor="project-name">Project</Label><Input id="project-name" autoFocus={!first} value={name} maxLength={60} placeholder="Spring launch" data-testid="new-project-name" onChange={(e) => setName(e.target.value)} /></div>
          {problem && <p role="alert" className="text-caption text-destructive">{problem}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose} className="max-sm:min-h-11">Cancel</Button>
            <Button type="submit" size="sm" disabled={busy} data-testid="new-project-save" className="max-sm:min-h-11">{first ? "Start" : "Add project"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SaveViewDialog({ onSave, onClose }: { onSave: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try { await onSave(name.trim()); } catch (err) { setProblem(err instanceof Error ? err.message : "That didn't work. Try again."); setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-sm" data-testid="save-view">
        <DialogHeader><DialogTitle>Save this filter</DialogTitle><DialogDescription>It stays in your list of filters, for you alone. Saving a name again replaces it.</DialogDescription></DialogHeader>
        <form onSubmit={(e) => void submit(e)} className="grid gap-3">
          <div className={FIELD}><Label htmlFor="view-name" className="sr-only">Name</Label><Input ref={input} id="view-name" value={name} maxLength={40} placeholder="Overdue for me" data-testid="save-view-name" onChange={(e) => { setName(e.target.value); setProblem(""); }} /></div>
          {problem && <p role="alert" className="text-caption text-destructive">{problem}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose} className="max-sm:min-h-11">Cancel</Button>
            <Button type="submit" size="sm" disabled={busy} data-testid="save-view-save" className="max-sm:min-h-11">Save filter</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

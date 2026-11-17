// The board: the workspace's signature view. A card moves by mouse, by key and by its menu, and each lands in the same place,
// because all three go through the same order rule. On a phone the columns scroll sideways, one at a time.
import { memo, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { KanbanBoard, KanbanCard, type KanbanColumn } from "@/components/kit";
import { useTaskActions } from "@/lib/tasks/client";
import { BOARD_STATUSES, STATUS_LABELS, isOpen, type TaskPage, type TaskStatus, type TaskView } from "@/lib/tasks/model";

const TONES: Partial<Record<TaskStatus, KanbanColumn["tone"]>> = { done: "success" };
const COLUMNS: KanbanColumn[] = BOARD_STATUSES.map((s) => ({ id: s, title: STATUS_LABELS[s], tone: TONES[s] ?? "neutral" }));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

const Card = memo(function Card({ task }: { task: TaskView }) {
  return <KanbanCard title={task.title} id={task.id > 0 ? `#${task.id}` : undefined} priority={task.priority} due={task.due_on} done={!isOpen(task.status)} extra={task.project_name ? <span className="truncate">{task.project_name}</span> : undefined}
    assignee={task.assignee_name ? { name: task.assignee_name, kind: task.assignee_kind === "agent" ? "agent" : "person" } : null} />;
});

export function TaskBoard({ rows, totals, selected, canEdit, canAdd, statuses, onOpen, onSelect, onAdd, onMore }: {
  rows: TaskView[]; totals: TaskPage["totals"]; selected: number | null; canEdit: (task: TaskView) => boolean; canAdd: boolean; statuses: TaskStatus[];
  onOpen: (task: TaskView) => void; onSelect: (id: number) => void; onAdd: (status: TaskStatus) => void; onMore: () => void;
}) {
  const actions = useTaskActions();
  const sorted = useMemo(() => [...rows].sort((a, b) => a.rank - b.rank || a.id - b.id), [rows]);
  const columns = useMemo(() => COLUMNS.filter((c) => statuses.includes(c.id as TaskStatus)), [statuses]);
  const now = today();
  return (
    <div className="min-h-0 flex-1 px-4 pt-3 pb-2" data-testid="task-board">
      <KanbanBoard fill label="Tasks by status" columns={columns} items={sorted} columnOf={(t) => t.status} itemKey={(t) => t.id} keyboardMoves={false} selected={selected} onSelect={(k) => onSelect(Number(k))}
        renderCard={(t) => <Card task={t} />} canMove={(t) => canEdit(t) && t.id > 0} overdueOf={(t) => !!t.due_on && t.due_on < now && isOpen(t.status)}
        onMove={(t, to) => void actions.setStatus(t, to as TaskStatus, rows)} onReorder={(t, to, before) => void actions.drop(t, to as TaskStatus, before === null ? null : Number(before), rows)}
        onOpen={onOpen} onAdd={canAdd ? (id) => onAdd(id as TaskStatus) : undefined} emptyColumn="No tasks"
        footer={(id) => {
          const left = (totals[id as TaskStatus] ?? 0) - rows.filter((r) => r.status === id).length;
          return left > 0 ? <div className="px-2 pb-1"><Button variant="ghost" size="sm" onClick={onMore} data-testid="task-more" className="w-full text-muted-foreground max-md:min-h-11">Show {left} more</Button></div> : null;
        }} />
    </div>
  );
}

// A task's status and priority as small marks. Colour says as little as it can: done is the one quiet success, urgent the one
// warning, and everything else is graphite.
import { Circle, CircleCheck, CircleDashed, CircleDot, CircleDotDashed, CircleX, Minus, TriangleAlert, User, type LucideIcon } from "lucide-react";
import { Avatar, PriorityBars } from "@/components/kit";
import { PRIORITY_LABELS, STATUS_LABELS, type TaskPriority, type TaskStatus, type TaskView } from "@/lib/tasks/model";
import { cn } from "@/lib/utils";

const STATUS_ICONS: Record<TaskStatus, LucideIcon> = { backlog: CircleDashed, todo: Circle, in_progress: CircleDot, in_review: CircleDotDashed, done: CircleCheck, cancelled: CircleX };
const STATUS_TONE: Partial<Record<TaskStatus, string>> = { in_progress: "text-foreground", in_review: "text-foreground", done: "text-success" };
const PRIORITY_LEVELS: Partial<Record<TaskPriority, 1 | 2 | 3>> = { low: 1, medium: 2, high: 3 };

export function StatusIcon({ status, className }: { status: string; className?: string }) {
  const Icon = STATUS_ICONS[status as TaskStatus] ?? Circle;
  return <Icon aria-hidden className={cn("size-4 shrink-0", STATUS_TONE[status as TaskStatus] ?? "text-muted-foreground", className)} />;
}

/** Urgent is the one warning; high, medium and low are bars filled to their level; none is a quiet dash. */
export function PriorityIcon({ priority, className }: { priority: string; className?: string }) {
  if (priority === "urgent") return <TriangleAlert aria-hidden strokeWidth={2.25} className={cn("size-4 shrink-0 text-destructive", className)} />;
  const level = PRIORITY_LEVELS[priority as TaskPriority];
  if (!level) return <Minus aria-hidden strokeWidth={2.25} className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
  return <PriorityBars level={level} className={cn(level === 3 ? "text-foreground" : "text-muted-foreground", className)} />;
}

/** Who's on it. An agent's face is a violet square, at every size, so the two can't be mistaken. */
export function Assignee({ task, size = "xs", decorative = false }: { task: Pick<TaskView, "assignee_name" | "assignee_kind">; size?: "xs" | "sm"; decorative?: boolean }) {
  if (!task.assignee_name) return <span aria-label="Nobody" role="img" className={cn("inline-grid shrink-0 place-items-center rounded-full border border-dashed text-muted-foreground", size === "xs" ? "size-5" : "size-6")}><User aria-hidden className="size-3" /></span>;
  return <Avatar name={task.assignee_name} kind={task.assignee_kind} size={size} decorative={decorative} />;
}

export const statusName = (s: string) => STATUS_LABELS[s as TaskStatus] ?? s;
export const priorityName = (p: string) => PRIORITY_LABELS[p as TaskPriority] ?? p;

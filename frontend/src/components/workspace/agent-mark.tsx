import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";

/** Says a member is an agent, wherever one is named. Violet belongs to agents alone. `compact` is the icon alone, for a meta line. */
export function AgentMark({ compact = false }: { compact?: boolean }) {
  if (compact) return <span data-testid="agent-mark" title="Agent" className="inline-grid size-4 shrink-0 place-items-center rounded-full bg-agent-wash text-agent-text"><Bot aria-label="Agent" className="size-2.5" /></span>;
  return (
    <span data-testid="agent-mark" className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-agent-wash px-2 text-caption font-medium text-agent-text")}>
      <Bot aria-hidden className="size-3" />Agent
    </span>
  );
}

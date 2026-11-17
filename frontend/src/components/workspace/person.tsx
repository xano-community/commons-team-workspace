import { Avatar, type AvatarSize } from "@/components/kit";
import { cn } from "@/lib/utils";
import { AgentMark } from "./agent-mark";

/**
 * Someone named on a screen. An agent always carries its violet square and the Agent tag, so a screen passes the kind its row
 * came with and has nothing else to get right. `label` is what to write when it isn't the name, and `face` drops the avatar
 * where another one is already beside it.
 */
export function Person({ name, kind, label, face = true, size = "xs", className }: { name: string; kind?: string | null; label?: string; face?: boolean; size?: AvatarSize; className?: string }) {
  const agent = kind === "agent";
  return (
    <span data-slot="person" className={cn("inline-flex max-w-full min-w-0 items-center gap-1.5", className)}>
      {face && <Avatar name={name} kind={kind} size={size} decorative />}
      <span className={cn("min-w-0 truncate", agent && "text-agent-text")}>{label ?? name}</span>
      {agent && <AgentMark />}
    </span>
  );
}

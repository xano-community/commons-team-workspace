import { cn } from "@/lib/utils";

/** "Ada Admin" → "AA": the avatar when there's no picture. */
export const initialsOf = (name: string) => name.trim().split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase() || "?";

export type AvatarSize = "xs" | "sm" | "md" | "lg";
/** A person is round. An agent is a rounded square in the agent's violet, so the two can't be mistaken at any size. */
export type AvatarKind = "person" | "agent";
/** What `kind` a backend row carries: "agent" is an agent, and anything else is a person. */
export type Face = string | { name: string; kind?: string | null };
const faceOf = (kind?: string | null): AvatarKind => (kind === "agent" ? "agent" : "person");

// 20 / 24 / 32 / 48 px. Initials are 11 px up to 24 px, 12 px at 32 px, 14 px at 48 px (a profile's header).
const SIZE: Record<AvatarSize, string> = { xs: "size-5 text-micro", sm: "size-6 text-micro", md: "size-8 text-caption", lg: "size-12 text-heading" };
const FACE = "inline-grid shrink-0 place-items-center font-medium select-none";
const KIND: Record<AvatarKind, string> = {
  person: "rounded-full bg-muted text-foreground/80",
  agent: "rounded-[28%] bg-agent-wash text-agent-text",
};

/**
 * Who's on it: initials in a neutral circle for a person, a violet rounded square for an agent, the name on hover and to
 * a screen reader. `decorative` when the name is already written beside it (a user menu, a "Continue as Ada" button),
 * so it isn't read twice.
 */
export function Avatar({ name, kind, size = "sm", decorative = false, className }: { name: string; kind?: string | null; size?: AvatarSize; decorative?: boolean; className?: string }) {
  const face = faceOf(kind);
  const label = face === "agent" ? `${name} (agent)` : name;
  return (
    <span {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": label, title: label })} data-slot="avatar" data-kind={face} className={cn(FACE, KIND[face], SIZE[size], className)}>
      <span aria-hidden>{initialsOf(name)}</span>
    </span>
  );
}

/** Several people, overlapped: the first `max`, then "+N". The whole list is the hover and the label. */
export function AvatarStack({ names, max = 3, size = "sm", className }: { names: Face[]; max?: number; size?: AvatarSize; className?: string }) {
  if (!names.length) return null;
  const faces = names.map((f) => (typeof f === "string" ? { name: f, kind: faceOf() } : { name: f.name, kind: faceOf(f.kind) }));
  const shown = faces.slice(0, max);
  const rest = faces.length - shown.length;
  const all = faces.map((f) => f.name).join(", ");
  return (
    <span role="img" aria-label={all} title={all} data-slot="avatar-stack" className={cn("inline-flex items-center -space-x-1.5", className)}>
      {shown.map((f, i) => <span key={`${f.name}-${i}`} aria-hidden data-kind={f.kind} className={cn(FACE, KIND[f.kind], SIZE[size], "ring-2 ring-card")}>{initialsOf(f.name)}</span>)}
      {rest > 0 && <span aria-hidden className={cn(FACE, KIND.person, SIZE[size], "text-micro text-muted-foreground tabular-nums ring-2 ring-card")}>+{rest}</span>}
    </span>
  );
}

// The rules a doc's screens follow, apart from any screen.

type Waiting = { id: number; find: string; text_changed: boolean };

export type Queue<T> = { head: T; position: number; total: number; stale: boolean };

/**
 * What the bar shows: the oldest suggestion nobody is deciding, and whether its words are still there. `canApply` asks the open
 * editor, which knows about typing the server hasn't heard yet. With no editor yet, the server's answer stands.
 */
export function queueOf<T extends Waiting>(items: T[], canApply: ((s: T) => boolean) | null, deciding: ReadonlySet<number> = new Set()): Queue<T> | null {
  const open = items.filter((s) => !deciding.has(s.id));
  const head = open[0];
  if (!head) return null;
  return { head, position: 1, total: open.length, stale: canApply ? !canApply(head) : head.text_changed };
}

/** Calls `send` on the first beat, then at most once per `gap`, so typing costs a request every few seconds. */
export function createPulse(send: () => void, gap: number, now: () => number = Date.now) {
  let last = -Infinity;
  return () => {
    if (now() - last < gap) return;
    last = now();
    send();
  };
}

type Saved = { conflict: boolean };
type Save<B, R> = (id: number, body: B) => Promise<R>;

/**
 * A save that loses to an agent's own edit steps past it: the server turns that edit back into a suggestion, and these words land
 * on top, so nobody typing ever sees a dialog about an agent. A race with a person comes back as it was, for the conflict dialog.
 */
export function yieldingSave<B extends { base_version: number }, R extends Saved>(save: Save<B, R>, yieldDoc: (id: number, base: number) => Promise<{ yielded: boolean; version: number }>): Save<B, R> {
  return async (id, body) => {
    const first = await save(id, body);
    if (!first.conflict) return first;
    const answer = await yieldDoc(id, body.base_version).catch(() => null);
    return answer?.yielded ? save(id, { ...body, base_version: answer.version }) : first;
  };
}

const LIVE = ["queued", "claimed", "working", "waiting"];

/** The run a doc's header marks: the newest, while it's going or if it failed. A finished run has said its piece in the thread. */
export const liveRun = <T extends { status: string }>(runs: T[]): T | undefined => {
  const newest = runs[0];
  return newest && (LIVE.includes(newest.status) || newest.status === "failed") ? newest : undefined;
};

export type ListState = "loading" | "failed" | "no-access" | "no-space" | "never" | "no-match" | "trash-empty" | "ready";

export function listState(o: { loaded: boolean; error: unknown; denied: boolean; spaces: number; ever: number; shown: number; filtered: boolean; trash: boolean }): ListState {
  if (o.denied) return "no-access";
  if (o.loaded && o.shown > 0) return "ready";
  if (o.error) return "failed";
  if (!o.loaded) return "loading";
  if (o.trash) return "trash-empty";
  if (o.filtered) return "no-match";
  if (o.spaces === 0 && o.ever === 0) return "no-space";
  return o.ever === 0 ? "never" : "ready";
}

/**
 * What a doc that was open and has gone says (AE3). Taken out of its space, the space is what was lost. Otherwise, or before the
 * space list has caught up, it says what may have happened.
 */
export function goneNotice(o: { spaceId: number | null; mySpaces: number[] | null }): { title: string; description: string } {
  if (o.spaceId !== null && o.mySpaces !== null && !o.mySpaces.includes(o.spaceId)) {
    return { title: "You no longer have access to this space", description: "Someone removed you from it, so this doc has left this screen." };
  }
  return { title: "You no longer have this doc", description: "It was moved to the trash, or someone removed you from its space." };
}

/** Docs grouped by space, keeping each space's newest-first order. The space with the most recent work comes first. */
export function bySpace<T extends { space_id: number }>(rows: readonly T[]): T[] {
  return groupedBy(rows, (d) => d.space_id);
}

/** Rows grouped by `key`, each group in the list's own order, the group seen first first. */
export function groupedBy<T>(rows: readonly T[], key: (row: T) => unknown): T[] {
  const order = new Map<unknown, number>();
  rows.forEach((r) => { if (!order.has(key(r))) order.set(key(r), order.size); });
  return [...rows].sort((a, b) => order.get(key(a))! - order.get(key(b))!);
}

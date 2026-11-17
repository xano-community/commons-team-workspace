// Text someone has typed and not sent. A draft is saved as they type, and survives a reload, an expired session and a
// crash. `spaceId` lets a removal from that space take its drafts with it.
import { useCallback, useEffect, useState } from "react";
import { clearStore, readStore, writeStore } from "./store";

export type Draft = { text: string; at: number; spaceId?: number };
type Drafts = Record<string, Draft>;

const KIND = "drafts";
const all = (userId: number) => readStore<Drafts>(KIND, userId, {});

export const readDraft = (userId: number, id: string): Draft | null => all(userId)[id] ?? null;

export function saveDraft(userId: number, id: string, text: string, spaceId?: number): void {
  const drafts = all(userId);
  if (text) drafts[id] = { text, at: Date.now(), spaceId };
  else delete drafts[id];
  writeStore(KIND, userId, drafts);
}

export const clearDraft = (userId: number, id: string) => saveDraft(userId, id, "");

/** Forgets drafts: all of this person's, or those in one space they were removed from. */
export function purgeDrafts(userId: number, spaceId?: number): void {
  if (spaceId === undefined) { clearStore(KIND, userId); return; }
  writeStore(KIND, userId, Object.fromEntries(Object.entries(all(userId)).filter(([, d]) => d.spaceId !== spaceId)));
}

/** `const [text, setText, clear] = useDraft(me.id, "task-12-comment")`: state that outlives the tab. */
export function useDraft(userId: number, id: string, spaceId?: number) {
  const [text, setLocal] = useState(() => readDraft(userId, id)?.text ?? "");
  useEffect(() => { setLocal(readDraft(userId, id)?.text ?? ""); }, [userId, id]);
  const setText = useCallback((next: string) => { setLocal(next); saveDraft(userId, id, next, spaceId); }, [userId, id, spaceId]);
  const clear = useCallback(() => { setLocal(""); clearDraft(userId, id); }, [userId, id]);
  return [text, setText, clear] as const;
}

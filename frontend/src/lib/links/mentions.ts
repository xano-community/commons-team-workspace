// The rules behind the one mention warning (components/workspace/mention-warning.tsx). A composer or a body editor gives
// `useMentionCheck` who's listening and what's mentioned. While the warning shows, Enter does nothing.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type MentionCheck } from "@/lib/api";
import type { RecordRef } from "./resolver";

/** Who's listening. "crm" is everyone who can open customers: there the question is whether the people named can, not who else is here. */
export type Audience = { type: "conversation" | "space" | "crm"; id: number };
export type AddResult = { added: boolean; warning: string | null };
export type AddMember = (spaceId: number, userId: number, historyOk?: boolean) => Promise<AddResult>;

/** Sends unless the warning is up. Answers whether it sent, so a composer knows to keep its text. */
export function gateSend(warningShows: boolean, send: () => void): boolean {
  if (warningShows) return false;
  send();
  return true;
}

export function missingNames(people: { name: string }[]): string {
  const names = people.map((p) => p.name);
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

const NOBODY: number[] = [];
export const recordKey = (records: RecordRef[]) => records.map((r) => `${r.type}:${r.id}`).sort().join(",");

/**
 * Adds everyone the sender may add. A guest can read a space's past, so the server holds each one back with a warning
 * until someone has seen it, the same as the members dialog. Answers how many joined.
 */
export async function addMissing(groups: MentionCheck["add"], post: AddMember, confirm: (warning: string) => Promise<boolean>): Promise<number> {
  let added = 0;
  for (const { space_id, user_ids } of groups) {
    for (const id of user_ids) {
      const first = await post(space_id, id, undefined);
      if (first.added) { added += 1; continue; }
      if (!first.warning || !(await confirm(first.warning))) continue;
      if ((await post(space_id, id, true)).added) added += 1;
    }
  }
  return added;
}

/**
 * The check for what's mentioned right now. `warning` is what to show. `dismiss` is Send anyway or Keep mention, and it
 * holds until the mentions change. A failed check shows nothing: the reader's chip still locks, so nobody gains access.
 */
export function useMentionCheck(audience: Audience | null, records: RecordRef[], named: number[] = NOBODY) {
  const key = `${recordKey(records)}|${named.join(",")}`;
  const crm = audience?.type === "crm";
  const anything = crm ? named.length > 0 : records.length > 0;
  const [dismissed, setDismissed] = useState("");
  const asked = useQuery({
    queryKey: ["mention-check", audience?.type, audience?.id, key],
    queryFn: () => (crm ? api.crmMentionCheck(named) : api.mentionCheck(audience as { type: "conversation" | "space"; id: number }, records)),
    enabled: !!audience && anything,
    staleTime: 0,
  });
  const warning = asked.data?.warn && dismissed !== key ? asked.data : null;
  const checking = !!audience && anything && asked.isFetching;
  return useMemo(() => ({ warning, checking, dismiss: () => setDismissed(key), recheck: () => void asked.refetch() }), [warning, checking, key]); // eslint-disable-line react-hooks/exhaustive-deps
}

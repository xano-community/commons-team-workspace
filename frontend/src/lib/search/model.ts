// How a search reads on screen. The server decides what may be seen; this only puts it in order and says it plainly.
export type Hit = { key: string; entity: string; entity_id: number; title: string; body: string; href: string; scope: string; changed_at: number; place: string | null; place_kind: string | null };
export type Recent = { type: string; id: number; href: string };

/** Which tool a record belongs to: the ⌘K heading it sits under. Groups show in this order. */
const TOOLS: Record<string, string> = {
  conversation: "Chat", message: "Chat", task: "Tasks", project: "Tasks", doc: "Docs", company: "Customers", contact: "Customers", deal: "Customers", crm_note: "Customers", file: "Files", space: "Spaces",
};
const ORDER = ["Chat", "Tasks", "Docs", "Customers", "Files", "Spaces"];
export const toolOf = (entity: string) => TOOLS[entity] ?? "Other";

/** Where a message was said. A DM's and a thread's names aren't ones anyone gave them. */
export function placeOf(hit: Pick<Hit, "entity" | "place" | "place_kind">): string | undefined {
  if (hit.entity !== "message") return undefined;
  return hit.place_kind === "channel" ? `#${hit.place}` : hit.place_kind === "dm" ? "Direct message" : "In a thread";
}

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

/** Best first: the whole title, then a title that starts with the search, then one holding every word, then the rest, newest first. */
function score(hit: Hit, q: string): number {
  const title = hit.title.toLowerCase(), wanted = q.trim().toLowerCase();
  if (title === wanted) return 0;
  if (title.startsWith(wanted)) return 1;
  if (words(q).every((w) => title.includes(w))) return 2;
  return 3;
}

export const rankHits = (hits: Hit[], q: string) => [...hits].sort((a, b) => score(a, q) - score(b, q) || b.changed_at - a.changed_at);

/** Tools in their fixed order, each keeping its best-first order, so a keyboard user learns where things sit. */
export function groupHits(hits: Hit[]): [string, Hit[]][] {
  const groups = new Map<string, Hit[]>();
  for (const hit of hits) groups.set(toolOf(hit.entity), [...(groups.get(toolOf(hit.entity)) ?? []), hit]);
  return [...groups.entries()].sort(([a], [b]) => ORDER.indexOf(a) - ORDER.indexOf(b));
}

const REACH = 40;
/** The part of a record's words around the first match, on one line. Nothing when the title already says it. */
export function snippet(hit: Pick<Hit, "title" | "body">, q: string, width = 96): string {
  const body = hit.body.replace(/\s+/g, " ").trim();
  if (!body || hit.title.trim() === body.slice(0, hit.title.trim().length)) return "";
  const at = Math.min(...words(q).map((w) => body.toLowerCase().indexOf(w)).filter((i) => i >= 0), Infinity);
  if (at === Infinity) return "";
  const start = Math.max(0, at - REACH);
  return `${start > 0 ? "…" : ""}${body.slice(start, start + width).trim()}${start + width < body.length ? "…" : ""}`;
}

/** Splits text into plain and matching runs, for showing what matched. */
export function marks(text: string, q: string): { text: string; hit: boolean }[] {
  const wanted = words(q).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!wanted.length) return [{ text, hit: false }];
  return text.split(new RegExp(`(${wanted.join("|")})`, "gi")).filter(Boolean).map((part) => ({ text: part, hit: words(q).includes(part.toLowerCase()) }));
}

/** Which of `items` hold a search, for the static commands. Every word must appear. */
export function matches(q: string, ...fields: (string | undefined)[]): boolean {
  const hay = fields.join(" ").toLowerCase();
  return words(q).every((w) => hay.includes(w));
}

const MOST_RECENT = 6;
/** Newest first, with no record twice. */
export const addRecent = (list: Recent[], item: Recent) => [item, ...list.filter((r) => r.type !== item.type || r.id !== item.id)].slice(0, MOST_RECENT);

// Search in ⌘K, from any screen. One request covers all five tools, and it stays small, because the shell carries it.
import { Building2, CircleCheck, File, FileText, Hash, Layers, MessageSquare, type LucideIcon } from "lucide-react";
import type { PaletteItem } from "@/components/kit";
import { request } from "@/base/request";
import { api } from "@/lib/api";
import { routePath } from "../../../../xano/routes.gen.js";
import { addRecent, groupHits, placeOf, rankHits, snippet, type Hit, type Recent } from "./model";

const ICONS: Record<string, LucideIcon> = {
  conversation: Hash, message: MessageSquare, task: CircleCheck, project: CircleCheck, doc: FileText, company: Building2, contact: Building2, deal: Building2, crm_note: Building2, file: File, space: Layers,
};
const STORE = "search:recent";
const read = (): Recent[] => { try { return JSON.parse(localStorage.getItem(STORE) ?? "[]") as Recent[]; } catch { return []; } };
const remember = (item: Recent) => { try { localStorage.setItem(STORE, JSON.stringify(addRecent(read(), item))); } catch { /* storage off */ } };

export async function searchAll(q: string, go: (href: string) => void): Promise<PaletteItem[]> {
  const { items } = await request<{ items: Hit[] }>("GET", `${routePath("GET search")}?q=${encodeURIComponent(q)}`);
  return groupHits(rankHits(items, q)).flatMap(([group, hits]) => hits.map((hit) => ({
    id: hit.key, label: hit.title || "Untitled", group, icon: ICONS[hit.entity], hint: placeOf(hit), detail: snippet(hit, q),
    run: () => { remember({ type: hit.entity, id: hit.entity_id, href: hit.href }); go(hit.href); },
  })));
}

/** What was opened last, read fresh, so a rename shows and a record someone has lost access to drops out. */
export async function recentItems(go: (href: string) => void): Promise<PaletteItem[]> {
  const list = read();
  if (!list.length) return [];
  const views = await api.resolveRecords(list.map(({ type, id }) => ({ type, id })));
  return views.flatMap((view, i) => (view.state === "live" || view.state === "archived" ? [{
    id: `recent.${view.type}.${view.id}`, label: view.title, group: "Recent", icon: ICONS[view.type], run: () => { remember(list[i]); go(list[i].href); },
  }] : []));
}

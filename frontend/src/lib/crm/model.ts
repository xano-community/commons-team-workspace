// What the customer screens agree on, kept free of React so it can be tested alone: what a filter means, what the board's columns
// say, and which of its states a screen is in.
import type { CompanyDetails, CompanyPage, CompanyRow, CompanyView, ContactPage, ContactView, CrmHit, CrmSetup, DealDetails, DealView, NoteView, PanelView, Panels, Pipeline, PipelineStage, Stage } from "../../../../xano/query/crm";

export type { CompanyDetails, CompanyPage, CompanyRow, CompanyView, ContactPage, ContactView, CrmHit, CrmSetup, DealDetails, DealView, NoteView, PanelView, Panels, Pipeline, PipelineStage, Stage };
export type PipelineRequest = { q?: string; owner_id?: number; company_id?: number; close_from?: string; close_to?: string; limit?: number };

const CURRENCY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
/** One currency a workspace, in whole units. Change it here. */
export const money = (value: number) => CURRENCY.format(value);

export const CLOSE_LABELS = { month: "This month", soon: "Next 30 days", quarter: "This quarter" } as const;
export type CloseWord = keyof typeof CLOSE_LABELS;
export type CrmFilters = { q: string; owner: string; close: string };
export const EMPTY_FILTERS: CrmFilters = { q: "", owner: "", close: "" };

export const queryOf = (f: CrmFilters): Partial<CrmFilters> => Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as Partial<CrmFilters>;
export const activeFilters = (f: CrmFilters) => Object.values(queryOf(f)).length;

/** A filter from a link, keeping only what can mean something today. */
export function filtersFromQuery(query: Partial<Record<keyof CrmFilters, unknown>>): CrmFilters {
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const owner = text(query.owner);
  return {
    q: text(query.q),
    owner: owner === "me" || owner === "none" || /^[1-9]\d*$/.test(owner) ? owner : "",
    close: text(query.close) in CLOSE_LABELS ? text(query.close) : "",
  };
}

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export function closeRange(word: string, now: Date): Pick<PipelineRequest, "close_from" | "close_to"> {
  const year = now.getFullYear(), month = now.getMonth();
  if (word === "month") return { close_from: day(new Date(year, month, 1)), close_to: day(new Date(year, month + 1, 0)) };
  if (word === "soon") return { close_from: day(now), close_to: day(new Date(year, month, now.getDate() + 30)) };
  if (word === "quarter") { const first = month - (month % 3); return { close_from: day(new Date(year, first, 1)), close_to: day(new Date(year, first + 3, 0)) }; }
  return {};
}

export function toRequest(f: CrmFilters, o: { me: number; limit: number }, now: Date): PipelineRequest {
  const owner_id = f.owner === "me" ? o.me : f.owner === "none" ? -1 : Number(f.owner) || undefined;
  return { q: f.q || undefined, owner_id, limit: o.limit, ...closeRange(f.close, now) };
}

export type ScreenState = "loading" | "failed" | "no-access" | "no-companies" | "no-deals" | "all-closed" | "no-match" | "ready";

/** Which of its states the pipeline is in. A refresh that fails keeps what's on screen: only a first load can be "failed". */
export function screenState(s: { error: unknown; loaded: boolean; denied: boolean; companies: number; ever: number; open: number; shown: number; filtered: boolean }): ScreenState {
  if (s.denied) return "no-access";
  if (!s.loaded) return s.error ? "failed" : "loading";
  if (s.filtered) return s.shown ? "ready" : "no-match";
  if (!s.ever) return s.companies ? "no-deals" : "no-companies";
  return s.open ? "ready" : "all-closed";
}

export const columnsOf = (stages: Pick<PipelineStage, "id" | "name" | "kind" | "value">[]) => stages.map((s) => ({
  id: String(s.id), title: s.name, tone: s.kind === "won" ? "success" as const : "neutral" as const, hint: s.value > 0 ? money(s.value) : undefined,
  // A lost deal is history: its column folds to a rail on a wide screen, so the open stages and Won fit side by side.
  rail: s.kind === "lost",
}));
export const openValue = (stages: Pick<PipelineStage, "kind" | "value">[]) => stages.filter((s) => s.kind === "open").reduce((sum, s) => sum + s.value, 0);
export const isOverdue = (deal: Pick<DealView, "close_on" | "closed_at">, today: string) => !!deal.close_on && !deal.closed_at && deal.close_on < today;
export const today = () => day(new Date());

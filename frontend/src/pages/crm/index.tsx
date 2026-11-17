// /crm: the pipeline, the workspace's second signature view. A card moves by mouse, by key and by its menu, and each lands in the
// same place, because all three go through the same order rule. On a phone the columns scroll sideways, one at a time.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Building2, CircleDollarSign, ListFilter, Plus, SearchX, Settings2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, FilterSelect, KanbanBoard, KanbanCard, KeyHint, LoadError, SearchInput, useUrlState } from "@/components/kit";
import { useCan } from "@/base/access";
import { useMe } from "@/base/session";
import { useIsMobile } from "@/hooks/use-mobile";
import { CATALOG, useCommands, type Command } from "@/lib/commands";
import { useCrmActions, useCrmSetup, usePipeline, type NewDeal } from "@/lib/crm/client";
import { CLOSE_LABELS, EMPTY_FILTERS, activeFilters, columnsOf, filtersFromQuery, isOverdue, money, openValue, screenState, toRequest, today, type DealView } from "@/lib/crm/model";
import { nudgeAcross, nudgeWithin, stepDeals, type DealMove } from "@/lib/crm/order";
import { neighbour, type Direction } from "@/lib/tasks/order";
import { cn } from "@/lib/utils";
import { CompanyDialog, NewDealDialog, StagesDialog, type DealDraft } from "./dialogs";
import { CrmFrame, Wrap } from "./frame";
import { CrmMenu, useCrmMenu, type MenuKind } from "./menu";

const A_COLUMN = 100;
const MOST_AT_ONCE = 500;
const statusOf = (e: unknown) => (e as { status?: number } | null)?.status;
const FILTER_WIDTH = "w-40 shrink-0 [&_button[role=combobox]]:max-sm:!h-11";

const Card = memo(function Card({ deal }: { deal: DealView }) {
  return <KanbanCard title={deal.title} amount={money(deal.value)} due={deal.close_on} done={!!deal.closed_at} extra={deal.company_name ? <span className="order-first line-clamp-2 basis-full" title={deal.company_name}>{deal.company_name}</span> : undefined}
    assignee={deal.owner_name ? { name: deal.owner_name, kind: deal.owner_kind === "agent" ? "agent" : "person" } : null} />;
});

function Loading() {
  return <div aria-busy="true" aria-label="Loading the pipeline" data-testid="crm-loading" className="flex min-h-0 flex-1 gap-3 overflow-hidden p-3">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={`skeleton-${i}`} className="h-64 w-64 shrink-0 rounded-lg" />)}</div>;
}

export function PipelinePage() {
  const me = useMe()!;
  const allowed = useCan("crm.read");
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useUrlState(EMPTY_FILTERS);
  const filters = useMemo(() => filtersFromQuery(q), [q]);
  const [limit, setLimit] = useState(A_COLUMN);
  const request = useMemo(() => toRequest(filters, { me: me.id, limit }, new Date()), [filters, me.id, limit]);
  const page = usePipeline(request, allowed);
  const setup = useCrmSetup(allowed);
  const actions = useCrmActions();
  const menu = useCrmMenu();

  // In rank order: a move changes a row's rank, not where it sits in the answer.
  const rows = useMemo(() => (page.data?.items ?? []).filter((d) => !d.deleted_at).sort((x, y) => x.rank - y.rank || x.id - y.id), [page.data]);
  const stages = useMemo(() => page.data?.stages ?? [], [page.data]);
  const stageIds = useMemo(() => stages.map((s) => s.id), [stages]);
  const columns = useMemo(() => columnsOf(stages), [stages]);
  const stageOf = useCallback((id: number) => stages.find((s) => s.id === id), [stages]);
  const order = useMemo(() => stageIds.flatMap((id) => rows.filter((r) => r.stage_id === id)).map((d) => d.id), [rows, stageIds]);

  const [selected, setSelected] = useState<number | null>(null);
  const [newDeal, setNewDeal] = useState<Partial<DealDraft> | null>(null);
  const [newCompany, setNewCompany] = useState(false);
  const [editStages, setEditStages] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const deal = rows.find((d) => d.id === selected);
  const canAdd = (page.data?.companies ?? 0) > 0;

  // A deal that left the view hands selection to its neighbour, so the keyboard stays where it was.
  const lastOrder = useRef<number[]>([]);
  useEffect(() => {
    if (selected !== null && !order.includes(selected)) setSelected(neighbour(lastOrder.current, selected));
    lastOrder.current = order;
  }, [order, selected]);

  // ⌘K's New deal lands here from any screen.
  useEffect(() => {
    if (params.get("new") !== "deal" || !setup.data || !page.data) return;
    setParams((p) => { p.delete("new"); return p; }, { replace: true });
    if (canAdd) setNewDeal({}); else setNewCompany(true);
  }, [params, setup.data, page.data, canAdd, setParams]);

  const create = (d: NewDeal, draft: DealDraft) => {
    setNewDeal(null);
    void actions.createDeal(d, rows).then((ended) => { if (ended === "failed") setNewDeal(draft); });
  };
  const open = useCallback((d: DealView) => { if (d.id > 0) navigate(`/crm/deals/${d.id}`); }, [navigate]);
  const anchorOf = (d: DealView) => document.querySelector<HTMLElement>(`[data-kanban-card="${d.id}"]`);
  const walk = (direction: Direction) => setSelected(stepDeals(rows, stageIds, selected, direction));
  const live = () => !!deal && deal.id > 0;
  const nudge = (m: DealMove | null | undefined) => { const stage = m && stageOf(m.stage_id); if (m && stage && deal) void actions.move(deal, m, stage); };
  const property = (kind: MenuKind) => () => { if (deal) menu.open({ kind, deal, anchor: anchorOf(deal) }); };
  const commands: Command[] = [
    { id: "list.next", ...CATALOG["list.next"], run: () => walk("down") },
    { id: "list.previous", ...CATALOG["list.previous"], run: () => walk("up") },
    { id: "list.next-arrow", ...CATALOG["list.next-arrow"], run: () => walk("down") },
    { id: "list.previous-arrow", ...CATALOG["list.previous-arrow"], run: () => walk("up") },
    { id: "tasks.column-left", ...CATALOG["tasks.column-left"], label: "Select the deal to the left", run: () => walk("left") },
    { id: "tasks.column-right", ...CATALOG["tasks.column-right"], label: "Select the deal to the right", run: () => walk("right") },
    { id: "list.open", ...CATALOG["list.open"], when: live, run: () => deal && open(deal) },
    { id: "list.close", ...CATALOG["list.close"], when: () => selected !== null, run: () => setSelected(null) },
    { id: "tasks.new", ...CATALOG["tasks.new"], label: "New deal", group: "Customers", icon: Plus, when: () => allowed && !!setup.data, run: () => (canAdd ? setNewDeal({}) : setNewCompany(true)) },
    { id: "tasks.status", ...CATALOG["tasks.status"], label: "Move to a stage", group: "Customers", when: live, run: property("stage") },
    { id: "tasks.assign", ...CATALOG["tasks.assign"], label: "Give this deal to someone", group: "Customers", when: live, run: property("owner") },
    { id: "tasks.assign-me", ...CATALOG["tasks.assign-me"], label: "Give this deal to me", group: "Customers", when: live, run: () => deal && actions.assign(deal, { id: me.id, name: me.name, kind: "human" }) },
    { id: "tasks.due", ...CATALOG["tasks.due"], label: "Set the close date", group: "Customers", when: live, run: property("close") },
    { id: "tasks.delete", ...CATALOG["tasks.delete"], label: "Delete the deal", group: "Customers", when: live, run: () => deal && void actions.removeDeal(deal) },
    { id: "tasks.move-up", ...CATALOG["tasks.move-up"], when: live, run: () => nudge(deal && nudgeWithin(rows, deal.id, -1)) },
    { id: "tasks.move-down", ...CATALOG["tasks.move-down"], when: live, run: () => nudge(deal && nudgeWithin(rows, deal.id, 1)) },
    { id: "tasks.move-left", ...CATALOG["tasks.move-left"], when: live, run: () => nudge(deal && nudgeAcross(rows, deal.id, -1, stageIds)) },
    { id: "tasks.move-right", ...CATALOG["tasks.move-right"], when: live, run: () => nudge(deal && nudgeAcross(rows, deal.id, 1, stageIds)) },
  ];
  useCommands(commands, "crm-pipeline");

  const filtered = activeFilters(filters) > 0;
  const state = screenState({ error: page.error ?? setup.error, loaded: !!page.data && !!setup.data, denied: statusOf(page.error) === 404, companies: page.data?.companies ?? 0, ever: page.data?.ever ?? 0, open: page.data?.open ?? 0, shown: rows.length, filtered });
  const clear = () => setQ({ ...EMPTY_FILTERS });
  const owners = useMemo(() => [{ value: "me", label: "Me" }, { value: "none", label: "Nobody" }, ...(setup.data?.people ?? []).filter((p) => p.id !== me.id).map((p) => ({ value: String(p.id), label: p.kind === "agent" ? `${p.name} (agent)` : p.name }))], [setup.data, me.id]);
  const now = today();

  const actionsBar = (
    <>
      <Button variant="ghost" size="icon-sm" aria-label="Filters" aria-expanded={showFilters} data-testid="filters-toggle" onClick={() => setShowFilters((s) => !s)} className="size-11 shrink-0 text-muted-foreground md:hidden"><ListFilter /></Button>
      {setup.data?.can_manage && <Button variant="ghost" size="sm" data-testid="stages-button" onClick={() => setEditStages(true)} className="text-muted-foreground max-md:size-11 max-md:px-0"><Settings2 /><span className="max-md:sr-only">Stages</span></Button>}
      <Button size="sm" data-testid="new-deal-button" disabled={!setup.data} onClick={() => (canAdd ? setNewDeal({}) : setNewCompany(true))} className="max-md:size-11 max-md:px-0"><Plus /><span className="max-md:sr-only">New deal</span><KeyHint shortcut={CATALOG["tasks.new"].shortcut} className="max-md:hidden" /></Button>
    </>
  );
  const filterBar = state !== "no-companies" && state !== "no-deals" && (
    <div className={cn("shrink-0 border-b", !showFilters && !filtered && "max-md:hidden")}>
      <div className="kit-scroll-x flex items-center gap-2 px-3 py-1.5">
        <SearchInput value={filters.q} onChange={(v) => setQ({ q: v })} placeholder="Search deals" className="w-44 shrink-0 flex-none [&_input]:max-sm:h-11" />
        <FilterSelect label="Owner" allLabel="Anyone" value={filters.owner} onChange={(v) => setQ({ owner: v })} options={owners} className={FILTER_WIDTH} />
        <FilterSelect label="Close date" allLabel="Any close date" value={filters.close} onChange={(v) => setQ({ close: v })} options={Object.entries(CLOSE_LABELS).map(([value, label]) => ({ value, label }))} className={FILTER_WIDTH} />
        {filtered && <Button variant="ghost" size="sm" onClick={clear} data-testid="clear-filters" className="shrink-0 text-muted-foreground max-md:min-h-11">Clear</Button>}
      </div>
    </div>
  );

  return (
    <CrmFrame tab="pipeline" actions={actionsBar} filters={filterBar}>
      {state === "loading" && <Loading />}
      {state === "failed" && <Wrap id="crm-failed"><LoadError title="The pipeline didn't load" error={page.error ?? setup.error} onRetry={() => { void page.refetch(); void setup.refetch(); }} /></Wrap>}
      {state === "no-access" && <Wrap id="crm-denied"><EmptyState icon={SearchX} className="border-0" title="Customers can't be opened" description="You may no longer have access. Ask an admin if you think you should." /></Wrap>}
      {state === "no-companies" && <Wrap id="crm-no-companies"><EmptyState icon={Building2} className="border-0" title="No customers yet" description="Add the first company you're talking to. Its deals, people and notes all sit under it." action={<Button size="sm" onClick={() => setNewCompany(true)} data-testid="first-company" className="max-md:min-h-11"><Plus />Add a company</Button>} /></Wrap>}
      {state === "no-deals" && <Wrap id="crm-no-deals"><EmptyState icon={CircleDollarSign} className="border-0" title="No deals yet" description="Start the first one, and it takes its place on the board." action={<Button size="sm" onClick={() => setNewDeal({})} className="max-md:min-h-11"><Plus />Add a deal</Button>} /></Wrap>}
      {state === "no-match" && <Wrap id="crm-no-match"><EmptyState icon={SearchX} className="border-0" title="No deals match these filters" description="Clear them to see the whole pipeline." action={<Button size="sm" variant="outline" onClick={clear} className="max-md:min-h-11"><X />Clear filters</Button>} /></Wrap>}
      {state === "all-closed" && <p role="status" data-testid="crm-all-closed" className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/50 px-4 py-1.5 text-caption text-muted-foreground"><span className="min-w-0 flex-1 basis-48">Every deal is closed. Nothing is open right now.</span><Button size="sm" variant="outline" onClick={() => setNewDeal({})} className="max-md:min-h-11"><Plus />New deal</Button></p>}
      {(state === "ready" || state === "all-closed") && (
        <div className="min-h-0 flex-1 px-4 pt-3 pb-2" data-testid="crm-board">
          <KanbanBoard fill signature="crm" label="Deals by stage" columns={columns} items={rows} columnOf={(d) => String(d.stage_id)} itemKey={(d) => d.id} keyboardMoves={false} selected={selected} onSelect={(k) => setSelected(Number(k))}
            renderCard={(d) => <Card deal={d} />} canMove={(d) => d.id > 0} overdueOf={(d) => isOverdue(d, now)}
            onMove={(d, to) => { const stage = stageOf(Number(to)); if (stage) void actions.setStage(d, stage, rows); }}
            onReorder={(d, to, before) => { const stage = stageOf(Number(to)); if (stage) void actions.drop(d, stage, before === null ? null : Number(before), rows); }}
            onOpen={open} onAdd={canAdd ? (id) => setNewDeal({ stage: id }) : undefined} emptyColumn="No deals"
            footer={(id) => {
              const left = (stageOf(Number(id))?.deals ?? 0) - rows.filter((r) => String(r.stage_id) === id).length;
              return left > 0 ? <div className="px-2 pb-1"><Button variant="ghost" size="sm" onClick={() => setLimit((l) => Math.min(MOST_AT_ONCE, l + A_COLUMN))} data-testid="deal-more" className="w-full text-muted-foreground max-md:min-h-11">Show {left} more</Button></div> : null;
            }} />
        </div>
      )}
      {!mobile && state === "ready" && (
        <footer className="flex shrink-0 items-center gap-4 border-t px-3 py-1 text-caption text-muted-foreground">
          <span className="tabular-nums" data-testid="crm-open-value">{money(openValue(stages))} open</span>
          <span className="ml-auto flex items-center gap-1"><KeyHint shortcut="n" />new</span>
          <span className="flex items-center gap-1"><KeyHint shortcut="s" />stage</span>
          <span className="flex items-center gap-1"><KeyHint shortcut="a" />owner</span>
          <span className="flex items-center gap-1"><KeyHint shortcut="shift+arrowright" />move</span>
          <span className="flex items-center gap-1"><KeyHint shortcut="?" />all keys</span>
        </footer>
      )}
      <CrmMenu request={menu.request} close={menu.close} rows={rows} />
      {newDeal && setup.data && <NewDealDialog setup={setup.data} start={newDeal} onCreate={create} onClose={() => setNewDeal(null)} />}
      {newCompany && <CompanyDialog onClose={() => setNewCompany(false)} onMade={(c) => { setNewCompany(false); navigate(`/crm/companies/${c.id}`); }} />}
      {editStages && setup.data && <StagesDialog stages={setup.data.stages} onClose={() => setEditStages(false)} />}
    </CrmFrame>
  );
}

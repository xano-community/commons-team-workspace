// /crm/companies and /crm/contacts: plain lists, read by key. A row is a link, so it opens in a new tab like any link, and j and k walk
// it through the same commands as every other list here.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Building2, Plus, SearchX, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, EmptyState, FilterSelect, KeyHint, LoadError, Pager, SearchInput, useUrlState } from "@/components/kit";
import { useCan } from "@/base/access";
import { useMe } from "@/base/session";
import { CATALOG, useCommands, type Command } from "@/lib/commands";
import { useCompanies, useContacts, useCrmSetup } from "@/lib/crm/client";
import { money, type CompanyRow, type ContactView } from "@/lib/crm/model";
import { cn } from "@/lib/utils";
import { CompanyDialog } from "./dialogs";
import { CrmFrame, Wrap } from "./frame";

const A_PAGE = 50;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const ROW = "focus-ring-inset flex min-h-11 min-w-0 items-center gap-3 border-b border-border/60 px-3 py-1.5 hover:bg-muted/50 data-[selected]:bg-selected";

function useRows<T extends { id: number }>(rows: T[], href: (row: T) => string) {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<number | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const walk = useCallback((by: 1 | -1) => {
    const at = rows.findIndex((r) => r.id === selected);
    const next = rows[Math.min(rows.length - 1, Math.max(0, at + by))];
    if (next) setSelected(next.id);
  }, [rows, selected]);
  useEffect(() => { if (selected !== null) list.current?.querySelector<HTMLElement>(`[data-row="${selected}"]`)?.focus(); }, [selected]);
  const row = rows.find((r) => r.id === selected);
  const commands: Command[] = [
    { id: "list.next", ...CATALOG["list.next"], run: () => walk(1) },
    { id: "list.previous", ...CATALOG["list.previous"], run: () => walk(-1) },
    { id: "list.next-arrow", ...CATALOG["list.next-arrow"], run: () => walk(1) },
    { id: "list.previous-arrow", ...CATALOG["list.previous-arrow"], run: () => walk(-1) },
    { id: "list.open", ...CATALOG["list.open"], when: () => !!row, run: () => { if (row) navigate(href(row)); } },
    { id: "list.close", ...CATALOG["list.close"], when: () => selected !== null, run: () => setSelected(null) },
  ];
  return { selected, list, commands };
}

function Loading() {
  return <div aria-busy="true" aria-label="Loading" data-testid="crm-list-loading" className="space-y-2 p-3">{["w-3/5", "w-2/5", "w-1/2", "w-3/4", "w-1/3"].map((w) => <Skeleton key={w} className={cn("h-6", w)} />)}</div>;
}

function Foot({ page, total, next, noun, onPage }: { page: number; total: number; next: number | null; noun: string; onPage: (p: number) => void }) {
  return <footer className="flex min-h-9 shrink-0 items-center border-t px-3 py-1"><Pager page={page} pageTotal={next ? page + 1 : page} itemsTotal={total} perPage={A_PAGE} noun={noun} onPage={onPage} /></footer>;
}

const Filters = ({ children }: { children: ReactNode }) => <div className="shrink-0 border-b"><div className="kit-scroll-x flex items-center gap-2 px-3 py-1.5">{children}</div></div>;

export function CompaniesPage() {
  const me = useMe()!;
  const allowed = useCan("crm.read");
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [f, setF] = useUrlState({ q: "", owner: "" });
  const [pageNo, setPageNo] = useState(1);
  useEffect(() => setPageNo(1), [f.q, f.owner]);
  const owner_id = f.owner === "me" ? me.id : f.owner === "none" ? -1 : Number(f.owner) || undefined;
  const page = useCompanies({ q: f.q || undefined, owner_id, page: pageNo }, allowed);
  const setup = useCrmSetup(allowed);
  const rows = useMemo(() => (page.data?.items ?? []).filter((c) => !c.deleted_at), [page.data]);
  const keys = useRows(rows, (c) => `/crm/companies/${c.id}`);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (params.get("new") !== "company") return;
    setParams((p) => { p.delete("new"); return p; }, { replace: true });
    setAdding(true);
  }, [params, setParams]);
  useCommands([...keys.commands, { id: "tasks.new", ...CATALOG["tasks.new"], label: "New company", group: "Customers", icon: Plus, when: () => allowed, run: () => setAdding(true) }], "crm-companies");
  const filtered = !!(f.q || f.owner);
  const clear = () => setF({ q: "", owner: "" });
  const owners = useMemo(() => [{ value: "me", label: "Me" }, { value: "none", label: "Nobody" }, ...(setup.data?.people ?? []).filter((p) => p.id !== me.id).map((p) => ({ value: String(p.id), label: p.kind === "agent" ? `${p.name} (agent)` : p.name }))], [setup.data, me.id]);
  const never = !!page.data && !page.data.ever;
  return (
    <CrmFrame tab="companies"
      actions={<Button size="sm" data-testid="new-company-button" onClick={() => setAdding(true)} className="max-md:size-11 max-md:px-0"><Plus /><span className="max-md:sr-only">New company</span><KeyHint shortcut={CATALOG["tasks.new"].shortcut} className="max-md:hidden" /></Button>}
      filters={!never && (
        <Filters>
          <SearchInput value={f.q} onChange={(q) => setF({ q })} placeholder="Search companies" className="w-52 shrink-0 flex-none [&_input]:max-sm:h-11" />
          <FilterSelect label="Owner" allLabel="Anyone" value={f.owner} onChange={(owner) => setF({ owner })} options={owners} className="w-40 shrink-0 [&_button[role=combobox]]:max-sm:!h-11" />
          {filtered && <Button variant="ghost" size="sm" onClick={clear} data-testid="clear-filters" className="shrink-0 text-muted-foreground max-md:min-h-11">Clear</Button>}
        </Filters>
      )}>
      {!page.data && !page.error && <Loading />}
      {!page.data && page.error && <Wrap id="companies-failed"><LoadError title="Your companies didn't load" error={page.error} onRetry={() => void page.refetch()} /></Wrap>}
      {never && <Wrap id="companies-never"><EmptyState icon={Building2} className="border-0" title="No companies yet" description="Add the first company you're talking to. Its deals, people and notes all sit under it." action={<Button size="sm" onClick={() => setAdding(true)} className="max-md:min-h-11"><Plus />Add a company</Button>} /></Wrap>}
      {page.data && !never && !rows.length && <Wrap id="companies-no-match"><EmptyState icon={SearchX} className="border-0" title="No companies match" description="Clear the search to see them all." action={<Button size="sm" variant="outline" onClick={clear} className="max-md:min-h-11"><X />Clear filters</Button>} /></Wrap>}
      {rows.length > 0 && (
        <>
          <ul ref={keys.list} aria-label="Companies" data-testid="company-list" className="min-h-0 flex-1 overflow-y-auto">
            {rows.map((c) => <CompanyLine key={c.id} company={c} selected={keys.selected === c.id} />)}
          </ul>
          <Foot page={pageNo} total={page.data?.total ?? 0} next={page.data?.next_page ?? null} noun="companies" onPage={setPageNo} />
        </>
      )}
      {adding && <CompanyDialog onClose={() => setAdding(false)} onMade={(c) => { setAdding(false); navigate(`/crm/companies/${c.id}`); }} />}
    </CrmFrame>
  );
}

function CompanyLine({ company: c, selected }: { company: CompanyRow; selected: boolean }) {
  return (
    <li>
      <Link to={`/crm/companies/${c.id}`} data-row={c.id} data-testid="company-row" data-selected={selected || undefined} tabIndex={selected ? 0 : -1} className={ROW}>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 md:flex-row md:items-center md:gap-3">
          <span className="truncate text-body font-medium md:w-64 md:shrink-0">{c.name}</span>
          <span className="truncate text-caption text-muted-foreground">{c.industry || c.domain}</span>
        </span>
        <span className="shrink-0 text-caption text-muted-foreground max-md:hidden">{plural(c.contacts, "contact")}</span>
        <span className="w-28 shrink-0 text-right text-caption tabular-nums max-md:w-auto">{c.open_deals > 0 ? money(c.open_value) : <span className="text-muted-foreground">No open deals</span>}</span>
        {c.owner_name ? <Avatar name={c.owner_name} kind={c.owner_kind} size="xs" /> : <span aria-hidden className="size-5 shrink-0" />}
      </Link>
    </li>
  );
}

export function ContactsPage() {
  const allowed = useCan("crm.read");
  const [f, setF] = useUrlState({ q: "" });
  const [pageNo, setPageNo] = useState(1);
  useEffect(() => setPageNo(1), [f.q]);
  const page = useContacts({ q: f.q || undefined, page: pageNo }, allowed);
  const rows = useMemo(() => (page.data?.items ?? []).filter((c) => !c.deleted_at), [page.data]);
  const href = (c: ContactView) => `/crm/companies/${c.company_id}?contact=${c.id}`;
  const keys = useRows(rows, href);
  useCommands(keys.commands, "crm-contacts");
  const never = !!page.data && !page.data.ever;
  return (
    <CrmFrame tab="contacts" filters={!never && <Filters><SearchInput value={f.q} onChange={(q) => setF({ q })} placeholder="Search contacts" className="w-44 shrink-0 flex-none [&_input]:max-sm:h-11" /></Filters>}>
      {!page.data && !page.error && <Loading />}
      {!page.data && page.error && <Wrap id="contacts-failed"><LoadError title="Your contacts didn't load" error={page.error} onRetry={() => void page.refetch()} /></Wrap>}
      {never && <Wrap id="contacts-never"><EmptyState icon={Users} className="border-0" title="No contacts yet" description="People sit under their company. Open a company to add the first one." action={<Button asChild size="sm" variant="outline" className="max-md:min-h-11"><Link to="/crm/companies">Go to companies</Link></Button>} /></Wrap>}
      {page.data && !never && !rows.length && <Wrap id="contacts-no-match"><EmptyState icon={SearchX} className="border-0" title="No contacts match" description="Clear the search to see them all." action={<Button size="sm" variant="outline" onClick={() => setF({ q: "" })} className="max-md:min-h-11"><X />Clear search</Button>} /></Wrap>}
      {rows.length > 0 && (
        <>
          <ul ref={keys.list} aria-label="Contacts" data-testid="contact-list" className="min-h-0 flex-1 overflow-y-auto">
            {rows.map((c) => (
              <li key={c.id}>
                <Link to={href(c)} data-row={c.id} data-testid="contact-row" data-selected={keys.selected === c.id || undefined} tabIndex={keys.selected === c.id ? 0 : -1} className={ROW}>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5 md:flex-row md:items-center md:gap-3">
                    <span className="truncate text-body font-medium md:w-56 md:shrink-0">{c.name}</span>
                    <span className="truncate text-caption text-muted-foreground">{[c.job_title, c.company_name].filter(Boolean).join(", ")}</span>
                  </span>
                  <span className="truncate text-caption text-muted-foreground max-md:hidden">{c.email}</span>
                </Link>
              </li>
            ))}
          </ul>
          <Foot page={pageNo} total={page.data?.total ?? 0} next={page.data?.next_page ?? null} noun="contacts" onPage={setPageNo} />
        </>
      )}
    </CrmFrame>
  );
}

// /crm/companies/:id: one customer, and everything the rest of the workspace knows about them, filtered for whoever's looking.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { CircleUserRound, Copy, ExternalLink, MessagesSquare, MoreHorizontal, Pencil, Plus, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Avatar, DueLabel, StatusBadge, rememberedHref } from "@/components/kit";
import { AgentMark } from "@/components/workspace/agent-mark";
import { useCan } from "@/base/access";
import { roomOf } from "@/base/live";
import { useMe } from "@/base/session";
import { useIsMobile } from "@/hooks/use-mobile";
import { CATALOG, useCommands, type Command } from "@/lib/commands";
import { crmApi } from "@/lib/crm/api";
import { useCompanyDetails, useCrmActions, useCrmSetup, type NewDeal } from "@/lib/crm/client";
import { money } from "@/lib/crm/model";
import { shellToast } from "@/lib/toast";
import { CompanyDialog, ContactDialog, NewDealDialog } from "./dialogs";
import { CrmMenu, useCrmMenu } from "./menu";
import { Notes } from "./notes";
import { CompanyPanels } from "./panels";
import { CantOpen, FIELD, Loading, RecordFrame, Trashed } from "./record";
import { RecordThread } from "./thread";
import RecordApprovals from "@/components/workspace/approval-card";

const copy = (text: string) => void navigator.clipboard?.writeText(text).then(() => shellToast.show("Copied"), () => shellToast.error("Your browser wouldn't copy that. Select the text instead."));

export function CompanyPage() {
  const id = Number(useParams().id);
  const me = useMe()!;
  const allowed = useCan("crm.read");
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const [params, setParams] = useSearchParams();
  const seq = Number(params.get("seq")) || null;
  const pane = params.get("pane") === "thread" || (mobile && seq) ? "thread" : "details";
  const details = useCompanyDetails(id);
  const setup = useCrmSetup(allowed);
  const actions = useCrmActions();
  const menu = useCrmMenu();
  const company = details.data && details.data.id === id ? details.data : undefined;
  const key = useMemo(() => ["company", "details", id] as const, [id]);

  const [editing, setEditing] = useState(false);
  const [addingDeal, setAddingDeal] = useState(false);
  const [addingContact, setAddingContact] = useState(false);
  const seen = useRef(false);
  if (company) seen.current = true;
  useEffect(() => { seen.current = false; }, [id]);

  // Opening is what reads it, wherever someone came from.
  const read = useRef(0);
  useEffect(() => {
    if (!company?.unread_items || read.current === id) return;
    read.current = id;
    void crmApi.read("company", id).catch(() => { read.current = 0; });
  }, [company?.unread_items, id]);

  const contactId = Number(params.get("contact")) || 0;
  const contact = company?.contacts.find((c) => c.id === contactId);
  const closeContact = () => setParams((p) => { p.delete("contact"); return p; }, { replace: true });
  // From the row, so a delete or a restore shows the moment it's written.
  const trashed = !!company?.deleted_at;
  const editable = !!company && !trashed;
  const back = useCallback(() => navigate(rememberedHref("/crm/companies")), [navigate]);
  const owner = (el?: HTMLElement | null) => { if (company) menu.open({ kind: "owner", company, anchor: el ?? document.querySelector<HTMLElement>('[data-field="owner"]') }); };
  const create = (d: NewDeal) => { setAddingDeal(false); void actions.createDeal(d, []); };
  const commands: Command[] = [
    { id: "list.close", ...CATALOG["list.close"], when: () => !editing && !addingDeal && !addingContact && !contact, run: back },
    { id: "tasks.new", ...CATALOG["tasks.new"], label: "New deal for this company", group: "Company", icon: Plus, when: () => editable && !!setup.data, run: () => setAddingDeal(true) },
    { id: "tasks.assign", ...CATALOG["tasks.assign"], label: "Give this company to someone", group: "Company", when: () => editable, run: () => owner() },
    { id: "tasks.assign-me", ...CATALOG["tasks.assign-me"], label: "Give this company to me", group: "Company", when: () => editable, run: () => company && actions.assignCompany(company, { id: me.id, name: me.name, kind: "human" }) },
    { id: "tasks.edit", ...CATALOG["tasks.edit"], label: "Edit the company", group: "Company", icon: Pencil, when: () => editable, run: () => setEditing(true) },
    { id: "tasks.delete", ...CATALOG["tasks.delete"], label: "Delete the company", group: "Company", icon: Trash2, when: () => editable, run: () => company && void actions.removeCompany(company) },
    { id: "chat.compose", ...CATALOG["chat.compose"], label: "Add a note", group: "Company", when: () => editable, run: () => document.querySelector<HTMLElement>('[data-testid="crm-notes"] [data-testid="composer-input"]')?.focus() },
    { id: "chat.reply", ...CATALOG["chat.reply"], label: "Comment on this company", group: "Company", icon: MessagesSquare, when: () => !!company, run: () => {
      if (mobile) setParams((p) => { p.set("pane", "thread"); return p; }, { replace: true });
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="crm-thread"] [data-testid="composer-input"]')?.focus());
    } },
  ];
  useCommands(commands, "crm-company");

  const stop = <CantOpen allowed={allowed} error={details.error} seen={seen.current} noun="company" back="/crm/companies" hasRow={!!company} onRetry={() => void details.refetch()} />;
  if (!allowed || (details.error && (!company || (details.error as { status?: number }).status === 404))) return stop;
  const noteIsOn = (type: string, recordId: number) => (type === "deal" ? company?.deals.find((d) => d.id === recordId)?.title : type === "contact" ? company?.contacts.find((c) => c.id === recordId)?.name : null) ?? null;

  return (
    <RecordFrame label={company?.name ?? "Company"} testId="company-detail" back="/crm/companies" backLabel="Companies" crumb={company?.industry} room={roomOf("company", id)} pane={pane}
      onPane={(v) => setParams((p) => { if (v === "thread") p.set("pane", "thread"); else { p.delete("pane"); p.delete("seq"); } return p; }, { replace: true })}
      menu={editable && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="More" data-testid="company-more-menu" className="max-md:size-11"><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setEditing(true)}><Pencil />Edit</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => copy(location.href)}><Copy />Copy link</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" data-testid="company-delete" onSelect={() => company && void actions.removeCompany(company)}><Trash2 />Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      main={!company ? <Loading what="company" /> : <>
        {trashed && <Trashed noun="company" onRestore={() => void actions.restoreCompany(company)} />}
        <div className="flex flex-col gap-2">
          <h1 className="text-title text-pretty wrap-anywhere" data-testid="company-title">{company.name}</h1>
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" data-field="owner" disabled={!editable} onClick={(e) => owner(e.currentTarget)} className={FIELD}><span className="sr-only">Owner: </span>{company.owner_name ? <Avatar name={company.owner_name} kind={company.owner_kind} size="xs" decorative /> : <CircleUserRound aria-hidden className="size-3.5 text-muted-foreground" />}<span className="truncate">{company.owner_name ?? "Owner"}</span>{company.owner_kind === "agent" && <AgentMark />}</button>
            {company.domain && <a href={`https://${company.domain}`} target="_blank" rel="noreferrer noopener" className={FIELD}><ExternalLink aria-hidden className="size-3.5 text-muted-foreground" /><span className="truncate">{company.domain}</span></a>}
          </div>
          {company.about && <p className="text-body text-pretty wrap-anywhere text-muted-foreground" data-testid="company-about">{company.about}</p>}
        </div>
        <section aria-label="Deals" data-testid="company-deals" className="flex flex-col gap-1">
          <div className="flex items-center gap-2"><h2 className="text-caption font-medium text-muted-foreground">Deals</h2>{editable && <Button variant="ghost" size="sm" data-testid="company-new-deal" onClick={() => setAddingDeal(true)} className="ml-auto text-muted-foreground max-md:min-h-11"><Plus />New deal</Button>}</div>
          {!company.deals.length && <p className="py-1 text-body text-muted-foreground">No deals with {company.name} yet.</p>}
          <ul className="flex flex-col">
            {company.deals.map((d) => (
              <li key={d.id}><Link to={`/crm/deals/${d.id}`} data-testid="company-deal" className="focus-ring-inset flex min-h-9 min-w-0 items-center gap-3 rounded-sm border-t border-border/60 px-1 py-1 hover:bg-muted/50 max-md:min-h-11">
                <span className="min-w-0 flex-1 truncate text-body">{d.title}</span>
                <StatusBadge tone={d.stage_kind === "won" ? "success" : "neutral"} dot className="shrink-0">{d.stage_name}</StatusBadge>
                <span className="w-20 shrink-0 text-right text-caption tabular-nums">{money(d.value)}</span>
                <span className="w-24 shrink-0 text-right text-caption text-muted-foreground max-sm:hidden"><DueLabel value={d.close_on} done={!!d.closed_at} /></span>
              </Link></li>
            ))}
          </ul>
        </section>
        <section aria-label="Contacts" data-testid="company-contacts" className="flex flex-col gap-1">
          <div className="flex items-center gap-2"><h2 className="text-caption font-medium text-muted-foreground">Contacts</h2>{editable && <Button variant="ghost" size="sm" data-testid="company-new-contact" onClick={() => setAddingContact(true)} className="ml-auto text-muted-foreground max-md:min-h-11"><UserPlus />Add contact</Button>}</div>
          {!company.contacts.length && <p className="py-1 text-body text-muted-foreground">Nobody at {company.name} yet.</p>}
          <ul className="flex flex-col">
            {company.contacts.map((c) => (
              <li key={c.id}><button type="button" disabled={!editable} data-testid="company-contact" onClick={() => setParams((p) => { p.set("contact", String(c.id)); return p; }, { replace: true })} className="focus-ring-inset flex min-h-9 w-full min-w-0 items-center gap-3 rounded-sm border-t border-border/60 px-1 py-1 text-left hover:bg-muted/50 disabled:hover:bg-transparent max-md:min-h-11">
                <span className="min-w-0 truncate text-body">{c.name}</span>
                <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">{c.job_title}</span>
                <span className="truncate text-caption text-muted-foreground max-sm:hidden">{c.email}</span>
              </button></li>
            ))}
          </ul>
        </section>
        <CompanyPanels company={id} panels={company.panels} canLink={editable} />
        <Notes subject={{ type: "company", id }} companyId={id} notes={company.notes} canAdd={editable} detailsKey={key} showWhere={(n) => noteIsOn(n.record_type, n.record_id)} />
      </>}
      thread={<>
        {company && <RecordApprovals type="company" id={id} threadId={company.thread_id} className="mb-3" />}
        {company && <RecordThread record={{ type: "company", id }} threadId={company.thread_id} seq={seq} canStart={editable} />}
        <CrmMenu request={menu.request} close={menu.close} rows={[]} />
        {editing && company && <CompanyDialog company={company} onClose={() => setEditing(false)} />}
        {addingDeal && company && setup.data && <NewDealDialog setup={setup.data} start={{ company: String(id), companyName: company.name }} onCreate={create} onClose={() => setAddingDeal(false)} />}
        {addingContact && <ContactDialog companyId={id} onClose={() => setAddingContact(false)} />}
        {contact && <ContactDialog key={contact.id} companyId={id} contact={contact} onClose={closeContact} />}
      </>} />
  );
}

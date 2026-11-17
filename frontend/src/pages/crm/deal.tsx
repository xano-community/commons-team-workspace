// /crm/deals/:id: one deal, what's been said about it, and its thread beside it, where an agent can be asked to do something.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Building2, CalendarDays, CircleUserRound, Copy, MessagesSquare, MoreHorizontal, Pencil, Trash2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Avatar, DueLabel, rememberedHref } from "@/components/kit";
import { AgentMark } from "@/components/workspace/agent-mark";
import { LinksPanel } from "@/components/workspace/links-panel";
import { useCan } from "@/base/access";
import { roomOf } from "@/base/live";
import { useMe } from "@/base/session";
import { useIsMobile } from "@/hooks/use-mobile";
import { CATALOG, useCommands, type Command } from "@/lib/commands";
import { crmApi } from "@/lib/crm/api";
import { useCrmActions, useDealDetails } from "@/lib/crm/client";
import { money } from "@/lib/crm/model";
import { shellToast } from "@/lib/toast";
import { EditDealDialog } from "./dialogs";
import { CrmMenu, useCrmMenu, type MenuKind } from "./menu";
import { Notes } from "./notes";
import { Attachments } from "@/components/workspace/attachments";
import { CantOpen, FIELD, Loading, RecordFrame, Trashed } from "./record";
import { RecordThread } from "./thread";
import RecordApprovals from "@/components/workspace/approval-card";

const copy = (text: string) => void navigator.clipboard?.writeText(text).then(() => shellToast.show("Copied"), () => shellToast.error("Your browser wouldn't copy that. Select the text instead."));

export function DealPage() {
  const id = Number(useParams().id);
  const me = useMe()!;
  const allowed = useCan("crm.read");
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const [params, setParams] = useSearchParams();
  const seq = Number(params.get("seq")) || null;
  const pane = params.get("pane") === "thread" || (mobile && seq) ? "thread" : "details";
  const details = useDealDetails(id);
  const actions = useCrmActions();
  const menu = useCrmMenu();
  const deal = details.data && details.data.id === id ? details.data : undefined;
  const key = useMemo(() => ["deal", "details", id] as const, [id]);

  const [editing, setEditing] = useState(false);
  const seen = useRef(false);
  if (deal) seen.current = true;
  useEffect(() => { seen.current = false; setEditing(false); }, [id]);

  const read = useRef(0);
  useEffect(() => {
    if (!deal?.unread_items || read.current === id) return;
    read.current = id;
    void crmApi.read("deal", id).catch(() => { read.current = 0; });
  }, [deal?.unread_items, id]);

  // From the row, so a delete or a restore shows the moment it's written.
  const trashed = !!deal?.deleted_at;
  const editable = !!deal && !trashed;
  const back = useCallback(() => navigate(rememberedHref("/crm")), [navigate]);
  const openMenu = (kind: MenuKind) => () => { if (deal) menu.open({ kind, deal, anchor: document.querySelector<HTMLElement>(`[data-field="${kind}"]`) }); };
  const commands: Command[] = [
    { id: "list.close", ...CATALOG["list.close"], when: () => !editing, run: back },
    { id: "tasks.status", ...CATALOG["tasks.status"], label: "Move to a stage", group: "Deal", when: () => editable, run: openMenu("stage") },
    { id: "tasks.assign", ...CATALOG["tasks.assign"], label: "Give this deal to someone", group: "Deal", when: () => editable, run: openMenu("owner") },
    { id: "tasks.assign-me", ...CATALOG["tasks.assign-me"], label: "Give this deal to me", group: "Deal", when: () => editable, run: () => deal && actions.assign(deal, { id: me.id, name: me.name, kind: "human" }) },
    { id: "tasks.due", ...CATALOG["tasks.due"], label: "Set the close date", group: "Deal", when: () => editable, run: openMenu("close") },
    { id: "tasks.edit", ...CATALOG["tasks.edit"], label: "Edit the deal", group: "Deal", icon: Pencil, when: () => editable, run: () => setEditing(true) },
    { id: "tasks.delete", ...CATALOG["tasks.delete"], label: "Delete the deal", group: "Deal", icon: Trash2, when: () => editable, run: () => deal && void actions.removeDeal(deal) },
    { id: "chat.compose", ...CATALOG["chat.compose"], label: "Add a note", group: "Deal", when: () => editable, run: () => document.querySelector<HTMLElement>('[data-testid="crm-notes"] [data-testid="composer-input"]')?.focus() },
    { id: "chat.reply", ...CATALOG["chat.reply"], label: "Comment on this deal", group: "Deal", icon: MessagesSquare, when: () => !!deal, run: () => {
      if (mobile) setParams((p) => { p.set("pane", "thread"); return p; }, { replace: true });
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="crm-thread"] [data-testid="composer-input"]')?.focus());
    } },
  ];
  useCommands(commands, "crm-deal");

  const stop = <CantOpen allowed={allowed} error={details.error} seen={seen.current} noun="deal" back="/crm" hasRow={!!deal} onRetry={() => void details.refetch()} />;
  if (!allowed || (details.error && (!deal || (details.error as { status?: number }).status === 404))) return stop;
  const field = (kind: MenuKind, label: string, children: React.ReactNode) => <button type="button" data-field={kind} disabled={!editable} onClick={openMenu(kind)} className={FIELD}><span className="sr-only">{label}</span>{children}</button>;

  return (
    <RecordFrame label={deal?.title ?? "Deal"} testId="deal-detail" back="/crm" backLabel="Pipeline" crumb={deal?.company_name} room={roomOf("deal", id)} pane={pane}
      onPane={(v) => setParams((p) => { if (v === "thread") p.set("pane", "thread"); else { p.delete("pane"); p.delete("seq"); } return p; }, { replace: true })}
      menu={editable && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="More" data-testid="deal-more-menu" className="max-md:size-11"><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setEditing(true)}><Pencil />Edit</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => copy(location.href)}><Copy />Copy link</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" data-testid="deal-delete" onSelect={() => deal && void actions.removeDeal(deal)}><Trash2 />Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      main={!deal ? <Loading what="deal" /> : <>
        {trashed && <Trashed noun="deal" onRestore={() => void actions.restoreDeal(deal)} />}
        <div className="flex flex-col gap-2">
          <h1 className="text-title text-pretty wrap-anywhere" data-testid="deal-title">{deal.title}</h1>
          <p className="text-heading tabular-nums" data-testid="deal-value">{money(deal.value)}</p>
          <div className="flex flex-wrap items-center gap-1.5" data-testid="deal-fields">
            {field("stage", "Stage: ", <span data-testid="deal-stage" className="truncate">{deal.stage_name}</span>)}
            {field("owner", "Owner: ", <>{deal.owner_name ? <Avatar name={deal.owner_name} kind={deal.owner_kind} size="xs" decorative /> : <CircleUserRound aria-hidden className="size-3.5 text-muted-foreground" />}<span className="truncate">{deal.owner_name ?? "Owner"}</span>{deal.owner_kind === "agent" && <AgentMark />}</>)}
            {field("close", deal.close_on ? "Closes: " : "", deal.close_on ? <DueLabel value={deal.close_on} done={!!deal.closed_at} /> : <><CalendarDays aria-hidden className="size-3.5 text-muted-foreground" /><span className="text-muted-foreground">Close date</span></>)}
            <Link to={`/crm/companies/${deal.company_id}`} data-testid="deal-company" className={FIELD}><Building2 aria-hidden className="size-3.5 text-muted-foreground" /><span className="truncate">{deal.company_name}</span></Link>
            {deal.contact_name && <span className={FIELD}><UserRound aria-hidden className="size-3.5 text-muted-foreground" /><span className="truncate">{deal.contact_name}</span></span>}
          </div>
          {editable && <div className="hidden md:block"><Button variant="ghost" size="sm" onClick={() => setEditing(true)} className="-ml-2 text-muted-foreground"><Pencil />Edit</Button></div>}
        </div>
        <Attachments record={{ type: "deal", id }} />
        <Notes subject={{ type: "deal", id }} companyId={deal.company_id} notes={deal.notes} canAdd={editable} detailsKey={key} />
        <LinksPanel type="deal" id={id} editable={editable} filesShown />
      </>}
      thread={<>
        {deal && <RecordApprovals type="deal" id={id} threadId={deal.thread_id} className="mb-3" />}
        {deal && <RecordThread record={{ type: "deal", id }} threadId={deal.thread_id} seq={seq} canStart={editable} />}
        <CrmMenu request={menu.request} close={menu.close} rows={[]} />
        {editing && deal && <EditDealDialog deal={deal} contacts={deal.contacts} onClose={() => setEditing(false)} />}
      </>} />
  );
}

// The one menu behind a deal's stage, its owner and its close date, and a company's owner: a key, a chip and a field all open it, so
// it opens once per screen. It's a type-ahead list, because a person who knows the word shouldn't have to walk to it.
import { useCallback, useEffect, useState } from "react";
import { CalendarDays, CalendarOff, Check, User, UserMinus } from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Avatar } from "@/components/kit";
import { AgentMark } from "@/components/workspace/agent-mark";
import { useMe } from "@/base/session";
import { useCrmActions, useCrmSetup, type Owner } from "@/lib/crm/client";
import type { CompanyView, DealView } from "@/lib/crm/model";
import { dayAfter } from "@/lib/tasks/model";

export type MenuKind = "stage" | "owner" | "close";
export type MenuRequest = { kind: MenuKind; deal?: DealView; company?: CompanyView; anchor: HTMLElement | null };
const TITLES: Record<MenuKind, string> = { stage: "Move to stage", owner: "Give to", close: "Close date" };
const ROW = "max-sm:min-h-11";

export function useCrmMenu() {
  const [request, setRequest] = useState<MenuRequest | null>(null);
  const open = useCallback((r: MenuRequest) => { if ((r.deal?.id ?? r.company?.id ?? 0) > 0) setRequest(r); }, []);
  return { request, open, close: useCallback(() => setRequest(null), []) };
}

function Owners({ current, pick }: { current: number; pick: (o: Owner) => void }) {
  const me = useMe()!;
  const setup = useCrmSetup();
  const people = setup.data?.people ?? [];
  const self = people.find((p) => p.id === me.id);
  return (
    <>
      <CommandEmpty>{setup.isPending ? "Loading people" : setup.error ? "People didn't load. Close this and try again." : "Nobody matches"}</CommandEmpty>
      <CommandGroup>
        {self && current !== me.id && <CommandItem value="give to me" className={ROW} onSelect={() => pick(self)}><User aria-hidden />Give to me</CommandItem>}
        <CommandItem value="nobody none" className={ROW} onSelect={() => pick(null)} data-testid="owner-nobody"><UserMinus aria-hidden />Nobody</CommandItem>
        {people.map((p) => (
          <CommandItem key={p.id} value={`${p.name} ${p.id}`} className={ROW} data-testid="owner-option" onSelect={() => pick(p)}>
            <Avatar name={p.name} kind={p.kind} size="xs" decorative />
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            {p.kind === "agent" && <AgentMark />}
            {p.id === current && <Check aria-hidden className="size-4" />}
          </CommandItem>
        ))}
      </CommandGroup>
    </>
  );
}

function CloseDate({ deal, done }: { deal: DealView; done: () => void }) {
  const actions = useCrmActions();
  const pick = (day: string) => { void actions.setClose(deal, day); done(); };
  const now = new Date();
  const days: [string, string][] = [["In a week", dayAfter(now, 7)], ["In a month", dayAfter(now, 30)], ["In a quarter", dayAfter(now, 90)]];
  return (
    <>
      <CommandEmpty>Pick a day below</CommandEmpty>
      <CommandGroup>
        {days.map(([label, day]) => <CommandItem key={label} value={label} className={ROW} onSelect={() => pick(day)}><CalendarDays aria-hidden /><span className="flex-1">{label}</span><span className="text-caption text-muted-foreground tabular-nums">{day}</span></CommandItem>)}
        {deal.close_on && <CommandItem value="no close date clear" className={ROW} onSelect={() => pick("")}><CalendarOff aria-hidden />No close date</CommandItem>}
      </CommandGroup>
      <label className="flex items-center gap-2 border-t p-2 text-caption text-muted-foreground">
        Another day
        <input type="date" data-testid="close-input" defaultValue={deal.close_on ?? ""} className="focus-ring h-8 min-w-0 flex-1 rounded-sm border bg-background px-2 text-body text-foreground max-sm:h-11"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (e.currentTarget.value) pick(e.currentTarget.value); } }}
          onBlur={(e) => { if (e.currentTarget.value && e.currentTarget.value !== (deal.close_on ?? "")) pick(e.currentTarget.value); }} />
      </label>
    </>
  );
}

export function CrmMenu({ request, close, rows }: { request: MenuRequest | null; close: () => void; rows: DealView[] }) {
  const actions = useCrmActions();
  const setup = useCrmSetup(!!request);
  const [anchor, setAnchor] = useState<{ current: HTMLElement | null }>({ current: null });
  useEffect(() => { if (request) setAnchor({ current: request.anchor }); }, [request]);
  if (!request) return null;
  const { kind, deal, company } = request;
  return (
    <Popover open onOpenChange={(open) => { if (!open) close(); }}>
      <PopoverAnchor virtualRef={anchor as { current: HTMLElement }} />
      <PopoverContent align="start" className="w-72 max-w-[calc(100vw-1rem)] p-0 !animate-none" data-testid="crm-menu" aria-label={TITLES[kind]} onCloseAutoFocus={(e) => { e.preventDefault(); request.anchor?.focus(); }}>
        <Command defaultValue={kind === "stage" ? deal?.stage_name ?? undefined : undefined}>
          <CommandInput placeholder={`${TITLES[kind]}…`} autoFocus />
          <CommandList className="max-h-72">
            {kind === "stage" && deal && (
              <><CommandEmpty>{setup.error ? "Stages didn't load. Close this and try again." : "No stage matches"}</CommandEmpty><CommandGroup>{(setup.data?.stages ?? []).map((s) => (
                <CommandItem key={s.id} value={s.name} className={ROW} data-testid="stage-option" onSelect={() => { void actions.setStage(deal, s, rows); close(); }}><span className="flex-1">{s.name}</span>{s.id === deal.stage_id && <Check aria-hidden className="size-4" />}</CommandItem>
              ))}</CommandGroup></>
            )}
            {kind === "owner" && <Owners current={deal?.owner_id ?? company?.owner_id ?? 0} pick={(o) => { if (deal) actions.assign(deal, o); else if (company) actions.assignCompany(company, o); close(); }} />}
            {kind === "close" && deal && <CloseDate deal={deal} done={close} />}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

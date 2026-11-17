// Starting and changing records. A refused save stays in its dialog, with the words as they were typed.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Plus, Trash2 } from "lucide-react";
import { AgentMark } from "@/components/workspace/agent-mark";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useQueryClient } from "@tanstack/react-query";
import { crmApi } from "@/lib/crm/api";
import { useCompanies, useContactActions, useCrmActions, type ContactFields, type NewDeal, type Owner } from "@/lib/crm/client";
import type { CompanyView, CrmSetup, DealView, Stage } from "@/lib/crm/model";
import { cn } from "@/lib/utils";

const FIELD = "grid min-w-0 grid-cols-1 gap-1.5";
const NOBODY = "0";
const LABEL = "text-caption text-muted-foreground";
const reason = (e: unknown) => (e instanceof Error ? e.message : "That didn't work. Try again.");

function Modal({ title, about, testId, onClose, onSubmit, submit, busy, problem, children, extra }: {
  title: string; about: string; testId: string; onClose: () => void; onSubmit: () => void; submit: string; busy?: boolean; problem: string; children: ReactNode; extra?: ReactNode;
}) {
  const send = (e: FormEvent) => { e.preventDefault(); onSubmit(); };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg !animate-none" data-testid={testId} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit(); }}>
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription className="sr-only">{about}</DialogDescription></DialogHeader>
        <form onSubmit={send} className="grid min-w-0 gap-3">
          {children}
          {problem && <p role="alert" data-testid="crm-dialog-problem" className="text-caption text-destructive">{problem}</p>}
          <DialogFooter className="items-center">
            {extra}
            <Button type="button" variant="ghost" size="sm" onClick={onClose} className="max-sm:min-h-11">Cancel</Button>
            <Button type="submit" size="sm" disabled={busy} data-testid={`${testId}-save`} className="max-sm:min-h-11">{submit}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const Text = ({ id, label, value, onChange, ...rest }: { id: string; label: string; value: string; onChange: (v: string) => void } & Omit<React.ComponentProps<typeof Input>, "onChange" | "value" | "id">) => (
  <div className={FIELD}><Label htmlFor={id} className={LABEL}>{label}</Label><Input id={id} value={value} onChange={(e) => onChange(e.target.value)} className="max-sm:h-11" {...rest} /></div>
);

export function CompanyDialog({ company, onClose, onMade }: { company?: CompanyView; onClose: () => void; onMade?: (made: CompanyView) => void }) {
  const actions = useCrmActions();
  const client = useQueryClient();
  const [d, setD] = useState({ name: company?.name ?? "", domain: company?.domain ?? "", industry: company?.industry ?? "", about: company?.about ?? "" });
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof d>) => { setD((was) => ({ ...was, ...patch })); setProblem(""); };
  const submit = async () => {
    const fields = { name: d.name.trim(), domain: d.domain.trim(), industry: d.industry.trim(), about: d.about.trim() };
    if (!fields.name) { setProblem("Name the company."); return; }
    if (company) { onClose(); void actions.updateCompany(company, fields); return; }
    setBusy(true);
    try {
      const made = await crmApi.createCompany({ client_id: crypto.randomUUID(), ...fields });
      await client.invalidateQueries({ queryKey: ["company"] });
      onMade?.(made);
    } catch (e) { setProblem(reason(e)); setBusy(false); }
  };
  return (
    <Modal title={company ? "Edit company" : "New company"} about="A company's name and details." testId="company-dialog" submit={company ? "Save" : "Add company"} busy={busy} problem={problem} onClose={onClose} onSubmit={() => void submit()}>
      <Text id="company-name" label="Name" autoFocus maxLength={120} value={d.name} onChange={(name) => set({ name })} aria-invalid={!!problem} data-testid="company-name" />
      <div className="grid min-w-0 grid-cols-2 gap-3">
        <Text id="company-domain" label="Website" maxLength={200} placeholder="marlow.example" value={d.domain} onChange={(domain) => set({ domain })} />
        <Text id="company-industry" label="Industry" maxLength={120} value={d.industry} onChange={(industry) => set({ industry })} />
      </div>
      <div className={FIELD}><Label htmlFor="company-about" className={LABEL}>About</Label><Textarea id="company-about" rows={3} maxLength={4000} value={d.about} onChange={(e) => set({ about: e.target.value })} /></div>
    </Modal>
  );
}

export function ContactDialog({ companyId, contact, onClose }: { companyId: number; contact?: ContactFields & { id: number }; onClose: () => void }) {
  const actions = useContactActions();
  const [d, setD] = useState<ContactFields>({ name: contact?.name ?? "", email: contact?.email ?? "", phone: contact?.phone ?? "", job_title: contact?.job_title ?? "" });
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<ContactFields>) => { setD((was) => ({ ...was, ...patch })); setProblem(""); };
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try { await work(); onClose(); } catch (e) { setProblem(reason(e)); setBusy(false); }
  };
  const submit = () => {
    const fields = { name: d.name.trim(), email: d.email.trim(), phone: d.phone.trim(), job_title: d.job_title.trim() };
    if (!fields.name) { setProblem("Name the contact."); return; }
    void run(() => (contact ? actions.update(contact.id, fields) : actions.create(companyId, fields)));
  };
  return (
    <Modal title={contact ? "Edit contact" : "New contact"} about="A person at this company." testId="contact-dialog" submit={contact ? "Save" : "Add contact"} busy={busy} problem={problem} onClose={onClose} onSubmit={submit}
      extra={contact ? <Button type="button" variant="ghost" size="sm" data-testid="contact-delete" className="mr-auto text-muted-foreground max-sm:min-h-11" onClick={() => void run(() => actions.remove(contact.id, contact.name))}><Trash2 />Delete</Button> : undefined}>
      <Text id="contact-name" label="Name" autoFocus maxLength={120} value={d.name} onChange={(name) => set({ name })} aria-invalid={!!problem} data-testid="contact-name" />
      <Text id="contact-title" label="Job title" maxLength={120} value={d.job_title} onChange={(job_title) => set({ job_title })} />
      <div className="grid min-w-0 grid-cols-2 gap-3">
        <Text id="contact-email" label="Email" type="email" maxLength={200} value={d.email} onChange={(email) => set({ email })} data-testid="contact-email" />
        <Text id="contact-phone" label="Phone" type="tel" maxLength={40} value={d.phone} onChange={(phone) => set({ phone })} />
      </div>
    </Modal>
  );
}

/** Unsent words stay with the dialog: a refused deal comes back here, as it was. */
export type DealDraft = { title: string; company: string; companyName: string; stage: string; value: string; close: string; owner: string };

/** A company by name, from the server, so a long customer list costs what a short one does. */
function CompanyPicker({ value, name, onPick }: { value: string; name: string; onPick: (id: string, name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const found = useCompanies({ q: q.trim() || undefined }, open);
  const first = String(found.data?.items[0]?.id ?? "");
  const [active, setActive] = useState("");
  // A list the server filters loses its highlight each time it changes, and Enter should still take the best match.
  useEffect(() => setActive(first), [first]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" role="combobox" aria-expanded={open} aria-label="Company" data-testid="deal-company" className="w-full min-w-0 justify-between font-normal max-sm:min-h-11">
          <span className={cn("truncate", !value && "text-muted-foreground")}>{name || "Choose"}</span><ChevronDown aria-hidden className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 max-w-[calc(100vw-1rem)] p-0 !animate-none" aria-label="Choose a company">
        <Command shouldFilter={false} value={active} onValueChange={setActive}>
          <CommandInput placeholder="Find a company…" value={q} onValueChange={setQ} data-testid="deal-company-search" />
          <CommandList className="max-h-56">
            <CommandEmpty>{found.isFetching ? "Looking" : found.error ? "Companies didn't load. Close this and try again." : "No company matches"}</CommandEmpty>
            <CommandGroup>{(found.data?.items ?? []).map((c) => <CommandItem key={c.id} value={String(c.id)} className="max-sm:min-h-11" data-testid="deal-company-option" onSelect={() => { onPick(String(c.id), c.name); setOpen(false); }}><span className="truncate">{c.name}</span></CommandItem>)}</CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function NewDealDialog({ setup, start, onCreate, onClose }: { setup: CrmSetup; start: Partial<DealDraft>; onCreate: (d: NewDeal, draft: DealDraft) => void; onClose: () => void }) {
  const firstOpen = setup.stages.find((s) => s.kind === "open") ?? setup.stages[0];
  const [d, setD] = useState<DealDraft>({ title: "", company: "", companyName: "", stage: String(firstOpen?.id ?? ""), value: "", close: "", owner: NOBODY, ...start });
  const [problem, setProblem] = useState("");
  const set = (patch: Partial<DealDraft>) => { setD((was) => ({ ...was, ...patch })); setProblem(""); };
  const submit = () => {
    const title = d.title.trim();
    const stage = setup.stages.find((s) => String(s.id) === d.stage);
    const value = Number(d.value || 0);
    if (!title) { setProblem("Give the deal a title."); return; }
    if (!d.company) { setProblem("Choose a company."); return; }
    if (!stage) { setProblem("Choose a stage."); return; }
    if (!Number.isInteger(value) || value < 0) { setProblem("Enter the value as a whole number."); return; }
    const owner: Owner = setup.people.find((p) => String(p.id) === d.owner) ?? null;
    onCreate({ company_id: Number(d.company), company_name: d.companyName, title, stage, value, close_on: d.close, owner, contact_id: 0 }, d);
  };
  return (
    <Modal title="New deal" about="Add a deal to a company." testId="deal-dialog" submit="Add deal" problem={problem} onClose={onClose} onSubmit={submit}>
      <Text id="deal-title" label="Title" autoFocus maxLength={200} placeholder="What's being sold?" value={d.title} onChange={(title) => set({ title })} aria-invalid={!!problem} data-testid="deal-title" />
      <div className="grid min-w-0 grid-cols-2 gap-3">
        <div className={FIELD}>
          <Label className={LABEL}>Company</Label>
          <CompanyPicker value={d.company} name={d.companyName} onPick={(company, companyName) => set({ company, companyName })} />
        </div>
        <div className={FIELD}>
          <Label className={LABEL}>Stage</Label>
          <Select value={d.stage} onValueChange={(stage) => set({ stage })}>
            <SelectTrigger size="sm" aria-label="Stage" className="w-full max-sm:min-h-11"><SelectValue /></SelectTrigger>
            <SelectContent>{setup.stages.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <Text id="deal-value" label="Value" inputMode="numeric" placeholder="0" value={d.value} onChange={(value) => set({ value: value.replace(/[^\d]/g, "") })} data-testid="deal-value" />
        <Text id="deal-close" label="Close date" type="date" value={d.close} onChange={(close) => set({ close })} />
        <div className={FIELD}>
          <Label className={LABEL}>Owner</Label>
          <Select value={d.owner} onValueChange={(owner) => set({ owner })}>
            <SelectTrigger size="sm" aria-label="Owner" className="w-full max-sm:min-h-11"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={NOBODY}>Nobody</SelectItem>{setup.people.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}{p.kind === "agent" && <AgentMark />}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>
    </Modal>
  );
}

export function EditDealDialog({ deal, contacts, onClose }: { deal: DealView; contacts: { id: number; name: string }[]; onClose: () => void }) {
  const actions = useCrmActions();
  const [d, setD] = useState({ title: deal.title, value: String(deal.value), close: deal.close_on ?? "", contact: String(deal.contact_id || 0) });
  const [problem, setProblem] = useState("");
  const set = (patch: Partial<typeof d>) => { setD((was) => ({ ...was, ...patch })); setProblem(""); };
  const submit = () => {
    const title = d.title.trim();
    if (!title) { setProblem("Give the deal a title."); return; }
    onClose();
    void actions.update(deal, { title, value: Number(d.value || 0), close_on: d.close, contact_id: Number(d.contact) });
  };
  return (
    <Modal title="Edit deal" about="A deal's title, value, close date and who it's with." testId="edit-deal-dialog" submit="Save" problem={problem} onClose={onClose} onSubmit={submit}>
      <Text id="edit-deal-title" label="Title" autoFocus maxLength={200} value={d.title} onChange={(title) => set({ title })} aria-invalid={!!problem} data-testid="edit-deal-title" />
      <div className="grid min-w-0 grid-cols-2 gap-3">
        <Text id="edit-deal-value" label="Value" inputMode="numeric" value={d.value} onChange={(value) => set({ value: value.replace(/[^\d]/g, "") })} data-testid="edit-deal-value" />
        <Text id="edit-deal-close" label="Close date" type="date" value={d.close} onChange={(close) => set({ close })} />
      </div>
      <div className={FIELD}>
        <Label className={LABEL}>Who it's with</Label>
        <Select value={d.contact} onValueChange={(contact) => set({ contact })}>
          <SelectTrigger size="sm" aria-label="Who it's with" className="w-full max-sm:min-h-11"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="0">Nobody in particular</SelectItem>{contacts.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>
    </Modal>
  );
}

/** The pipeline's stages, for admins. Won and Lost close a deal, so they stay, and a stage holding deals says to move them first. */
export function StagesDialog({ stages, onClose }: { stages: Stage[]; onClose: () => void }) {
  const client = useQueryClient();
  const [names, setNames] = useState<Record<number, string>>({});
  const [fresh, setFresh] = useState("");
  const [problem, setProblem] = useState("");
  const order = useMemo(() => [...stages].sort((a, b) => a.rank - b.rank || a.id - b.id), [stages]);
  useEffect(() => setNames(Object.fromEntries(stages.map((s) => [s.id, s.name]))), [stages]);
  const run = async (work: () => Promise<unknown>) => {
    setProblem("");
    try {
      await work();
      await Promise.all([client.invalidateQueries({ queryKey: ["pipeline_stage"] }), client.invalidateQueries({ queryKey: ["deal"] })]);
    } catch (e) { setProblem(reason(e)); }
  };
  const rename = (s: Stage) => { const name = (names[s.id] ?? "").trim(); if (name && name !== s.name) void run(() => crmApi.renameStage(s.id, name)); else setNames((n) => ({ ...n, [s.id]: s.name })); };
  const nudge = (at: number, by: 1 | -1) => {
    const stage = order[at];
    const before = by < 0 ? order[at - 1] : order[at + 2];
    void run(() => crmApi.moveStage(stage.id, before?.id ?? 0));
  };
  const add = () => { const name = fresh.trim(); if (!name) return; setFresh(""); void run(() => crmApi.createStage(name)); };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md !animate-none" data-testid="stages-dialog">
        <DialogHeader><DialogTitle>Pipeline stages</DialogTitle><DialogDescription className="text-caption">Everyone shares these. Won and Lost close a deal, so they stay.</DialogDescription></DialogHeader>
        <ul className="grid min-w-0 gap-1.5">
          {order.map((s, i) => (
            <li key={s.id} className="flex min-w-0 items-center gap-1" data-testid="stage-row">
              <Input aria-label={`Name of ${s.name}`} maxLength={40} value={names[s.id] ?? s.name} className="h-8 min-w-0 flex-1 max-sm:h-11" onChange={(e) => setNames((n) => ({ ...n, [s.id]: e.target.value }))} onBlur={() => rename(s)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); rename(s); } }} />
              <Button variant="ghost" size="icon-sm" aria-label={`Move ${s.name} up`} disabled={i === 0} onClick={() => nudge(i, -1)} className="max-sm:size-11"><ArrowUp /></Button>
              <Button variant="ghost" size="icon-sm" aria-label={`Move ${s.name} down`} disabled={i === order.length - 1} onClick={() => nudge(i, 1)} className="max-sm:size-11"><ArrowDown /></Button>
              <Button variant="ghost" size="icon-sm" aria-label={`Delete ${s.name}`} disabled={s.kind !== "open"} data-testid="stage-delete" onClick={() => void run(() => crmApi.deleteStage(s.id))} className="max-sm:size-11"><Trash2 /></Button>
            </li>
          ))}
        </ul>
        <form className="flex min-w-0 items-center gap-1" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <Input aria-label="New stage" placeholder="Add a stage" maxLength={40} value={fresh} data-testid="stage-new" onChange={(e) => setFresh(e.target.value)} className="h-8 min-w-0 flex-1 max-sm:h-11" />
          <Button type="submit" variant="outline" size="sm" className="max-sm:min-h-11"><Plus />Add</Button>
        </form>
        {problem && <p role="alert" data-testid="stages-problem" className="text-caption text-destructive">{problem}</p>}
      </DialogContent>
    </Dialog>
  );
}

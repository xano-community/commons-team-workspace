import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CircleCheck, File, FileText, Hash, Link2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/kit";
import { api, type RecordLinks } from "@/lib/api";
import { tasksApi, type TaskView } from "@/lib/tasks/api";
import { useConversations } from "@/lib/chat/client";
import { crmApi } from "@/lib/crm/api";
import type { CrmHit } from "@/lib/crm/model";
import { CRM_ICONS } from "@/lib/crm/palette";
import { docsApi } from "@/lib/docs/api";
import { filesApi } from "@/lib/files/api";
import type { FileHit } from "@/lib/files/model";
import { useEntityQuery } from "@/lib/data";
import type { RecordView } from "@/lib/links/resolver";
import { shellToast } from "@/lib/toast";
import { LinkRow } from "./link-chip";
import { shownBacklinks } from "@/lib/links/panel";

type Linked = RecordView & { link_id?: number };

type Doc = { id: number; title: string };

/**
 * Finds something to link to, as the person types: a task, a doc, a channel or a customer. With `into`, what's found links to this
 * record rather than the other way: a link's source knows where it lives, which is what lets a company's panels filter it.
 */
export function AddLink({ from, into = false, only, label = "Add a link" }: { from: { type: string; id: number }; into?: boolean; only?: "task" | "doc" | "conversation" | "file"; label?: string }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [customers, setCustomers] = useState<CrmHit[]>([]);
  const [files, setFiles] = useState<FileHit[]>([]);
  const channels = (useConversations().data ?? []).filter((c) => c.kind === "channel" && (!only || only === "conversation"));
  useEffect(() => {
    if (q.trim().length < 2) { setTasks([]); setDocs([]); setCustomers([]); setFiles([]); return; }
    let current = true;
    const words = q.trim();
    const t = setTimeout(() => {
      if (!only || only === "task") void tasksApi.searchTasks(words).then((rows) => { if (current) setTasks(rows); }, () => {});
      if (!only || only === "doc") void docsApi.search(words).then((rows) => { if (current) setDocs(rows); }, () => {});
      if (!only) void crmApi.search(words).then((rows) => { if (current) setCustomers(rows); }, () => {});
      if (!only || only === "file") void filesApi.search(words).then((rows) => { if (current) setFiles(rows); }, () => {});
    }, 150);
    return () => { current = false; clearTimeout(t); };
  }, [q, only]);
  const link = async (type: string, id: number, name: string) => {
    setOpen(false);
    setQ("");
    try {
      if (into) await tasksApi.addLink(type, id, from.type, from.id);
      else await tasksApi.addLink(from.type, from.id, type, id);
      await Promise.all([client.invalidateQueries({ queryKey: ["record_link"] }), client.invalidateQueries({ queryKey: [from.type] })]);
    } catch (e) { shellToast.error(`Couldn't link ${name}. ${e instanceof Error ? e.message : "Try again."}`); }
  };
  const matching = channels.filter((c) => q.trim() && c.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 6);
  const shownCustomers = customers.filter((h) => !(h.type === from.type && h.id === from.id));
  const shownTasks = tasks.filter((t) => !(from.type === "task" && t.id === from.id));
  const shownFiles = files.filter((f) => !(from.type === "file" && f.id === from.id));
  // A list the server filters loses its highlight each time it changes, and Enter should still take the best match.
  const first = shownTasks[0] ? `t${shownTasks[0].id}` : docs[0] ? `d${docs[0].id}` : matching[0] ? `c${matching[0].id}` : shownCustomers[0] ? `${shownCustomers[0].type}${shownCustomers[0].id}` : shownFiles[0] ? `f${shownFiles[0].id}` : "";
  const [active, setActive] = useState("");
  useEffect(() => setActive(first), [first]);
  const looking = only === "task" ? "a task" : only === "doc" ? "a doc" : only === "conversation" ? "a channel" : only === "file" ? "a file" : "a task, a doc, a channel, a customer or a file";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button variant="ghost" size="sm" data-testid="add-link" className="-ml-2 self-start text-muted-foreground max-md:min-h-11"><Link2 />{label}</Button></PopoverTrigger>
      <PopoverContent align="start" className="w-72 max-w-[calc(100vw-1rem)] p-0 !animate-none" aria-label="Add a link">
        <Command shouldFilter={false} value={active} onValueChange={setActive}>
          <CommandInput placeholder={`Find ${looking}…`} value={q} onValueChange={setQ} data-testid="add-link-search" />
          <CommandList className="max-h-64">
            <CommandEmpty>{q.trim().length < 2 ? `Type to find ${looking}` : "Nothing matches"}</CommandEmpty>
            <CommandGroup>
              {shownTasks.map((t) => <CommandItem key={`t${t.id}`} value={`t${t.id}`} className="max-sm:min-h-11" data-testid="add-link-option" onSelect={() => void link("task", t.id, t.title)}><CircleCheck aria-hidden /><span className="truncate">{t.title}</span></CommandItem>)}
              {docs.map((d) => <CommandItem key={`d${d.id}`} value={`d${d.id}`} className="max-sm:min-h-11" data-testid="add-link-option" onSelect={() => void link("doc", d.id, d.title)}><FileText aria-hidden /><span className="truncate">{d.title}</span></CommandItem>)}
              {matching.map((c) => <CommandItem key={`c${c.id}`} value={`c${c.id}`} className="max-sm:min-h-11" data-testid="add-link-option" onSelect={() => void link("conversation", c.id, c.name)}><Hash aria-hidden /><span className="truncate">{c.name}</span></CommandItem>)}
              {shownCustomers.map((h) => { const Icon = CRM_ICONS[h.type]; return <CommandItem key={`${h.type}${h.id}`} value={`${h.type}${h.id}`} className="max-sm:min-h-11" data-testid="add-link-option" onSelect={() => void link(h.type, h.id, h.title)}><Icon aria-hidden /><span className="truncate">{h.title}</span>{h.hint && <span className="ml-auto truncate text-caption text-muted-foreground">{h.hint}</span>}</CommandItem>; })}
              {shownFiles.map((f) => <CommandItem key={`f${f.id}`} value={`f${f.id}`} className="max-sm:min-h-11" data-testid="add-link-option" onSelect={() => void link("file", f.id, f.name)}><File aria-hidden /><span className="truncate">{f.name}</span></CommandItem>)}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Both sides of a record's links. What it links to always shows, locked when out of reach. What links to it is left out
 * when out of reach, and the server counts after filtering, so a number can't give it away. Says nothing when there's nothing,
 * unless `editable`: then the way to add one is there, and each link can be taken away.
 */
export function LinksPanel({ type, id, editable = false, filesShown = false, load = api.links, labels = { forward: "Links to", back: "Linked from" } }: {
  type: string; id: number; editable?: boolean;
  /** The record lists its files in their own section, so they aren't repeated here. */
  filesShown?: boolean;
  load?: (type: string, id: number, page?: number) => Promise<RecordLinks>;
  /** What each side is called here: a file is attached to what it links to. */
  labels?: { forward: string; back: string };
}) {
  const [page, setPage] = useState(1);
  const client = useQueryClient();
  const links = useEntityQuery("record_link", [type, id, page], () => load(type, id, page));
  if (links.error) return <LoadError error={links.error} onRetry={() => void links.refetch()} />;
  if (!links.data) return <Skeleton className="h-5 w-40" />;
  const { forward, next_page } = links.data;
  const { views: backlinks, total: backlinks_total } = shownBacklinks(links.data.backlinks, links.data.backlinks_total, filesShown);
  const unlink = async (v: Linked) => {
    try {
      await tasksApi.removeLink(v.link_id!);
      await client.invalidateQueries({ queryKey: ["record_link"] });
    } catch (e) { shellToast.error(`Couldn't remove that link. ${e instanceof Error ? e.message : "Try again."}`); }
  };
  if (!forward.length && !backlinks.length && !editable) return null;
  return (
    <section aria-label="Links" className="flex flex-col gap-3 border-t pt-4" data-testid="links-panel">
      {forward.length > 0 && <Group label={labels.forward} count={forward.length} views={forward} onRemove={editable ? unlink : undefined} />}
      {backlinks.length > 0 && <Group label={labels.back} count={backlinks_total} views={backlinks} onRemove={editable ? unlink : undefined} />}
      {next_page !== null && <div><Button variant="ghost" size="sm" onClick={() => setPage(next_page)}>Show more</Button></div>}
      {editable && <AddLink from={{ type, id }} />}
    </section>
  );
}

function Group({ label, count, views, onRemove }: { label: string; count: number; views: Linked[]; onRemove?: (v: Linked) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-caption text-muted-foreground">{label} <span className="tabular-nums">{count}</span></h3>
      <ul className="-mx-2 flex flex-col">
        {views.map((v) => (
          <li key={`${v.type}-${v.id}`} className="group/link flex min-w-0 items-center gap-0.5">
            <LinkRow view={v} />
            {onRemove && !!v.link_id && <button type="button" aria-label="Remove this link" data-testid="remove-link" onClick={() => onRemove(v)} className="focus-ring grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-60 transition-opacity group-hover/link:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 max-md:size-11 max-md:opacity-100"><X className="size-3.5" /></button>}
          </li>
        ))}
      </ul>
    </div>
  );
}

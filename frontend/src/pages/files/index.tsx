// /files: every file this person reaches, newest first, narrowed by the space chosen in the sidebar, with no folders to file things in.
// Every way the page can be empty says which way it is. A drop or a paste anywhere on it is an upload.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Archive, Download, Files, Layers, Lock, RotateCcw, SearchX, Trash2, Upload as UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Ago, DataList, EmptyState, FilterSelect, KeyHint, LoadError, SearchInput, Segmented, useUrlState, type Column } from "@/components/kit";
import { Person } from "@/components/workspace/person";
import { FileThumb, download } from "@/components/workspace/file-tile";
import { AttachedTo } from "@/components/workspace/link-chip";
import { DropArea, LimitHint, UploadRows, pastedFiles, usePicker } from "@/components/workspace/uploader";
import { useCan } from "@/base/access";
import { useChannel } from "@/base/live";
import { PresenceAvatars } from "@/base/presence";
import { isGuest, useMe } from "@/base/session";
import { CATALOG, useCommands, type Command } from "@/lib/commands";
import { useSpaceScope } from "@/lib/data";
import { filesApi } from "@/lib/files/api";
import { useFiles, useUploads } from "@/lib/files/client";
import { groupedBy } from "@/lib/docs/model";
import { DATE_FILTERS, KIND_FILTERS, filtersFromQuery, listState, shownSize, sinceOf, typeOf, whereOf, type FileView } from "@/lib/files/model";
import { useTaskSetup } from "@/lib/tasks/client";
import { shellToast } from "@/lib/toast";

const DEFAULTS = { q: "", kind: "", date: "", view: "files" };
const Wrap = ({ id, children }: { id: string; children: React.ReactNode }) => <div data-testid={id} className="flex min-h-0 flex-1 items-center justify-center p-4">{children}</div>;

const By = ({ file }: { file: FileView }) => <Person name={file.uploader_name ?? "Someone"} kind={file.uploader_kind} />;

export function FilesPage() {
  const me = useMe()!;
  const space = useSpaceScope();
  const [url, setUrl] = useUrlState(DEFAULTS);
  const filters = filtersFromQuery(url);
  const trash = url.view === "trash";
  const [page, setPage] = useState(1);
  // Rounded to the hour, so a filter's query stays the same query from one render to the next.
  const since = sinceOf(filters.date, Math.floor(Date.now() / 3_600_000) * 3_600_000);
  const list = useFiles({ ...(space ? { space_id: space } : {}), ...(filters.q ? { q: filters.q } : {}), ...(filters.kind && !trash ? { kind: filters.kind } : {}), ...(since && !trash ? { since } : {}), ...(trash ? { trash: true } : {}), page });
  const setup = useTaskSetup();
  useChannel(space ? `spaces/${space}` : null);
  useChannel(useCan("crm.read") ? "crm" : null);
  useEffect(() => setPage(1), [space, url.q, url.kind, url.date, url.view]);

  const spaces = setup.data?.spaces ?? [];
  const writable = spaces.filter((s) => s.can_create && (!space || s.id === space));
  const here = spaces.find((s) => s.id === space);
  const rows = list.data?.items ?? [];
  const failed = list.error ?? setup.error;
  const filtered = !!filters.q || (!trash && (!!filters.kind || !!filters.date));
  const state = listState({ loaded: !!list.data && !!setup.data, error: failed, denied: !!list.data?.denied, spaces: spaces.length, ever: list.data?.ever ?? 0, shown: rows.length, filtered, trash });

  // Where a new file goes: the chosen space, the only one, or wherever the person says.
  const [target, setTarget] = useState<number | null>(null);
  const home = space ?? (writable.length === 1 ? writable[0].id : target);
  const { set, list: uploads } = useUploads(home ? { type: "space", id: home } : null);
  const held = useRef<File[]>([]);
  const [choosing, setChoosing] = useState(false);
  const canAdd = writable.length > 0;
  const certain = !!space || writable.length === 1;
  const take = (files: File[]) => {
    if (!files.length) return;
    if (!canAdd) { shellToast.error(here ? "You can't add files to this space." : "Join a space to add files."); return; }
    if (set && certain) { set.add(files); return; }
    held.current = files;
    setChoosing(true);
  };
  useEffect(() => { if (set && held.current.length) { set.add(held.current); held.current = []; } }, [set]);
  const picker = usePicker(take);

  // Paste belongs to whatever's being typed in. Anywhere else on this screen, it's a file.
  const taking = useRef(take);
  taking.current = take;
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable=true]");
      const files = pastedFiles(e);
      if (typing || !files.length) return;
      e.preventDefault();
      taking.current(files);
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  }, []);

  const upload = () => { if (certain) picker.open(); else if (canAdd) setChoosing(true); };
  const search = useRef<HTMLDivElement>(null);
  // "n" means new on every screen, so a new file takes the same row of the table.
  const outsideList = () => !document.activeElement?.closest('[data-kit="data-list"]') && state === "ready";
  const toList = () => document.querySelector<HTMLElement>('[data-kit="data-list"] tr[tabindex="0"]')?.focus();
  const commands: Command[] = [
    { id: "list.next", ...CATALOG["list.next"], group: "Files", when: outsideList, run: toList },
    { id: "list.previous", ...CATALOG["list.previous"], group: "Files", when: outsideList, run: toList },
    { id: "tasks.new", ...CATALOG["tasks.new"], label: "Upload a file", group: "Files", icon: UploadIcon, when: () => canAdd && !trash, run: upload },
    { id: "list.search", ...CATALOG["list.search"], group: "Files", run: () => search.current?.querySelector("input")?.focus() },
  ];
  useCommands(commands, "files");

  const restore = async (f: FileView) => {
    try {
      await filesApi.restore(f.id);
      shellToast.show(`Brought back ${f.name}`);
      void list.refetch();
    } catch (e) { shellToast.error(`Couldn't bring that back. ${e instanceof Error ? e.message : "Try again."}`); }
  };

  // Everything in reach, grouped by where it lives, newest place first. A search, a filter or the trash stays one list.
  const grouped = !space && !trash && !url.q && !url.kind && !url.date;
  const shownRows = useMemo(() => (grouped ? groupedBy(rows, whereOf) : rows), [grouped, rows]);
  const columns = useMemo<Column<FileView>[]>(() => [
    { id: "name", header: "Name", primary: true, title: (f) => f.name, cell: (f) => <span className="flex min-w-0 items-center gap-2.5"><FileThumb file={f} className="size-7" /><span className="truncate font-medium">{f.name}</span></span> },
    ...(space || grouped ? [] : [{ id: "where", header: "Where", className: "w-44", cell: (f: FileView) => <span className="truncate text-muted-foreground">{whereOf(f)}</span> }]),
    ...(trash ? [] : [{ id: "attached", header: "Attached to", className: "w-64", cell: (f: FileView) => (f.attached ? <AttachedTo {...f.attached} /> : <span className="text-muted-foreground" aria-label="Not attached to anything">—</span>) }]),
    { id: "by", header: "Added by", className: "w-40", hideBelow: "2xl" as const, cell: (f) => <span className="text-muted-foreground"><By file={f} /></span> },
    { id: "type", header: "Type", className: "w-28", hideBelow: "xl" as const, cell: (f) => <span className="truncate text-muted-foreground">{typeOf(f)}</span> },
    { id: "size", header: "Size", className: "w-20", align: "right" as const, cell: (f) => <span className="text-muted-foreground tabular-nums">{shownSize(f.size)}</span> },
    { id: "date", header: trash ? "Deleted" : "Added", className: "w-32", cell: (f) => <span className="truncate text-muted-foreground"><Ago value={trash ? f.deleted_at : f.created_at} /></span> },
  ], [space, trash, grouped]);
  const mobileRow = (f: FileView) => (
    <span className="flex min-w-0 items-center gap-3">
      <FileThumb file={f} className="size-10" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body font-medium">{f.name}</span>
        <span className="flex min-w-0 items-center gap-1 text-caption text-muted-foreground">{!grouped && <><span className="truncate">{whereOf(f)}</span><span aria-hidden>·</span></>}<span className="shrink-0 tabular-nums">{shownSize(f.size)}</span><span aria-hidden>·</span><span className="shrink-0"><Ago value={trash ? f.deleted_at : f.created_at} /></span></span>
      </span>
    </span>
  );

  const uploadButton = (label: string, testId: string) => {
    const main = testId === "upload-button";
    const face = <><UploadIcon /><span className={main ? "max-md:sr-only" : undefined}>{label}</span>{main && <KeyHint shortcut={CATALOG["tasks.new"].shortcut} className="max-md:hidden" />}</>;
    const size = main ? "max-md:size-11 max-md:px-0" : "max-md:min-h-11";
    if (certain) return <Button size="sm" onClick={upload} data-testid={testId} className={size}>{face}</Button>;
    return (
      <DropdownMenu open={choosing} onOpenChange={(open) => { setChoosing(open); if (!open) held.current = []; }}>
        <DropdownMenuTrigger asChild><Button size="sm" data-testid={testId} className={size}>{face}</Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="text-caption text-muted-foreground">Which space is it for?</DropdownMenuLabel>
          {writable.map((s) => <DropdownMenuItem key={s.id} data-testid="upload-space" onSelect={() => { const carrying = held.current.length > 0; setTarget(s.id); setChoosing(false); if (!carrying) requestAnimationFrame(picker.open); }} className="max-md:min-h-11"><Layers />{s.name}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const reachable = state !== "no-space" && state !== "no-access";
  return (
    <section aria-label="Files" data-testid="files-page" className="flex h-full min-h-0 min-w-0 flex-col">
      {picker.element}
      <DropArea onFiles={take} disabled={!canAdd || trash} label={here ? `Drop to add to ${here.name}` : "Drop to upload"} className="flex min-h-0 flex-1 flex-col">
        <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5">
          <h1 className="min-w-0 truncate text-title max-md:flex-1">Files{here && <span className="font-normal text-muted-foreground"> in {here.name}</span>}</h1>
          {space && <PresenceAvatars room={`space-${space}`} />}
          {reachable && <div ref={search} className="w-52 max-md:order-last max-md:w-full max-md:basis-full"><SearchInput value={url.q} onChange={(v) => setUrl({ q: v })} placeholder="Search files" className="w-full [&_input]:max-sm:h-11" /></div>}
          {reachable && !trash && <div className="flex items-center gap-2 max-md:order-last max-md:w-full [&>*]:max-md:flex-1">
            <FilterSelect value={filters.kind} onChange={(v) => setUrl({ kind: v })} options={KIND_FILTERS} allLabel="All types" label="Type" className="sm:w-36" />
            <FilterSelect value={filters.date} onChange={(v) => setUrl({ date: v })} options={DATE_FILTERS} allLabel="Any date" label="Date" className="sm:w-36" />
          </div>}
          <div className="ml-auto flex items-center gap-2">
            {reachable && <Segmented size="sm" label="Show" value={trash ? "trash" : "files"} onChange={(v) => setUrl({ view: v })} options={[{ value: "files", label: "Files" }, { value: "trash", label: "Trash" }]} className="max-md:[&_button]:min-h-11" />}
            {canAdd && !trash && uploadButton("Upload", "upload-button")}
          </div>
        </header>
        {here && !here.can_create && !trash && <p role="status" data-testid="files-read-only" className="flex shrink-0 items-center gap-2 border-b bg-muted/50 px-4 py-1.5 text-caption text-muted-foreground">{isGuest(me) ? <><Lock aria-hidden className="size-3.5 shrink-0" />You can open this space's files. Its managers decide if guests can add one.</> : <><Archive aria-hidden className="size-3.5 shrink-0" />This space is archived, so its files stay as they are.</>}</p>}
        <UploadRows uploads={uploads} set={set} className="shrink-0 border-b p-2" />
        {state === "loading" && <div aria-busy="true" aria-label="Loading files" data-testid="files-loading" className="space-y-2 p-3">{["w-3/5", "w-2/5", "w-1/2", "w-3/4", "w-1/3"].map((w) => <Skeleton key={w} className={`h-6 ${w}`} />)}</div>}
        {state === "failed" && <Wrap id="files-failed"><LoadError title="Your files didn't load" error={failed} onRetry={() => { void list.refetch(); void setup.refetch(); }} /></Wrap>}
        {state === "no-access" && <Wrap id="files-no-access"><EmptyState icon={Lock} className="border-0" title="This space can't be opened" description="It may not exist, or you may not have access to it." action={<Button asChild size="sm" variant="outline" className="max-md:min-h-11"><Link to="/files">All files</Link></Button>} /></Wrap>}
        {state === "no-space" && <Wrap id="files-no-space"><EmptyState icon={Layers} className="border-0" title={isGuest(me) ? "You're not in a space yet" : "Files live in spaces"} description={isGuest(me) ? "Ask whoever invited you to add you to one." : "Join a space or start one, and its files will show here."} /></Wrap>}
        {state === "never" && <Wrap id="files-never"><EmptyState icon={Files} className="border-0" title="No files yet" description={canAdd ? <>Drop a file anywhere here, paste a screenshot, or pick one. <LimitHint />.</> : here ? "Nothing here yet. Files appear once a member adds one." : "Nothing here yet."} action={canAdd ? uploadButton("Upload a file", "first-file-button") : undefined} /></Wrap>}
        {state === "no-match" && <Wrap id="files-no-match"><EmptyState icon={SearchX} className="border-0" title={trash ? "No deleted files match that" : "No files match that"} description="Try another name, or clear the filters." action={<Button size="sm" variant="outline" onClick={() => setUrl({ q: "", kind: "", date: "" })} data-testid="files-clear" className="max-md:min-h-11">Clear filters</Button>} /></Wrap>}
        {state === "trash-empty" && <Wrap id="files-trash-empty"><EmptyState icon={Trash2} className="border-0" title="The trash is empty" description="A deleted file stays here for 30 days, then its bytes are gone for good." /></Wrap>}
        {state === "ready" && (
          <DataList<FileView> flush label="Files" rows={shownRows} columns={columns} {...(grouped ? { group: whereOf } : {})} rowKey={(f) => f.id} mobileRow={mobileRow} empty={null} busy={list.isFetching && !list.isPending && list.isPlaceholderData} pageSize={30} className="min-h-0 flex-1 overflow-y-auto"
            {...(trash ? {} : { rowHref: (f: FileView) => `/files/${f.id}` })}
            rowActions={trash
              ? (f) => <Button size="xs" variant="outline" data-testid="file-restore" onClick={() => void restore(f)} className="max-md:min-h-11"><RotateCcw />Restore</Button>
              : (f) => <Button size="icon-sm" variant="ghost" aria-label={`Download ${f.name}`} data-testid="row-download" onClick={() => void download(f)} className="text-muted-foreground max-md:size-11"><Download /></Button>}
            footer={list.data?.next_page ? <div className="px-3 py-2"><Button variant="ghost" size="sm" onClick={() => setPage(list.data!.next_page!)} data-testid="files-more" className="text-muted-foreground max-md:min-h-11">Next page</Button></div> : undefined} />
        )}
      </DropArea>
    </section>
  );
}

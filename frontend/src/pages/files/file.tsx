// /files/:id: one file, shown if it can be, with where it's used. A refusal is a state the server answers with, so someone who has lost
// a file sees why, and the console stays quiet. HTML and SVG never reach a page here, whatever they call themselves.
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Archive, ChevronLeft, Copy, Download, FileX2, Lock, MoreHorizontal, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Ago, EmptyState, KeyHint, LoadError, rememberedHref } from "@/components/kit";
import { Person } from "@/components/workspace/person";
import { TypeTile, download } from "@/components/workspace/file-tile";
import { LinksPanel } from "@/components/workspace/links-panel";
import { useChannel } from "@/base/live";
import { CATALOG, useCommands, type Command } from "@/lib/commands";
import { filesApi } from "@/lib/files/api";
import { forgetBytes } from "@/lib/files/bytes";
import { useFile, useFileBytes } from "@/lib/files/client";
import { noPreviewReason, previewOf, shownSize, typeOf, whereOf, type FileView } from "@/lib/files/model";
import { shellToast } from "@/lib/toast";

const linksOf = (_: string, id: number, page?: number) => filesApi.links(id, page);
/** Past this a text file shows its start, and says so. */
const TEXT_SHOWN = 256 * 1024;

function TextPreview({ blob, file }: { blob: Blob; file: FileView }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => { let live = true; void blob.slice(0, TEXT_SHOWN).text().then((t) => { if (live) setText(t); }); return () => { live = false; }; }, [blob]);
  if (text === null) return <Skeleton className="m-4 h-40" />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {blob.size > TEXT_SHOWN && <p role="status" data-testid="text-cut" className="border-b bg-muted/50 px-3 py-1.5 text-caption text-muted-foreground">Showing the first {shownSize(TEXT_SHOWN)} of {shownSize(file.size)}. Download it for the rest.</p>}
      <pre data-testid="preview-text" tabIndex={0} className="focus-ring-inset min-h-0 flex-1 overflow-auto p-4 font-mono text-caption whitespace-pre-wrap wrap-anywhere">{text}</pre>
    </div>
  );
}

function NoPreview({ file, reason }: { file: FileView; reason: string }) {
  return (
    <div data-testid="no-preview" className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <TypeTile kind={file.kind} className="size-12 [&_svg]:size-6" />
      <p className="max-w-sm text-body text-pretty text-muted-foreground">{reason}</p>
      <Button size="sm" variant="outline" onClick={() => void download(file)} className="max-md:min-h-11"><Download />Download</Button>
    </div>
  );
}

function Preview({ file }: { file: FileView }) {
  const kind = previewOf(file);
  const bytes = useFileBytes(kind ? file : null);
  if (!kind) return <NoPreview file={file} reason={noPreviewReason(file)} />;
  if (bytes.state === "loading") return <div aria-busy="true" aria-label="Loading the preview" data-testid="preview-loading" className="flex flex-1 items-center justify-center p-8"><Skeleton className="h-64 w-full max-w-xl" /></div>;
  if (bytes.state === "refused") return <div data-testid="preview-refused" className="flex flex-1 items-center justify-center p-4"><EmptyState icon={Lock} className="border-0" title="You don't have access to this file" description="You may have been taken out of the space it's in." /></div>;
  if (bytes.state === "failed") return <div data-testid="preview-failed" className="flex flex-1 items-center justify-center p-4"><LoadError title="The preview didn't load" error={bytes.error} onRetry={bytes.retry} /></div>;
  if (kind === "image") return <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4"><img src={bytes.url} alt={file.name} data-testid="preview-image" className="max-h-full max-w-full rounded-md object-contain" /></div>;
  if (kind === "pdf") return navigator.pdfViewerEnabled === false
    ? <NoPreview file={file} reason="This browser can't show PDFs here. Download it to open it." />
    : <iframe src={`${bytes.url}#toolbar=0&navpanes=0`} title={file.name} data-testid="preview-pdf" className="min-h-[60vh] w-full flex-1 border-0 bg-muted/50" />;
  return <TextPreview blob={bytes.blob} file={file} />;
}

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => <div className="flex min-w-0 items-baseline justify-between gap-3 py-1 text-caption"><dt className="shrink-0 text-muted-foreground">{label}</dt><dd className="min-w-0 truncate text-right">{children}</dd></div>;

function Facts({ file }: { file: FileView }) {
  return (
    <dl data-testid="file-facts" className="divide-y">
      <Fact label="Added by"><Person name={file.uploader_name ?? "Someone"} kind={file.uploader_kind} /></Fact>
      <Fact label="Added"><Ago value={file.created_at} /></Fact>
      <Fact label="Where">{file.space_id ? <Link to={`/files?space=${file.space_id}`} className="focus-ring rounded-sm hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center">{whereOf(file)}</Link> : whereOf(file)}</Fact>
      <Fact label="Type">{typeOf(file)}</Fact>
      <Fact label="Size"><span className="tabular-nums">{shownSize(file.size)}</span></Fact>
    </dl>
  );
}

export function FilePage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const details = useFile(id);
  const data = details.data;
  const file = data?.file ?? null;
  const live = data?.state === "live";
  useChannel(file?.space_id ? `spaces/${file.space_id}` : null);
  // Someone who's lost the file shouldn't keep what this tab held of it.
  useEffect(() => { if (data?.state === "refused") forgetBytes(id); }, [data?.state, id]);

  const back = useCallback(() => navigate(rememberedHref("/files")), [navigate]);
  const restore = async () => {
    try { await filesApi.restore(id); await details.refetch(); }
    catch (e) { shellToast.error(`Couldn't bring that back. ${e instanceof Error ? e.message : "Try again."}`); }
  };
  const remove = async () => {
    if (!file) return;
    try {
      await filesApi.remove(id);
      forgetBytes(id);
      await details.refetch();
      shellToast.show(`Deleted ${file.name}`, { label: "Undo", onClick: () => void restore() });
    } catch (e) { shellToast.error(`Couldn't delete that. ${e instanceof Error ? e.message : "Try again."}`); }
  };
  const canDelete = !!data?.can_delete && !data.archived;
  const commands: Command[] = [
    { id: "list.close", ...CATALOG["list.close"], run: back },
    { id: "tasks.due", ...CATALOG["tasks.due"], label: "Download", group: "File", icon: Download, when: () => live, run: () => { if (file) void download(file); } },
    { id: "tasks.delete", ...CATALOG["tasks.delete"], label: "Delete the file", group: "File", icon: Trash2, when: () => live && canDelete, run: () => void remove() },
  ];
  useCommands(commands, "file");

  if (details.error && !data) return <div data-testid="file-failed" className="flex h-full items-center justify-center p-4"><LoadError title="This file didn't load" error={details.error} onRetry={() => void details.refetch()} /></div>;
  if (!data) return <div aria-busy="true" aria-label="Loading the file" data-testid="file-loading" className="space-y-3 p-4"><Skeleton className="h-6 w-1/3" /><Skeleton className="h-64 w-full" /></div>;
  if (data.state === "refused" || !file) return <div data-testid="file-no-access" className="flex h-full items-center justify-center p-4"><EmptyState icon={Lock} className="border-0" title="This file can't be opened" description="It may have been deleted, or you may not have access to it." action={<Button asChild size="sm" variant="outline" className="max-md:min-h-11"><Link to="/files">All files</Link></Button>} /></div>;

  return (
    <section aria-label={file.name} data-testid="file-page" className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex min-h-11 shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <Button variant="ghost" size="icon-sm" aria-label="Back to files" data-testid="file-back" onClick={back} className="-ml-1 text-muted-foreground max-md:size-11"><ChevronLeft /></Button>
        <h1 data-testid="file-title" className="min-w-0 flex-1 truncate text-title" title={file.name}>{file.name}</h1>
        {live && <Button size="sm" variant="outline" data-testid="file-save" onClick={() => void download(file)} className="max-md:size-11 max-md:px-0"><Download /><span className="max-md:sr-only">Download</span><KeyHint shortcut={CATALOG["tasks.due"].shortcut} className="max-md:hidden" /></Button>}
        {live && <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="More" data-testid="file-more" className="max-md:size-11"><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(location.href).then(() => shellToast.show("Copied. It opens for people who can reach this file."), () => shellToast.error("Your browser wouldn't copy that."))} className="max-md:min-h-11"><Copy />Copy link</DropdownMenuItem>
            {canDelete && <DropdownMenuItem variant="destructive" data-testid="file-delete" onSelect={() => void remove()} className="max-md:min-h-11"><Trash2 />Delete</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>}
      </header>
      {data.archived && live && <p role="status" className="flex shrink-0 items-center gap-2 border-b bg-muted/50 px-4 py-1.5 text-caption text-muted-foreground"><Archive aria-hidden className="size-3.5 shrink-0" />This space is archived, so this file stays as it is.</p>}
      <div className="flex min-h-0 flex-1 max-lg:flex-col max-lg:overflow-y-auto">
        <div data-testid="file-preview" className="flex min-h-0 min-w-0 flex-1 flex-col max-lg:min-h-[50vh]">
          {live ? <Preview file={file} /> : (
            <div data-testid="file-trashed" className="flex flex-1 items-center justify-center p-4"><EmptyState icon={FileX2} className="border-0" title="This file is in the trash" description="It reads Deleted everywhere it's linked, and it goes for good after 30 days." action={canDelete ? <Button size="sm" variant="outline" data-testid="file-page-restore" onClick={() => void restore()} className="max-md:min-h-11"><RotateCcw />Restore</Button> : undefined} /></div>
          )}
        </div>
        <aside aria-label="About this file" className="flex w-72 shrink-0 flex-col gap-4 border-l p-4 max-lg:w-full max-lg:border-t max-lg:border-l-0 lg:overflow-y-auto">
          <Facts file={file} />
          <LinksPanel type="file" id={id} editable={live && !data.archived} load={linksOf} labels={{ forward: "Attached to", back: "Linked from" }} />
        </aside>
      </div>
    </section>
  );
}

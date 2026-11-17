// A file at a glance. An image shows itself once it's in view, and everything else, or an image too big to fetch for a list, shows its type.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Download, File, FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileType, Lock, Trash2, X, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { saveFile } from "@/lib/files/bytes";
import { useFileBytes, useFileView } from "@/lib/files/client";
import { shownSize, typeOf, type FileKind, type FileView } from "@/lib/files/model";
import { shellToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { AgentMark } from "./agent-mark";

const ICONS: Record<FileKind, LucideIcon> = { image: FileImage, pdf: FileType, text: FileText, document: FileText, sheet: FileSpreadsheet, archive: FileArchive, media: FileAudio, other: File };
/** A list doesn't pull a large photo through to draw a square. */
const THUMBNAIL_AT_MOST = 2 * 1024 * 1024;

export async function download(file: Pick<FileView, "id" | "name">) {
  try { await saveFile(file); shellToast.show(`Saved ${file.name}`); }
  catch (e) { shellToast.error(`Couldn't get ${file.name}. ${e instanceof Error ? e.message : "Try again."}`); }
}

export function TypeTile({ kind, className }: { kind: FileKind; className?: string }) {
  const Icon = ICONS[kind];
  return <span data-testid="file-tile" data-kind={kind} className={cn("grid size-8 shrink-0 place-items-center rounded-md border bg-muted/50 text-muted-foreground", className)}><Icon aria-hidden className="size-4" /></span>;
}

function useInView<T extends HTMLElement>() {
  const node = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !node.current) return;
    const watch = new IntersectionObserver(([e]) => { if (e.isIntersecting) setSeen(true); }, { rootMargin: "200px" });
    watch.observe(node.current);
    return () => watch.disconnect();
  }, [seen]);
  return { node, seen };
}

/** A square for a list: the picture when there is one, the type when there isn't, and the type again if the picture won't come. */
export function FileThumb({ file, className }: { file: Pick<FileView, "id" | "name" | "kind" | "size">; className?: string }) {
  const wanted = file.kind === "image" && file.size <= THUMBNAIL_AT_MOST;
  const { node, seen } = useInView<HTMLSpanElement>();
  const bytes = useFileBytes(wanted ? file : null, seen);
  if (!wanted || bytes.state === "refused" || bytes.state === "failed") return <span ref={node} className="contents"><TypeTile kind={file.kind} className={className} /></span>;
  return (
    <span ref={node} data-testid="file-thumb" className={cn("block size-8 shrink-0 overflow-hidden rounded-md border bg-muted/50", className)}>
      {bytes.state === "ready" && <img src={bytes.url} alt="" className="size-full object-cover" />}
    </span>
  );
}

const fact = (f: Pick<FileView, "kind" | "size" | "name">) => `${typeOf(f)}, ${shownSize(f.size)}`;

/** One file on a message or a record: where to open it, and a way to save it without leaving. */
export function FileCard({ file, onRemove, removeLabel = "Remove this file", bare = false, className }: { file: FileView; onRemove?: () => void; removeLabel?: string; bare?: boolean; className?: string }) {
  return (
    <div data-testid="file-card" className={cn("group/file flex min-w-0 items-center gap-2 rounded-md border bg-card p-1 pr-0.5", className)}>
      <Link to={`/files/${file.id}`} className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-sm max-md:min-h-11">
        {!bare && <FileThumb file={file} />}
        <span className={cn("flex min-w-0 flex-col", bare && "pl-1")}>
          {/* The name gets the whole line, and its full text on hover; who made it rides on the line under it. */}
          <span className="truncate text-caption font-medium" title={file.name}>{file.name}</span>
          <span className="flex min-w-0 items-center gap-1 text-micro text-muted-foreground">
            <span className="truncate">{fact(file)}{file.uploader_kind === "agent" && file.uploader_name ? ` · by ${file.uploader_name}` : ""}</span>
            {file.uploader_kind === "agent" && <AgentMark compact />}
          </span>
        </span>
      </Link>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Download ${file.name}`} data-testid="file-download" onClick={() => void download(file)} className="size-7 shrink-0 text-muted-foreground max-md:size-11"><Download /></Button>
      {onRemove && <Button type="button" variant="ghost" size="icon-sm" aria-label={removeLabel} data-testid="file-remove" onClick={onRemove} className="size-7 shrink-0 text-muted-foreground max-md:size-11"><X /></Button>}
    </div>
  );
}

function Gone({ icon: Icon, children }: { icon: LucideIcon; children: string }) {
  return <span data-testid="file-gone" className="inline-flex h-7 items-center gap-1.5 rounded-md border bg-muted/50 px-2 text-caption text-muted-foreground"><Icon aria-hidden className="size-3.5" />{children}</span>;
}

/** A picture in a message shows itself, at a size that keeps the conversation readable. */
function Picture({ file }: { file: FileView }) {
  const bytes = useFileBytes(file);
  if (bytes.state === "refused" || bytes.state === "failed") return <FileCard file={file} className="max-w-xs" />;
  return (
    <div className="flex max-w-sm flex-col gap-1">
      <Link to={`/files/${file.id}`} aria-label={`Open ${file.name}`} data-testid="message-image" className="focus-ring block w-fit overflow-hidden rounded-md border bg-muted/50">
        {bytes.state === "ready" ? <img src={bytes.url} alt={file.name} className="block max-h-60 max-w-full object-contain" /> : <Skeleton className="h-40 w-64 max-w-full rounded-none" />}
      </Link>
      <FileCard file={file} bare />
    </div>
  );
}

function OneFile({ id }: { id: number }) {
  const view = useFileView(id);
  if (view.isPending) return <Skeleton className="h-10 w-56 rounded-md" />;
  if (view.error || view.data?.state === "locked") return <Gone icon={Lock}>No access</Gone>;
  const file = view.data?.file;
  if (!file) return <Gone icon={Trash2}>File deleted</Gone>;
  return file.kind === "image" ? <Picture file={file} /> : <FileCard file={file} className="max-w-xs" />;
}

export function MessageFiles({ ids }: { ids: number[] }) {
  return <div data-testid="message-files" onClick={(e) => e.stopPropagation()} className="mt-1 flex flex-col items-start gap-1">{ids.map((id) => <OneFile key={id} id={id} />)}</div>;
}

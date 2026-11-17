// The way a file gets in, wherever one can: a button, a drop, or a paste. Each file gets its own row, so progress, a cancel, a failure and
// its way out are all beside the name they belong to. Nothing here decides who may upload: the server does, and these rows say what it said.
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { Ban, CircleAlert, Plus, RotateCw, Upload as UploadIcon, WifiOff, X, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFileStorage, useUploads } from "@/lib/files/client";
import { shownSize, type Place } from "@/lib/files/model";
import { canRetry, type Upload, type Uploads, type UploadState } from "@/lib/files/queue";
import { cn } from "@/lib/utils";

const filesOf = (list: FileList | DataTransferItemList | null | undefined) => {
  if (!list) return [];
  if (list instanceof FileList) return [...list];
  return [...list].flatMap((item) => { const file = item.kind === "file" ? item.getAsFile() : null; return file ? [file] : []; });
};
const carriesFiles = (e: DragEvent) => [...e.dataTransfer.types].includes("Files");
/** A pasted screenshot arrives as image.png. It needs telling apart from the last one. */
export const pastedFiles = (e: ClipboardEvent | globalThis.ClipboardEvent) => filesOf(e.clipboardData?.items).map((f) => (f.name === "image.png" ? new File([f], `Pasted image ${new Date().toISOString().slice(0, 19).replace("T", " ").replace(/:/g, ".")}.png`, { type: f.type }) : f));

/** The hidden file input behind a button, or behind a row's "Try another file". */
export function usePicker(onPick: (files: File[]) => void, multiple = true) {
  const input = useRef<HTMLInputElement>(null);
  const element = <input ref={input} type="file" multiple={multiple} hidden data-testid="file-input" onChange={(e) => { const picked = [...(e.target.files ?? [])]; e.target.value = ""; if (picked.length) onPick(picked); }} />;
  return { element, open: () => input.current?.click() };
}

const FAILS: Partial<Record<UploadState, { icon: LucideIcon; title: string }>> = {
  failed: { icon: WifiOff, title: "Didn't upload" },
  cancelled: { icon: X, title: "Cancelled" },
  too_big: { icon: CircleAlert, title: "Too big" },
  wrong_type: { icon: Ban, title: "Can't be shared" },
  empty: { icon: CircleAlert, title: "Empty file" },
  refused: { icon: Ban, title: "Not allowed" },
};

function Row({ upload, set, keepDone }: { upload: Upload; set: Uploads; keepDone?: boolean }) {
  const replace = usePicker(([file]) => set.replace(upload.key, file), false);
  const failed = FAILS[upload.state];
  const going = upload.state === "uploading" || upload.state === "queued";
  const percent = Math.round(upload.progress * 100);
  if (upload.state === "done" && !keepDone) return null;
  const Icon = failed?.icon ?? UploadIcon;
  return (
    <li data-testid="upload-row" data-state={upload.state} className={cn("flex min-w-0 items-center gap-2 rounded-md border bg-card px-2 py-1", failed && upload.state !== "cancelled" && "border-destructive/40 bg-destructive/5")}>
      <Icon aria-hidden className={cn("size-3.5 shrink-0", failed && upload.state !== "cancelled" ? "text-destructive" : "text-muted-foreground")} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2"><span className="truncate text-caption font-medium">{upload.name}</span><span className="shrink-0 text-micro text-muted-foreground tabular-nums">{upload.state === "uploading" ? `${percent}%` : upload.state === "queued" ? "Waiting" : upload.state === "done" ? "Ready" : shownSize(upload.size)}</span></span>
        {going && <span role="progressbar" aria-label={`Uploading ${upload.name}`} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} className="block h-0.5 overflow-hidden rounded-full bg-muted"><span className="block h-full bg-foreground/60 transition-[width] duration-150" style={{ width: `${percent}%` }} /></span>}
        {failed && <span data-testid="upload-reason" role={upload.state === "cancelled" ? undefined : "alert"} className="text-micro text-pretty text-muted-foreground"><span className="font-medium text-foreground">{failed.title}.</span> {upload.reason}</span>}
      </span>
      {canRetry(upload.state) && <Button type="button" size="xs" variant="outline" data-testid="upload-retry" onClick={() => set.retry(upload.key)} className="max-md:min-h-11"><RotateCw />Retry</Button>}
      {failed && !canRetry(upload.state) && <>{replace.element}<Button type="button" size="xs" variant="outline" data-testid="upload-retry" onClick={replace.open} className="max-md:min-h-11">Try another file</Button></>}
      {going
        ? <Button type="button" size="xs" variant="ghost" data-testid="upload-cancel" onClick={() => set.cancel(upload.key)} className="text-muted-foreground max-md:min-h-11">Cancel</Button>
        : <Button type="button" size="icon-sm" variant="ghost" aria-label={`Dismiss ${upload.name}`} data-testid="upload-dismiss" onClick={() => set.remove(upload.key)} className="size-6 text-muted-foreground max-md:size-11"><X /></Button>}
    </li>
  );
}

export function UploadRows({ uploads, set, className, keepDone }: { uploads: Upload[]; set: Uploads | null; className?: string; keepDone?: boolean }) {
  const shown = keepDone ? uploads : uploads.filter((u) => u.state !== "done");
  if (!set || !shown.length) return null;
  return <ul aria-label="Uploads" data-testid="upload-rows" className={cn("flex flex-col gap-1", className)}>{shown.map((u) => <Row key={u.key} upload={u} set={set} keepDone={keepDone} />)}</ul>;
}

/** Takes a drop on everything inside it. The outline says it will, and says so only while a file is over it. */
export function DropArea({ onFiles, label, disabled = false, className, children }: { onFiles: (files: File[]) => void; label: string; disabled?: boolean; className?: string; children: ReactNode }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const reset = useCallback(() => { depth.current = 0; setOver(false); }, []);
  return (
    <div data-testid="drop-area" className={cn("relative", className)}
      onDragEnter={(e) => { if (disabled || !carriesFiles(e)) return; e.preventDefault(); depth.current += 1; setOver(true); }}
      onDragOver={(e) => { if (disabled || !carriesFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
      onDragLeave={() => { if (disabled) return; depth.current -= 1; if (depth.current <= 0) reset(); }}
      onDrop={(e) => { if (disabled || !carriesFiles(e)) return; e.preventDefault(); reset(); const files = [...e.dataTransfer.files]; if (files.length) onFiles(files); }}>
      {children}
      {over && <div data-testid="drop-hint" className="pointer-events-none absolute inset-1 z-30 grid place-items-center rounded-lg border-2 border-dashed border-foreground/30 bg-background/85"><p className="flex items-center gap-2 text-body font-medium"><UploadIcon aria-hidden className="size-4" />{label}</p></div>}
    </div>
  );
}

/** Attaches what's picked, dropped or pasted to a record, and shows how that's going. */
export function RecordUpload({ place, label = "Attach a file", children, className }: { place: Place; label?: string; children?: (attach: { button: ReactNode; rows: ReactNode }) => ReactNode; className?: string }) {
  const { set, list } = useUploads(place, true);
  const picker = usePicker((files) => set?.add(files));
  // A finished row gives way to the file itself, on whichever list shows it.
  useEffect(() => { if (list.some((u) => u.state === "done")) set?.clearDone(); }, [list, set]);
  const button = <>{picker.element}<Button type="button" variant="ghost" size="sm" data-testid="attach-file" onClick={picker.open} className="-ml-2 self-start text-muted-foreground max-md:min-h-11"><Plus />{label}</Button></>;
  const rows = <UploadRows uploads={list} set={set} />;
  return <DropArea onFiles={(files) => set?.add(files)} label="Drop to attach" className={className}>{children ? children({ button, rows }) : <>{rows}{button}</>}</DropArea>;
}

/** Says what the limit is, once it's known, without making anyone hunt for it. */
export function LimitHint({ className }: { className?: string }) {
  const storage = useFileStorage();
  if (!storage.data) return null;
  return <span data-testid="upload-limit" className={className}>Up to {shownSize(storage.data.max_upload_bytes)} a file</span>;
}


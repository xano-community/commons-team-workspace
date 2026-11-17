// What a company page and a deal page share: the frame around a record, and every way it can't open.
import { type ReactNode } from "react";
import { Link } from "react-router";
import { ChevronLeft, Lock, SearchX, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, LoadError, Segmented, rememberedHref } from "@/components/kit";
import { PresenceAvatars } from "@/base/presence";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { NoCustomers } from "./frame";

export const FIELD = "focus-ring inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md border bg-card px-2 text-caption hover:bg-muted/50 disabled:opacity-100 disabled:hover:bg-card max-md:h-11 max-md:px-3";

export function CantOpen({ allowed, error, seen, noun, back, onRetry, hasRow }: { allowed: boolean; error: unknown; seen: boolean; noun: string; back: string; onRetry: () => void; hasRow: boolean }) {
  if (!allowed) return <div className="flex h-full flex-col"><NoCustomers /></div>;
  if (!error) return null;
  if ((error as { status?: number }).status === 404) {
    return <div data-testid={seen ? "crm-record-removed" : "crm-record-not-found"} className="flex h-full items-center justify-center p-6">
      <EmptyState icon={seen ? Lock : SearchX} className="border-0" title={seen ? `You no longer have access to this ${noun}` : `This ${noun} can't be opened`} description={seen ? "It may have been removed, or your access changed." : "It may not exist, or you may not have access to it."} action={<Button asChild size="sm" variant="outline" className="max-md:min-h-11"><Link to={back}>Back to customers</Link></Button>} />
    </div>;
  }
  if (hasRow) return null;
  return <div className="p-4"><LoadError title={`This ${noun} didn't load`} error={error} onRetry={onRetry} /></div>;
}

export function Trashed({ noun, onRestore }: { noun: string; onRestore: () => void }) {
  return (
    <div role="status" data-testid="crm-trashed" className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-body text-muted-foreground">
      <Trash2 aria-hidden className="size-4 shrink-0" /><span className="min-w-0 flex-1 basis-48">This {noun} is in the trash. It's removed for good 30 days after it was deleted.</span>
      <Button size="sm" variant="outline" data-testid="crm-restore" onClick={onRestore} className="max-md:min-h-11">Restore</Button>
    </div>
  );
}

export function RecordFrame({ label, testId, back, backLabel, crumb, room, pane, onPane, menu, main, thread }: {
  label: string; testId: string; back: string; backLabel: string; crumb: ReactNode; room: string; pane: "details" | "thread"; onPane: (p: "details" | "thread") => void; menu?: ReactNode; main: ReactNode; thread: ReactNode;
}) {
  const mobile = useIsMobile();
  return (
    <section aria-label={label} data-testid={testId} className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-1.5 border-b px-2">
        <Button asChild variant="ghost" size="sm" className="max-md:min-h-11"><Link to={rememberedHref(back)} data-testid="crm-back"><ChevronLeft />{backLabel}</Link></Button>
        <span className="min-w-0 truncate text-caption text-muted-foreground">{crumb}</span>
        <div className="ml-auto flex items-center gap-1"><PresenceAvatars room={room} />{menu}</div>
      </header>
      {mobile && <div className="flex shrink-0 justify-center border-b p-1.5"><Segmented size="sm" label="Show" value={pane} onChange={(v) => onPane(v as "details" | "thread")} options={[{ value: "details", label: "Details" }, { value: "thread", label: "Comments" }]} className="[&_button]:min-h-11 [&_button]:px-6" /></div>}
      <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
        <div className={cn("min-h-0 overflow-y-auto", pane === "thread" && "max-md:hidden")}><div className="mx-auto flex max-w-3xl flex-col gap-5 p-4 md:p-6">{main}</div></div>
        <aside aria-label="Comments" data-testid="crm-thread" className={cn("min-h-0 min-w-0 md:border-l", pane === "details" && "max-md:hidden")}>{thread}</aside>
      </div>
    </section>
  );
}

export const Loading = ({ what }: { what: string }) => <div aria-busy="true" aria-label={`Loading ${what}`} className="space-y-3"><Skeleton className="h-7 w-2/3" /><Skeleton className="h-7 w-1/2" /><Skeleton className="h-24 w-full" /></div>;

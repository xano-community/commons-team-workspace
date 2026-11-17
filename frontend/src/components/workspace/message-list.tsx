// The message list. It's virtual and stays in normal DOM order, so selection and a screen reader work as they do on any page.
// Rows are keyed by `client_msg_id`, which a message keeps from pending to confirmed, so nothing remounts. Anchoring to the
// end keeps the row under your eye still when older ones arrive above it, and new ones are followed only if you're at the end.
import { Suspense, forwardRef, lazy, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, Check, Clock, Copy, CornerUpLeft, MessageSquareOff, Pencil, RotateCw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Avatar, KeyHint, dateFormat } from "@/components/kit";
import { AgentMark } from "@/components/workspace/agent-mark";
import { useMe } from "@/base/session";
import { BodyText } from "@/components/workspace/body-text";
import { MessageFiles } from "@/components/workspace/file-tile";
import type { AgentRun, Pickup } from "@/lib/agents/model";
import type { ListItem, Row } from "@/lib/chat/log";
import { CATALOG } from "@/lib/commands";
import { cn } from "@/lib/utils";

const RunChip = lazy(() => import("@/components/workspace/run-chip"));
const InboxApproval = lazy(() => import("@/components/workspace/approval-card").then((m) => ({ default: m.InboxApproval })));
const PickupChip = lazy(() => import("@/components/workspace/run-chip").then((m) => ({ default: m.PickupChip })));

const LOAD_WITHIN_PX = 400;
const PINNED_PX = 80;
const estimate = (item: ListItem | undefined) => (!item || item.kind !== "message" ? 32 : item.grouped ? 24 : 52);
/** Where a list opens, by its estimated sizes: the start of the `openAt` row, or the end less one screen. */
export function openingOffset(items: ListItem[], openAt: string | null, viewport: number): number {
  const at = openAt ? items.findIndex((i) => i.key === openAt) : -1;
  const upTo = at >= 0 ? at : items.length;
  let offset = 0;
  for (let i = 0; i < upTo; i++) offset += estimate(items[i]);
  return at >= 0 ? offset : Math.max(0, offset - viewport);
}
const clock = (at: number) => dateFormat({ hour: "numeric", minute: "2-digit" }).format(at);
function dayLabel(at: number) {
  const d = new Date(at);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return dateFormat({ weekday: "long", day: "numeric", month: "long", ...(d.getFullYear() !== new Date().getFullYear() && { year: "numeric" }) }).format(d);
}

export type MessageActions = {
  me: number;
  canModerate: boolean;
  canPost: boolean;
  /** A thread has no threads of its own. */
  canReply: boolean;
  nameOf: (id: number) => string;
  isAgent: (id: number) => boolean;
  onReply: (row: Row) => void;
  onEdit: (row: Row) => void;
  onDelete: (row: Row) => void;
  onRetry: (row: Row) => void;
  onDiscard: (row: Row) => void;
  onCopy: (row: Row) => void;
  /** The run this message started, if it started one. */
  runOf?: (row: Row) => { run: AgentRun; modelReady: boolean; keyName: string } | undefined;
  /** What a connected agent this message named has done about it. */
  pickupOf?: (row: Row) => { name: string; agentId: number; item: Pickup } | undefined;
};

function Body({ row, actions }: { row: Row; actions: MessageActions }) {
  return <BodyText body={row.body} me={actions.me} nameOf={actions.nameOf} isAgent={actions.isAgent} after={row.edited && !row.deleted && <span className="ml-1 text-caption text-muted-foreground">(edited)</span>} />;
}

function Tool({ label, keys, onClick, children }: { label: string; keys?: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} className="size-7 max-md:size-11">{children}</Button></TooltipTrigger>
      <TooltipContent className="flex items-center gap-2">{label}{keys && <KeyHint shortcut={keys} />}</TooltipContent>
    </Tooltip>
  );
}

/** What can be done to a message, on hover or when it's selected. */
function Tools({ row, actions, className }: { row: Row; actions: MessageActions; className?: string }) {
  const own = row.author_id === actions.me;
  return (
    <div role="toolbar" aria-label="Message actions" className={cn("flex items-center gap-0.5 rounded-md border bg-popover p-0.5 shadow-sm", className)}>
      {actions.canReply && <Tool label="Reply in a thread" keys={CATALOG["chat.reply"].shortcut} onClick={() => actions.onReply(row)}><CornerUpLeft /></Tool>}
      <Tool label="Copy text" onClick={() => actions.onCopy(row)}><Copy /></Tool>
      {own && actions.canPost && <Tool label="Edit" keys={CATALOG["chat.edit"].shortcut} onClick={() => actions.onEdit(row)}><Pencil /></Tool>}
      {(own || actions.canModerate) && actions.canPost && <Tool label="Delete" keys={CATALOG["chat.delete"].shortcut} onClick={() => actions.onDelete(row)}><Trash2 /></Tool>}
    </div>
  );
}

/** A message still here and nowhere else. Sending says nothing for a second, then a quiet clock. */
function Status({ row, actions }: { row: Row; actions: MessageActions }) {
  if (row.local === "sending") return <span data-testid="message-sending" className="mt-0.5 flex items-center gap-1 text-caption text-muted-foreground opacity-0 [animation:fade-in-late_150ms_1s_forwards]"><Clock aria-hidden className="size-3" />Sending</span>;
  const failed = row.local === "failed";
  return (
    <div data-testid={failed ? "message-failed" : "message-blocked"} role="alert" className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption">
      <span className="text-destructive">{row.reason}</span>
      {failed && <Button type="button" size="xs" variant="outline" onClick={() => actions.onRetry(row)} className="max-sm:min-h-11"><RotateCw />Retry</Button>}
      <Button type="button" size="xs" variant="ghost" onClick={() => actions.onCopy(row)} className="max-sm:min-h-11"><Copy />Copy</Button>
      <Button type="button" size="xs" variant="ghost" onClick={() => actions.onDiscard(row)} className="max-sm:min-h-11"><X />Discard</Button>
    </div>
  );
}

const Message = memo(function Message({ row, grouped, selected, editing, actions, onSelect }: { row: Row; grouped: boolean; selected: boolean; editing: ReactNode; actions: MessageActions; onSelect: (key: string) => void }) {
  const confirmed = row.seq !== null && !row.deleted;
  const pale = row.local === "sending";
  const shown = row.deleted || row.local === "failed" || row.local === "blocked" ? undefined : actions.runOf?.(row);
  const picked = row.deleted || row.local ? undefined : actions.pickupOf?.(row);
  const me = useMe()?.id;
  // Not while its thread is open beside the channel: the thread shows the same card, and one is enough.
  const threadOpen = Number(useSearchParams()[0].get("thread")) || 0;
  const asksMe = !!shown && shown.run.status === "waiting" && !!shown.run.approval_id && shown.run.waiting_on === me && shown.run.thread_id !== threadOpen;
  // The toolbar only shows on hover, focus or selection, so it's only built then: a conversation opens with dozens of rows,
  // and four tooltips on each would double the work of opening it.
  const [near, setNear] = useState(false);
  const come = () => { if (!near) setNear(true); };
  return (
    <div data-kit="message" data-key={row.key} data-seq={row.seq ?? undefined} data-selected={selected || undefined} onClick={() => onSelect(row.key)} onPointerEnter={come} onFocus={come}
      className={cn("group relative flex gap-2.5 px-4 hover:bg-muted/40 max-sm:px-3", grouped ? "py-px" : "pt-2 pb-px", selected && "bg-selected hover:bg-selected", row.local && row.local !== "sending" && "bg-destructive/5")}>
      <div className="w-8 shrink-0">
        {grouped
          ? <time className="mt-0.5 block text-right text-micro text-muted-foreground tabular-nums opacity-0 group-hover:opacity-100" dateTime={new Date(row.created_at).toISOString()}>{clock(row.created_at)}</time>
          : <Avatar name={row.author_name} kind={row.author_kind} size="md" decorative />}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex min-w-0 items-baseline gap-2">
            <span className={cn("truncate text-body font-medium", row.author_kind === "agent" && "text-agent-text")}>{row.author_name}</span>
            {row.author_kind === "agent" && <span className="self-center"><AgentMark /></span>}
            {row.via && <span data-testid="message-via" className="shrink-0 text-caption text-muted-foreground">via {row.via}</span>}
            {row.approver && <span data-testid="message-approved-by" className="min-w-0 truncate text-caption text-muted-foreground">approved by {row.approver}</span>}
            <time className="shrink-0 text-caption text-muted-foreground tabular-nums" dateTime={new Date(row.created_at).toISOString()}>{clock(row.created_at)}</time>
          </div>
        )}
        {row.deleted
          ? <p data-testid="message-tombstone" className="flex items-center gap-1.5 text-body text-muted-foreground"><MessageSquareOff aria-hidden className="size-3.5 shrink-0" />This message was deleted.</p>
          : editing ?? <div data-note={row.note || undefined} className={cn((pale || row.note) && "text-muted-foreground", row.note && "[&_p]:text-caption")}>{row.body && <Body row={row} actions={actions} />}</div>}
        {!row.deleted && !editing && row.files.length > 0 && <MessageFiles ids={row.files} />}
        {row.reply_count > 0 && (
          <button type="button" data-testid="message-replies" onClick={(e) => { e.stopPropagation(); actions.onReply(row); }} className="focus-ring mt-0.5 inline-flex min-h-6 items-center gap-1 rounded-sm text-caption font-medium text-foreground/80 hover:text-foreground hover:underline max-sm:min-h-11">
            <CornerUpLeft aria-hidden className="size-3" />{row.reply_count === 1 ? "1 reply" : `${row.reply_count} replies`}
          </button>
        )}
        {shown && !asksMe && <Suspense fallback={null}><RunChip {...shown} className="mt-1" /></Suspense>}
        {/* A draft waiting on the reader is decided right here, on the message that asked for it: the card says who and what. */}
        {shown && asksMe && (
          <div data-testid="message-approval" className="mt-1 max-w-xl" onClick={(e) => e.stopPropagation()}><Suspense fallback={null}><InboxApproval id={shown.run.approval_id} /></Suspense></div>
        )}
        {!shown && picked && <Suspense fallback={null}><PickupChip {...picked} className="mt-1" /></Suspense>}
        {row.local && <Status row={row} actions={actions} />}
      </div>
      {confirmed && !editing && (near || selected) && <Tools row={row} actions={actions} className={cn("absolute -top-2 right-4 z-10 hidden md:group-hover:flex md:group-focus-within:flex", selected && "md:flex")} />}
    </div>
  );
});

export type MessageListHandle = { toEnd: () => void; toSeq: (seq: number) => boolean; isPinned: () => boolean };

export const MessageList = forwardRef<MessageListHandle, {
  items: ListItem[];
  conversationKey: number;
  hasOlder: boolean;
  hasNewer: boolean;
  older: "idle" | "loading" | "failed";
  newer: "idle" | "loading" | "failed";
  onOlder: () => void;
  onNewer: () => void;
  onLatest: () => void;
  onPinned: (pinned: boolean) => void;
  actions: MessageActions;
  selected: string | null;
  onSelect: (key: string) => void;
  editing: (row: Row) => ReactNode;
  /** Where to open: the unread line if there is one, otherwise the end. */
  openAt: string | null;
  beginning: ReactNode;
  label: string;
  /** A thread or a record's comments read down from what they're about, so a short one sits at the top, not the bottom. */
  fromTop?: boolean;
}>(function MessageList({ items, conversationKey, hasOlder, hasNewer, older, newer, onOlder, onNewer, onLatest, onPinned, actions, selected, onSelect, editing, openAt, beginning, label, fromTop = false }, handle) {
  const scroller = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const edges = useRef({ hasOlder, hasNewer, older, newer, onOlder, onNewer, onPinned });
  edges.current = { hasOlder, hasNewer, older, newer, onOlder, onNewer, onPinned };

  const opened = useRef<number | null>(null);
  // A list starts at its top while it's being placed, and that's no request for older rows. It counts once the reader has been
  // away from the top, or when there's too little here to get away from it.
  const armed = useRef<number | null>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    // The first render already draws the rows it opens on. Starting at the top would draw the oldest rows, then draw the
    // newest again once the list lands at its end: twice the work before the conversation shows.
    initialOffset: () => openingOffset(items, openAt, typeof window === "undefined" ? 0 : window.innerHeight),
    initialRect: typeof window === "undefined" ? undefined : { width: 0, height: window.innerHeight },
    estimateSize: (i) => estimate(items[i]),
    getItemKey: (i) => items[i]?.key ?? i,
    overscan: 8,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: PINNED_PX,
    // `onChange`, not a scroll listener: that one sees the position before the virtualizer has settled it.
    onChange: (v) => {
      const at = v.isAtEnd(PINNED_PX);
      setPinned((was) => { if (was !== at) edges.current.onPinned(at); return at; });
      const top = v.scrollOffset ?? 0;
      const e = edges.current;
      // Safari's rubber band reports below zero, and that isn't a request for more.
      const height = v.scrollRect?.height ?? 0;
      if (top >= LOAD_WITHIN_PX || (height > 0 && v.getTotalSize() - height < LOAD_WITHIN_PX)) armed.current = conversationKey;
      if (armed.current === conversationKey && top >= 0 && top < LOAD_WITHIN_PX && e.hasOlder && e.older === "idle") e.onOlder();
      if (e.hasNewer && e.newer === "idle" && v.getDistanceFromEnd() < LOAD_WITHIN_PX) e.onNewer();
    },
  });

  // A scroll that reached the top while a page was on its way asked for nothing. If it's still up here once that page has
  // settled, nothing else would ask: the list only hears about scrolling.
  const wasLoading = useRef(false);
  useEffect(() => {
    const settled = wasLoading.current && older === "idle";
    wasLoading.current = older === "loading";
    if (settled && armed.current === conversationKey && hasOlder && (scroller.current?.scrollTop ?? LOAD_WITHIN_PX) < LOAD_WITHIN_PX) onOlder();
  }, [older, hasOlder, onOlder, conversationKey]);

  // When older rows land, the row that was first can lose its header to them and shrink. The default skips a re-measure
  // while scrolling up, which is exactly when that happens, so the reader's row would jump by the header's height. Here any
  // row that starts above the fold is absorbed, in either direction, and what's being read stays still.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, v) => item.start < (v.scrollOffset ?? 0);

  const indexOf = useCallback((key: string) => items.findIndex((i) => i.key === key), [items]);
  useImperativeHandle(handle, () => ({
    toEnd: () => virtualizer.scrollToEnd(),
    toSeq: (seq) => {
      const i = items.findIndex((x) => x.kind === "message" && x.row.seq === seq);
      if (i < 0) return false;
      virtualizer.scrollToIndex(i, { align: "center" });
      return true;
    },
    isPinned: () => virtualizer.isAtEnd(PINNED_PX),
  }), [items, virtualizer]);

  // Opening a conversation lands in one step, before the first paint, so nothing visibly scrolls.
  useLayoutEffect(() => {
    if (opened.current === conversationKey || !items.length) return;
    opened.current = conversationKey;
    const i = openAt ? indexOf(openAt) : -1;
    if (i >= 0) { armed.current = conversationKey; virtualizer.scrollToIndex(i, { align: "start" }); }
    else virtualizer.scrollToEnd();
  }, [conversationKey, items.length, openAt, indexOf, virtualizer]);

  // A selection made by key follows into view.
  useEffect(() => {
    if (!selected) return;
    const i = indexOf(selected);
    if (i >= 0) virtualizer.scrollToIndex(i, { align: "auto" });
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = virtualizer.getVirtualItems();
  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} role="log" aria-label={label} aria-live="off" tabIndex={0} data-testid="message-list" className="focus-ring-inset h-full overflow-y-auto overscroll-contain [contain:layout_paint_style] [overflow-anchor:none]">
        <div className={cn("flex min-h-full flex-col", fromTop ? "justify-start" : "justify-end")}>
          <div className="relative w-full shrink-0" style={{ height: virtualizer.getTotalSize() }}>
            {rows.map((v) => {
              const item = items[v.index];
              if (!item) return null;
              return (
                <div key={v.key} ref={virtualizer.measureElement} data-index={v.index} className="absolute top-0 left-0 w-full" style={{ transform: `translateY(${v.start}px)` }}>
                  {item.kind === "beginning" && beginning}
                  {item.kind === "day" && <div className="flex items-center gap-3 px-4 pt-4 pb-1"><span className="h-px flex-1 bg-border" /><span className="text-caption font-medium text-muted-foreground">{dayLabel(item.at)}</span><span className="h-px flex-1 bg-border" /></div>}
                  {item.kind === "unread" && <div data-testid="unread-line" className="flex items-center gap-3 px-4 pt-3 pb-1"><span className="h-px flex-1 bg-foreground/30" /><span className="text-caption font-medium text-foreground">New</span></div>}
                  {item.kind === "message" && <Message row={item.row} grouped={item.grouped} selected={selected === item.key} editing={editing(item.row)} actions={actions} onSelect={onSelect} />}
                </div>
              );
            })}
          </div>
          <div className="h-2 shrink-0" />
        </div>
      </div>
      {/* Over the list, never in it: anything that took up space up there would push the rows being read. */}
      {older === "failed" && <div className="absolute inset-x-0 top-2 z-10 flex justify-center"><div role="alert" className="flex items-center gap-2 rounded-md border bg-popover px-3 py-1 text-caption text-muted-foreground shadow-sm">Older messages didn't load.<Button size="xs" variant="outline" onClick={onOlder} className="max-sm:min-h-11">Try again</Button></div></div>}
      {older === "loading" && <div aria-hidden className="absolute inset-x-0 top-0 z-10"><Skeleton className="h-0.5 w-full rounded-none" /></div>}
      {(!pinned || hasNewer) && (
        <Button type="button" size="sm" variant="outline" data-testid="jump-latest" onClick={onLatest} className="absolute right-4 bottom-3 z-10 bg-popover shadow-sm max-sm:min-h-11">
          <ArrowDown />Jump to latest
        </Button>
      )}
      {selected && <SelectedTools items={items} selected={selected} actions={actions} onClose={() => onSelect(selected)} />}
    </div>
  );
});

/** A phone has no hover, so tapping a message brings its actions here, under the thumb. */
function SelectedTools({ items, selected, actions, onClose }: { items: ListItem[]; selected: string; actions: MessageActions; onClose: () => void }) {
  const item = items.find((i) => i.key === selected);
  if (item?.kind !== "message" || item.row.seq === null || item.row.deleted) return null;
  return (
    <div className="absolute inset-x-3 bottom-2 z-20 flex items-center justify-between gap-2 rounded-lg border bg-popover p-1 shadow-md md:hidden">
      <Tools row={item.row} actions={actions} className="border-0 bg-transparent p-0 shadow-none" />
      <Button type="button" variant="ghost" size="icon" aria-label="Done" onClick={onClose} className="size-11"><Check /></Button>
    </div>
  );
}

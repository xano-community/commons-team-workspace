import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronsRight, MoreHorizontal, Plus } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Avatar, AvatarStack, type Face } from "./avatar";
import { DueLabel, PriorityMark } from "./marks";
import { LoadError } from "./states";
import { StatusBadge, type Tone } from "./status-badge";

export interface KanbanColumn {
  id: string; title: string; tone?: Tone; hint?: string; /** Warn when a column holds more than this. */ limit?: number;
  /** A wide screen shows it as a slim rail with its name and count (a drop target still), opened with a click: a Lost column. */
  rail?: boolean;
}

type Key = string | number;

// The column's colour: a step off the page in light, a shade under the cards in dark (opaque, so the list's fade
// reads as cards going under it).
const COLUMN_BG = "[--kanban-col:color-mix(in_oklch,var(--muted)_60%,var(--background))] dark:[--kanban-col:color-mix(in_oklch,var(--muted)_25%,var(--background))]";
const cards = (n: number) => `${n} ${n === 1 ? "card" : "cards"}`;
const CARD_HEIGHT = 84;
const CARD_GAP = 8;
const LIST_FADE = cn("md:data-[fade=bottom]:[mask-image:linear-gradient(to_bottom,black_calc(100%-2.5rem),transparent)]",
  "md:data-[fade=top]:[mask-image:linear-gradient(to_bottom,transparent,black_1.5rem)]",
  "md:data-[fade=both]:[mask-image:linear-gradient(to_bottom,transparent,black_1.5rem,black_calc(100%-2.5rem),transparent)]");

/** One column's cards, drawn only where they can be seen, so a column of thousands costs what a screenful does. */
function VirtualCards<T>({ list, itemKey, card, keep }: { list: T[]; itemKey: (item: T) => Key; card: (item: T, style: React.CSSProperties, ref: (el: Element | null) => void, index: number) => ReactNode; keep: Key | null }) {
  const scroller = useRef<HTMLDivElement>(null);
  const held = list.findIndex((i) => String(itemKey(i)) === String(keep));
  const v = useVirtualizer({
    count: list.length, getScrollElement: () => scroller.current, estimateSize: () => CARD_HEIGHT, overscan: 6, gap: CARD_GAP, getItemKey: (i) => itemKey(list[i]),
    // A column is about a screen tall, so the first render draws a screen of cards, not the overscan alone and then the rest.
    initialRect: typeof window === "undefined" ? undefined : { width: 0, height: window.innerHeight },
    // The selected or dragged card stays mounted: it holds focus, and a drag ends on the element it started from.
    rangeExtractor: (range) => {
      const shown = Array.from({ length: range.endIndex - range.startIndex + 1 + range.overscan * 2 }, (_, i) => range.startIndex - range.overscan + i).filter((i) => i >= 0 && i < range.count);
      return held >= 0 && !shown.includes(held) ? [...shown, held].sort((a, b) => a - b) : shown;
    },
  });
  useEffect(() => { if (held >= 0) v.scrollToIndex(held, { align: "auto" }); }, [held]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={scroller} data-kanban-list className={cn("min-h-16 flex-1 overflow-y-auto overscroll-y-contain px-2 pb-1", LIST_FADE)}>
      <ul className="relative" style={{ height: v.getTotalSize() }}>
        {v.getVirtualItems().map((row) => card(list[row.index], { position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${row.start}px)` }, v.measureElement, row.index))}
      </ul>
    </div>
  );
}

/** What a card's face calls, read when it's called, so a board redrawing with new callbacks doesn't redraw every card. */
interface CardLive<T> {
  columns: KanbanColumn[];
  canMove: (item: T, to: string) => boolean;
  move: (item: T, to: string) => void;
  renderCard: (item: T) => ReactNode;
  onOpen?: (item: T) => void;
  onSelect?: (key: Key) => void;
  keyboardMoves: boolean;
  refocus: RefObject<{ key: Key; to: string } | null>;
}

/**
 * A card's contents and its Move menu. Each menu is a tree of Radix parts, so this is what a move mustn't redraw: at 4x
 * throttle, redrawing every mounted card took the frame a move had to land in. It redraws when its own item changes, so
 * `renderCard` must draw from the item alone. Selection and drop marks are on the `<li>` around it, and reach it through CSS.
 */
const CardFace = memo(function CardFace<T>({ item, itemId, columnIndex, targetIds, movable, fill, hint, live }: {
  item: T; itemId: Key; columnIndex: number; targetIds: string; movable: boolean; fill: boolean; hint: string; live: RefObject<CardLive<T>>;
}) {
  const now = live.current;
  const targets = now.columns.filter((c) => targetIds.split("\n").includes(c.id));
  return (
    <div className={cn(fill && "relative rounded-lg border bg-card text-body shadow-xs group-hover:border-foreground/15 group-data-[selected]:border-foreground/40 group-data-[selected]:bg-selected",
      "group-data-[drop=above]:before:absolute group-data-[drop=above]:before:inset-x-0 group-data-[drop=above]:before:-top-[5px] group-data-[drop=above]:before:h-0.5 group-data-[drop=above]:before:rounded-full group-data-[drop=above]:before:bg-primary-text",
      "group-data-[drop=below]:after:absolute group-data-[drop=below]:after:inset-x-0 group-data-[drop=below]:after:-bottom-[5px] group-data-[drop=below]:after:h-0.5 group-data-[drop=below]:after:rounded-full group-data-[drop=below]:after:bg-primary-text")}>
    <div role={now.onOpen ? "button" : undefined} tabIndex={0} aria-describedby={movable ? hint : undefined}
      onClick={() => live.current.onOpen?.(item)}
      onFocus={() => live.current.onSelect?.(itemId)}
      onKeyDown={(e) => {
        const { onOpen, keyboardMoves, columns, canMove, move, refocus } = live.current;
        if (e.key === "Enter" && onOpen && keyboardMoves) { e.preventDefault(); onOpen(item); }
        if (keyboardMoves && e.shiftKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
          e.preventDefault();
          const step = e.key === "ArrowRight" ? 1 : -1;
          for (let n = columnIndex + step; n >= 0 && n < columns.length; n += step) {
            if (canMove(item, columns[n].id)) { refocus.current = { key: itemId, to: columns[n].id }; move(item, columns[n].id); break; }
          }
        }
      }}
      className={cn("flex min-w-0 flex-col gap-1 rounded-lg p-3 focus-ring-inset",
        // The Move button sits top-right: a free-form card keeps clear of it; a KanbanCard clears it on its title only.
        movable && "pr-9 has-[[data-kit=kanban-card]]:pr-3",
        movable ? "cursor-grab active:cursor-grabbing" : now.onOpen && "cursor-pointer")}>
      {now.renderCard(item)}
    </div>
    {targets.length > 0 && (
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger aria-label="Move" data-kit="kanban-move"
              className="absolute top-2 right-2 grid size-7 place-items-center rounded-md text-muted-foreground opacity-100 hover:bg-muted hover:text-foreground focus-ring-inset data-[state=open]:opacity-100 max-md:size-11 max-md:top-0 max-md:right-0 md:opacity-50 md:group-hover:opacity-100 md:focus-visible:opacity-100">
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Move</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="text-caption text-muted-foreground">Move to</DropdownMenuLabel>
          {targets.map((c) => <DropdownMenuItem key={c.id} onSelect={() => live.current.move(item, c.id)}>{c.title}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
    )}
    </div>
  );
}) as <T>(props: { item: T; itemId: Key; columnIndex: number; targetIds: string; movable: boolean; fill: boolean; hint: string; live: RefObject<CardLive<T>> }) => ReactNode;

/**
 * A board of cards in columns: a pipeline's stages, a ticket's states (a signature view, CRAFT.md §17).
 * Move a card by dragging it (mouse), with its Move menu (touch, keyboard), or with Shift + ← / → when
 * it has focus. `onMove` should be optimistic (`optimistic()`): the board shows the move at once.
 * Lay a card out with `<KanbanCard>` (`renderCard` is the escape hatch for anything else). `onAdd` puts a +
 * in each column's header; `overdueOf` adds "2 overdue" (in warning) beside a column's count. On a wide screen each column
 * scrolls on its own under its header (the board itself only sideways), its list fading out where more is below;
 * on a phone the columns scroll sideways, one screen-width each, and the chip strip marks the one in view.
 */
const WIDE = "(min-width: 768px)";
/** Wide enough for the desktop board (rails, every column side by side). */
function useWide() {
  const [wide, setWide] = useState(() => typeof matchMedia === "undefined" || matchMedia(WIDE).matches);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const m = matchMedia(WIDE);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

export function KanbanBoard<T>({ label, columns, items, error, onRetry, columnOf, itemKey, renderCard, onMove, onReorder, onOpen, onAdd, overdueOf, canMove = () => true, emptyColumn = "Nothing here", fill = false, selected = null, onSelect, keyboardMoves = true, footer, signature = "kanban" }: {
  label: string;
  /** The domain this board is the signature view of ("crm"), for `data-signature-view`. */
  signature?: string;
  columns: KanbanColumn[];
  items: T[] | null | undefined;
  error?: unknown;
  onRetry?: () => void;
  columnOf: (item: T) => string;
  itemKey: (item: T) => Key;
  renderCard: (item: T) => ReactNode;
  onMove: (item: T, to: string) => void;
  /** A drop at a place in a column, its own included, above `before` or last with null. Without it a drop only changes column. */
  onReorder?: (item: T, to: string, before: Key | null) => void;
  onOpen?: (item: T) => void;
  /** A "+" in each column's header: add a card there. */
  onAdd?: (columnId: string) => void;
  /** Whether a card is overdue: its column's header says how many, in warning ("2 overdue"). */
  overdueOf?: (item: T) => boolean;
  canMove?: (item: T, to: string) => boolean;
  emptyColumn?: string;
  /** The board fills its parent, and each column draws only the cards in view, on every screen size. */
  fill?: boolean;
  /** The card the keyboard is on. It holds focus, and a column scrolls to it. */
  selected?: Key | null;
  onSelect?: (key: Key) => void;
  /** Off when the screen's own commands move cards. */
  keyboardMoves?: boolean;
  /** Under a column's cards, such as Show more. */
  footer?: (columnId: string) => ReactNode;
}) {
  const [drag, setDrag] = useState<Key | null>(null);
  const [over, setOver] = useState<string | null>(null);
  /** Where a drop would land: above this card, or under the last with `below`. */
  const [place, setPlace] = useState<{ before: Key | null; last: Key | null } | null>(null);
  const [said, setSaid] = useState("");
  // Rails a person has opened, and whether the screen is wide enough for rails at all (a phone scrolls every column).
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const wide = useWide();
  // A card the keyboard (or a move) puts into a folded column opens that column, so the selection never vanishes.
  const selectedItem = selected !== null ? (items ?? []).find((i) => String(itemKey(i)) === String(selected)) : undefined;
  const selectedIn = selectedItem === undefined ? null : columnOf(selectedItem);
  useEffect(() => {
    if (selectedIn && columns.some((c) => c.id === selectedIn && c.rail)) setOpened((o) => (o.has(selectedIn) ? o : new Set(o).add(selectedIn)));
  }, [selectedIn, columns]);
  const [edges, setEdges] = useState({ left: false, right: false });
  // The column in view on a phone (its jump chip shows selected).
  const [inView, setInView] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const jumps = useRef<HTMLElement>(null);
  const hint = useId();
  const live = useRef<CardLive<T>>(null!);
  // A keyboard move remounts the card in its new column, which drops focus: give it back to the card
  // (only when focus fell to the page, so it never steals it from somewhere else).
  const refocus = useRef<{ key: Key; to: string } | null>(null);
  useEffect(() => {
    const r = refocus.current;
    const el = r && root.current?.querySelector<HTMLElement>(`[data-kanban-card="${CSS.escape(String(r.key))}"] [tabindex="0"]`);
    if (!r || !el) return;
    if (el.closest("[data-kanban-column]")?.getAttribute("data-kanban-column") === r.to) refocus.current = null;
    if (!document.activeElement || document.activeElement === document.body) el.focus();
  });
  // The card the keyboard is on takes focus, once a column has drawn it, and again when a move redraws it elsewhere. Never from
  // someone typing or in a menu.
  const selectedColumn = selected === null ? null : (items ?? []).find((i) => String(itemKey(i)) === String(selected));
  const selectedHome = selectedColumn ? columnOf(selectedColumn) : null;
  useEffect(() => {
    if (selected === null) return;
    let tries = 3;
    const place = () => {
      const el = root.current?.querySelector<HTMLElement>(`[data-kanban-card="${CSS.escape(String(selected))}"] [tabindex="0"]`);
      if (el) { if (document.activeElement !== el && (document.activeElement === document.body || document.activeElement?.closest("[data-kanban-card]"))) el.focus(); return; }
      if (tries-- > 0) requestAnimationFrame(place);
    };
    place();
  }, [selected, selectedHome]); // eslint-disable-line react-hooks/exhaustive-deps
  // Fade the edge the board continues past, so a column cut off at the side reads as "there's more".
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const measure = () => {
      const left = el.scrollLeft > 1, right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
      // The column whose left edge is nearest the strip's own (its padding is where a snapped column starts).
      const start = el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft);
      let best: Element | null = null, dist = Infinity;
      for (const sec of el.querySelectorAll("[data-kanban-column]")) {
        const d = Math.abs(sec.getBoundingClientRect().left - start);
        if (d < dist) { dist = d; best = sec; }
      }
      setInView(best?.getAttribute("data-kanban-column") ?? null);
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.lastElementChild) ro.observe(el.lastElementChild);
    return () => { el.removeEventListener("scroll", measure); ro.disconnect(); };
  }, [columns.length, items]);
  // Keep the in-view column's chip in view in its own strip (sideways only: never scrolls the page).
  useEffect(() => {
    const nav = jumps.current, chip = inView && nav?.querySelector<HTMLElement>(`[data-kanban-jump="${CSS.escape(inView)}"]`);
    if (!nav || !chip || nav.scrollWidth <= nav.clientWidth) return;
    const left = chip.offsetLeft - nav.offsetLeft, right = left + chip.offsetWidth;
    if (left < nav.scrollLeft + 16) nav.scrollTo({ left: left - 16, behavior: "smooth" });
    else if (right > nav.scrollLeft + nav.clientWidth - 16) nav.scrollTo({ left: right - nav.clientWidth + 16, behavior: "smooth" });
  }, [inView]);
  // Each column's list fades at the end it continues past (wide screens, where it scrolls on its own).
  useLayoutEffect(() => {
    const lists = [...(root.current?.querySelectorAll<HTMLElement>("[data-kanban-list]") ?? [])];
    const measure = (ul: HTMLElement) => {
      const up = ul.scrollTop > 1, down = ul.scrollTop + ul.clientHeight < ul.scrollHeight - 1;
      const fade = up && down ? "both" : up ? "top" : down ? "bottom" : "";
      if ((ul.dataset.fade ?? "") !== fade) { if (fade) ul.dataset.fade = fade; else delete ul.dataset.fade; }
    };
    const offs = lists.map((ul) => { const f = () => measure(ul); f(); ul.addEventListener("scroll", f, { passive: true }); return () => ul.removeEventListener("scroll", f); });
    const ro = new ResizeObserver(() => lists.forEach(measure));
    lists.forEach((ul) => ro.observe(ul));
    return () => { offs.forEach((off) => off()); ro.disconnect(); };
  }, [columns.length, items]);
  if (error) return <LoadError error={error} onRetry={onRetry} />;
  const byKey = new Map((items ?? []).map((i) => [String(itemKey(i)), i]));
  const dragged = drag !== null ? byKey.get(String(drag)) : undefined;
  /** Where a pointer over a column would drop: the first card whose middle is below it. */
  const aim = (e: DragEvent<HTMLElement>) => {
    const others = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-kanban-card]")].filter((el) => el.dataset.kanbanCard !== String(drag));
    const under = others.find((el) => { const r = el.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    const next = { before: under?.dataset.kanbanCard ?? null, last: under ? null : others.at(-1)?.dataset.kanbanCard ?? null };
    setPlace((was) => (was?.before === next.before && was?.last === next.last ? was : next));
  };
  const move = (item: T, to: string) => {
    if (columnOf(item) === to || !canMove(item, to)) return;
    onMove(item, to);
    setSaid(`Moved to ${columns.find((c) => c.id === to)?.title ?? to}.`);
  };
  live.current = { columns, canMove, move, renderCard, onOpen, onSelect, keyboardMoves, refocus };
  const fade = edges.left || edges.right
    ? `linear-gradient(to right, ${edges.left ? "transparent, black 2rem" : "black"}, ${edges.right ? "black calc(100% - 2rem), transparent" : "black"})`
    : undefined;

  return (
    <div ref={root} className={cn("flex flex-col gap-2", COLUMN_BG, fill && "h-full min-h-0")}>
    {/* Phone: the columns as a strip of chips; tapping one scrolls the board to it. */}
    <nav ref={jumps} aria-label="Jump to a column" className="kit-scroll-x -mx-4 flex gap-2 px-4 md:hidden">
      {columns.map((col) => {
        const current = inView === col.id;
        return (
          <button key={col.id} type="button" data-kanban-jump={col.id} aria-current={current || undefined}
            onClick={() => root.current?.querySelector(`[data-kanban-column="${CSS.escape(col.id)}"]`)?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" })}
            className={cn("min-h-11 shrink-0 rounded-full border px-3 py-1 text-caption whitespace-nowrap focus-ring-inset",
              current ? "border-primary-text/40 bg-selected font-medium text-primary-text" : "bg-card hover:bg-muted/50")}>
            {col.title} <span className={cn("tabular-nums", !current && "text-muted-foreground")}>{items ? items.filter((i) => columnOf(i) === col.id).length : ""}</span>
          </button>
        );
      })}
    </nav>
    <p id={hint} hidden>Press Shift and an arrow key to move it{onOpen ? ", or Enter to open it" : ""}.</p>
    <div ref={strip} data-kit="kanban" data-signature-view={signature} aria-label={label} role="group"
      style={fade ? { maskImage: fade, WebkitMaskImage: fade } : undefined}
      className={cn("-mx-4 snap-x snap-mandatory scroll-px-4 overflow-x-auto overscroll-x-contain px-4 pb-2",
        "pointer-coarse:[scrollbar-width:none] pointer-coarse:[&::-webkit-scrollbar]:hidden",
        // Wide: the board only scrolls sideways; each column scrolls on its own (below).
        "md:mx-0 md:snap-none md:overflow-y-hidden md:px-0", fill && "min-h-0 flex-1")}>
      <p aria-live="polite" className="sr-only">{said}</p>
      {/* The row of columns, as tall as the tallest (up to a screen): every column's colour (and drop target) runs to the end. */}
      <div className={cn("flex w-max min-w-full gap-3 md:w-auto", fill && "h-full")}>
      {columns.map((col, ci) => {
        const list = (items ?? []).filter((i) => columnOf(i) === col.id);
        const tooMany = col.limit !== undefined && list.length > col.limit;
        // A drop target only for a card that can go there: never the column it came from.
        const accepts = dragged !== undefined && (!!onReorder || columnOf(dragged) !== col.id) && canMove(dragged, col.id);
        const lit = over === col.id && accepts;
        const late = items && overdueOf ? list.filter(overdueOf).length : 0;
        const drops = {
          onDragOver: (e: React.DragEvent<HTMLElement>) => { if (accepts) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(col.id); if (onReorder) aim(e); } },
          onDragLeave: (e: React.DragEvent<HTMLElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) { setOver(null); setPlace(null); } },
        };
        if (col.rail && wide && !opened.has(col.id)) return (
          <section key={col.id} aria-label={col.title} data-kanban-column={col.id} data-kanban-rail
            {...drops}
            onDrop={(e) => { e.preventDefault(); setOver(null); setDrag(null); setPlace(null); if (dragged && accepts) { move(dragged, col.id); setSaid(`Moved to ${col.title}.`); } }}
            className={cn("flex w-11 shrink-0 flex-col rounded-lg border bg-(--kanban-col)", fill && "h-full min-h-0", lit && "border-primary-text bg-selected")}>
            <button type="button" aria-expanded={false} title={`Show ${col.title}`}
              onClick={() => setOpened((o) => new Set(o).add(col.id))}
              className="flex flex-1 flex-col items-center gap-2 rounded-lg pt-3 text-caption text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-ring-inset">
              <span className="sr-only">Show </span>
              <span className="rounded-full bg-muted px-1.5 text-micro tabular-nums">{items ? list.length : "–"}</span>
              <span className="font-medium [writing-mode:vertical-rl]">{col.title}</span>
            </button>
          </section>
        );
        return (
          <section key={col.id} aria-label={col.title} data-kanban-column={col.id}
            {...drops}
            onDrop={(e) => {
              e.preventDefault(); setOver(null); setDrag(null);
              const landing = place; setPlace(null);
              if (!dragged || !accepts) return;
              if (!onReorder) { move(dragged, col.id); return; }
              onReorder(dragged, col.id, landing?.before ?? null);
              setSaid(`Moved to ${col.title}.`);
            }}
            // Wide: a card of its own, at most a screen tall: the header stays put and the list scrolls under it.
            className={cn("flex w-[85vw] shrink-0 snap-start flex-col gap-2 rounded-lg border bg-(--kanban-col) pb-1 sm:w-72 md:w-auto md:flex-1",
              fill ? "h-full min-h-0 md:min-w-44" : "md:min-w-56 md:max-h-[calc(100dvh-12rem)]", lit && "border-primary-text bg-selected")}>
            <header className="flex items-center justify-between gap-1 px-3 pt-3 pb-1">
              {/* One line in every column: a long stage name truncates (full on hover) before the count wraps under it. */}
              <div className="flex min-w-0 items-center gap-2">
                <StatusBadge tone={col.tone ?? "neutral"} dot className="min-w-0"><span className="truncate" title={col.title}>{col.title}</span></StatusBadge>
                <span data-kanban-count title={col.limit !== undefined ? `${list.length} of a limit of ${col.limit}${tooMany ? ": over the limit" : ""}` : undefined}
                  className={cn("shrink-0 rounded-full px-1.5 text-micro whitespace-nowrap tabular-nums", tooMany ? "bg-warning/15 font-medium text-warning" : "bg-muted text-muted-foreground")}>
                  <span aria-hidden>{items ? list.length : "–"}{col.limit !== undefined && ` / ${col.limit}`}</span>
                  <span className="sr-only">{items ? cards(list.length) : "Loading"}{col.limit !== undefined && `, limit ${col.limit}`}{tooMany && ", over the limit"}</span>
                </span>
              </div>
              {col.rail && wide && (
                <button type="button" aria-label={`Fold ${col.title} away`} title={`Fold ${col.title} away`} onClick={() => setOpened((o) => { const n = new Set(o); n.delete(col.id); return n; })}
                  className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-ring">
                  <ChevronsRight className="size-4" />
                </button>
              )}
              {onAdd && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" aria-label={`Add to ${col.title}`} data-kit="kanban-add" onClick={() => onAdd(col.id)}
                      className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-ring max-md:size-11">
                      <Plus className="size-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Add to {col.title}</TooltipContent>
                </Tooltip>
              )}
            </header>
            {/* The hint and the overdue count share the line under the header, so every column's header is one line. */}
            {(col.hint || late > 0) && (
              <p className="flex min-w-0 items-baseline gap-1.5 px-3 text-caption text-muted-foreground">
                {col.hint && <span data-kanban-total className="min-w-0 truncate text-body font-medium text-foreground tabular-nums" title={col.hint}>{col.hint}</span>}
                {late > 0 && <span data-kanban-overdue className="shrink-0 font-medium whitespace-nowrap text-warning">{col.hint && "· "}{late} overdue</span>}
              </p>
            )}
            {(() => {
              const card = (item: T, style?: React.CSSProperties, ref?: (el: Element | null) => void, index?: number) => {
                const k = itemKey(item);
                const targets = columns.filter((c) => c.id !== col.id && canMove(item, c.id));
                const movable = targets.length > 0 || !!onReorder;
                const isSelected = selected !== null && String(selected) === String(k);
                return (
                  <li key={k} ref={ref} data-index={index} style={style} draggable={movable} data-kanban-card={k} data-selected={isSelected || undefined}
                    data-drop={place && over === col.id ? (String(place.before) === String(k) ? "above" : String(place.last) === String(k) ? "below" : undefined) : undefined}
                    onDragStart={(e) => { setDrag(k); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(k)); }}
                    onDragEnd={() => { setDrag(null); setOver(null); setPlace(null); }}
                    className={cn(fill ? "group" : "group relative rounded-lg border bg-card text-body shadow-xs hover:border-foreground/15 data-[selected]:border-foreground/40", drag === k && "opacity-50")}>
                    <CardFace item={item} itemId={k} columnIndex={ci} targetIds={targets.map((c) => c.id).join("\n")} movable={movable} fill={fill} hint={hint} live={live} />
                  </li>
                );
              };
              const nothing = <li className="rounded-lg border border-dashed p-3 text-center text-caption text-muted-foreground">{emptyColumn}</li>;
              if (fill && items && list.length) return <VirtualCards list={list} itemKey={itemKey} card={card} keep={drag ?? selected} />;
              return (
                <ul data-kanban-list className={cn("flex min-h-16 flex-col gap-2 px-2 pb-1 md:min-h-0 md:flex-1 md:overflow-y-auto md:overscroll-y-contain", LIST_FADE)}>
                  {!items ? Array.from({ length: 3 }, (_, i) => <li key={`skeleton-${i}`}><Skeleton className="h-20 w-full rounded-lg" /></li>) : list.length === 0 ? nothing : list.map((item) => card(item))}
                </ul>
              );
            })()}
            {footer?.(col.id)}
          </section>
        );
      })}
      </div>
    </div>
    </div>
  );
}

/**
 * One card's anatomy, the same on every board: the title (two lines at most, the rest on hover), then a meta
 * line (the ID, priority, due date, and `extra` such as an agent-draft marker), with who's on it bottom-right.
 *
 *   renderCard={(d) => <KanbanCard title={d.name} id={`#${d.id}`} priority={d.priority} due={d.close_on} done={d.stage === "won"} assignee={owner?.name} />}
 */
export function KanbanCard({ title, id, amount, priority, due, done, assignee, extra }: {
  title: string;
  /** Shown in mono: "#25", "INV-0042". */
  id?: ReactNode;
  /** A figure the card is worth, such as a deal's value: first on the meta line, in the body face with tabular digits. */
  amount?: ReactNode;
  /** "urgent" | "high" get a mark (PriorityMark); anything else shows nothing. */
  priority?: string | null;
  /** A due day ("2026-10-06") or time: "Overdue · Mon 5 Oct" in warning once it's passed and not `done`. */
  due?: string | number | Date | null;
  done?: boolean;
  /** A name, several (stacked), or a face that says it's an agent. */
  assignee?: string | string[] | Exclude<Face, string> | null;
  extra?: ReactNode;
}) {
  const face = assignee && typeof assignee === "object" && !Array.isArray(assignee) ? assignee : null;
  const people = Array.isArray(assignee) ? assignee.filter(Boolean) : typeof assignee === "string" && assignee ? [assignee] : [];
  return (
    <div data-kit="kanban-card" className="flex min-w-0 flex-col gap-1.5">
      <span className="line-clamp-2 pr-6 font-medium wrap-anywhere" title={title}>{title}</span>
      <div className="flex min-h-5 items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-muted-foreground">
          {id !== undefined && id !== null && <span className="font-mono tabular-nums">{id}</span>}
          {amount !== undefined && amount !== null && <span className="font-medium text-foreground/80 tabular-nums">{amount}</span>}
          <PriorityMark level={priority} />
          <DueLabel value={due} done={done} className="min-w-0 truncate" />
          {extra}
        </div>
        {face ? <Avatar name={face.name} kind={face.kind} size="xs" className="shrink-0" /> : people.length === 1 ? <Avatar name={people[0]} size="xs" /> : people.length > 1 ? <AvatarStack names={people} size="xs" /> : null}
      </div>
    </div>
  );
}

import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Search, type LucideIcon } from "lucide-react";
import { shortcutText, useShortcut } from "@/lib/commands";
import { perf } from "@/lib/perf";
import { cn } from "@/lib/utils";

export interface PaletteItem {
  id: string;
  label: string;
  /** "Go to", "Actions", "Notes"… Items show grouped in the order their groups first appear. */
  group: string;
  icon?: LucideIcon;
  /** Context beside the label: a status, an owner, a date. */
  hint?: string;
  /** A second line: the words around what matched. */
  detail?: string;
  keywords?: string[];
  /** A shortcut from the registry ("mod+k", "g t"), shown at the row's end. */
  shortcut?: string;
  run: () => void;
}

// The palette is mounted with the shell and shown by the browser's own modal <dialog>, which brings the focus trap, the
// inert page, Escape and focus return. Opening it runs no React at all: ⌘K has a 50 ms budget at 4x throttle, and
// rendering a Radix dialog and its list on the key press spent all of it. Its rows arrive just after the first paint: nobody
// can press ⌘K before that, so they stay out of the shell and are still rendered and waiting when the key comes.
const PaletteBody = lazy(() => import("./palette-body"));
let dialog: HTMLDialogElement | null = null;
let input: HTMLInputElement | null = null;

export const isCommandPaletteOpen = () => !!dialog?.open;
/** Open the palette from anywhere (a header button, a first-run step). */
export function openCommandPalette() {
  if (!dialog || dialog.open) return;
  perf.start("palette-open");
  dialog.showModal();
  input?.focus();
  perf.endAfterPaint("palette-open");
}
export const closeCommandPalette = () => dialog?.close();
/** The rows say where their input is. One that arrives after a very fast ⌘K takes the focus it missed. */
export function setPaletteInput(el: HTMLInputElement | null) {
  input = el;
  if (el && dialog?.open) el.focus();
}
export const toggleCommandPalette = () => (isCommandPaletteOpen() ? closeCommandPalette() : openCommandPalette());

/**
 * ⌘K / Ctrl K: jump to any screen, run an action, or find a record. `items` are the static ones (the registry's
 * commands); `search` finds records as the person types (debounced, newest answer wins).
 */
export function CommandPalette({ items, search, recents, noMatch, placeholder = "Search or jump to…" }: {
  items: PaletteItem[]; search?: (q: string) => Promise<PaletteItem[]>;
  /** Shown before anything is typed, with `items`. */
  recents?: () => Promise<PaletteItem[]>;
  /** What can still be done with these words when nothing matched. */
  noMatch?: (q: string) => PaletteItem[];
  placeholder?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [session, setSession] = useState(0);
  const [ready, setReady] = useState(false);
  useEffect(() => { dialog = ref.current; return () => { dialog = null; }; }, []);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 0);
    return () => clearTimeout(t);
  }, []);
  return (
    <dialog ref={ref} aria-label="Search" data-kit="palette-dialog"
      onClose={() => setSession((n) => n + 1)}
      onClick={(e) => { if (e.target === e.currentTarget) closeCommandPalette(); }}
      className="top-[12svh] mx-auto w-[calc(100%-2rem)] max-w-lg overflow-hidden rounded-lg border bg-popover p-0 text-popover-foreground shadow-lg backdrop:bg-black/40">
      {ready && <Suspense fallback={null}><PaletteBody key={session} items={items} search={search} recents={recents} noMatch={noMatch} placeholder={placeholder} /></Suspense>}
    </dialog>
  );
}

/** The header's search button: opens the palette, and says how to open it from the keyboard. */
export function PaletteButton({ className, label = "Search" }: { className?: string; label?: string }) {
  const shortcut = useShortcut("palette.toggle");
  const keys = shortcut ? shortcutText(shortcut) : "";
  return (
    <button type="button" onClick={openCommandPalette} data-kit="palette-button"
      className={cn("inline-flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-3 text-body text-muted-foreground transition-colors hover:bg-muted/50 focus-ring sm:w-64 sm:flex-none", className)}>
      <Search aria-hidden className="size-4 shrink-0" />
      <span className="truncate">{label}…</span>
      {keys && <kbd className="ml-auto hidden rounded border px-1.5 font-mono text-micro sm:inline">{keys}</kbd>}
      {keys && <span className="sr-only">Open search ({keys})</span>}
    </button>
  );
}

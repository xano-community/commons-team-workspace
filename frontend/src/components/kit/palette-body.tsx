import { useEffect, useMemo, useRef, useState } from "react";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { shortcutText } from "@/lib/commands";
import { marks, matches } from "@/lib/search/model";
import { closeCommandPalette, setPaletteInput, type PaletteItem } from "./command-palette";

const WAIT_MS = 150;
const SHORTEST = 2;

function Marked({ text, q }: { text: string; q: string }) {
  return <>{marks(text, q).map((m, i) => (m.hit ? <span key={i} className="font-medium text-foreground">{m.text}</span> : m.text))}</>;
}

/**
 * The rows and the input. It starts again on each close, so the next open is at the top with nothing typed. The server has
 * already decided what matches, so cmdk's own filter is off and this keeps the order it was given. Static commands are filtered
 * here, by word, and sit under the records they'd otherwise bury.
 */
export default function PaletteBody({ items, search, recents, noMatch, placeholder }: {
  items: PaletteItem[]; search?: (q: string) => Promise<PaletteItem[]>; recents?: () => Promise<PaletteItem[]>; noMatch?: (q: string) => PaletteItem[]; placeholder: string;
}) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<PaletteItem[]>([]);
  const [recent, setRecent] = useState<PaletteItem[]>([]);
  // A record search is in flight: say so, never "No results" before the answer is in.
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [active, setActive] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setPaletteInput(inputRef.current); return () => setPaletteInput(null); }, []);
  useEffect(() => { recents?.().then(setRecent, () => setRecent([])); }, [recents]);

  const wanted = q.trim();
  useEffect(() => {
    setFailed(false);
    if (!search || wanted.length < SHORTEST) { setFound([]); setSearching(false); return; }
    let live = true;
    setSearching(true);
    const t = setTimeout(() => {
      search(wanted).then(
        (r) => { if (live) { setFound(r); setSearching(false); } },
        () => { if (live) { setFound([]); setFailed(true); setSearching(false); } },
      );
    }, WAIT_MS);
    return () => { live = false; clearTimeout(t); };
  }, [wanted, search, attempt]);

  const groups = useMemo(() => {
    const commands = wanted ? items.filter((it) => matches(wanted, it.label, it.hint, it.group, ...(it.keywords ?? []))) : items;
    const nothing = wanted.length >= SHORTEST && !searching && !failed && !found.length && !commands.length;
    // A command someone is typing the name of goes first, so "new task" and Enter never lands on a record called that.
    const named = wanted ? commands.filter((it) => it.label.toLowerCase().startsWith(wanted.toLowerCase())) : [];
    const all = [...named, ...(wanted ? found : recent), ...commands.filter((it) => !named.includes(it)), ...(nothing ? [...(noMatch?.(wanted) ?? []), ...items.filter((it) => it.group === "Actions")] : [])];
    const m = new Map<string, PaletteItem[]>();
    for (const it of all) m.set(it.group, [...(m.get(it.group) ?? []), it]);
    return { list: [...m.entries()], nothing };
  }, [items, found, recent, wanted, searching, failed, noMatch]);

  // cmdk keeps its place by value, so the first row of a new answer has to be chosen here.
  const first = groups.list[0]?.[1][0]?.id ?? "";
  useEffect(() => { setActive(first); }, [first]);

  return (
    <Command shouldFilter={false} value={active} onValueChange={setActive} className="**:data-[slot=command-input-wrapper]:h-11 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-1.5">
      <CommandInput ref={inputRef} placeholder={placeholder} value={q} onValueChange={setQ} data-kit="command-input" />
      <CommandList data-kit="command-palette" className="max-h-[min(24rem,60svh)]">
        {groups.nothing && <p data-testid="search-empty" className="px-3 pt-4 pb-2 text-center text-body">Nothing matches “{wanted}”. <span className="text-muted-foreground">You can still:</span></p>}
        {failed && (
          <div role="alert" data-testid="search-failed" className="flex items-center justify-center gap-2 px-3 py-4 text-caption text-muted-foreground">
            Search didn't load.
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className="rounded-sm font-medium text-foreground underline underline-offset-2 focus-ring">Try again</button>
          </div>
        )}
        {groups.list.map(([group, list]) => (
          <CommandGroup key={group} heading={group}>
            {list.map((it) => {
              const Icon = it.icon;
              return (
                <CommandItem key={it.id} value={it.id} onSelect={() => { closeCommandPalette(); it.run(); }} data-kit="palette-row">
                  {Icon && <Icon aria-hidden className="text-muted-foreground" />}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="min-w-0 truncate" title={it.label}>{it.label}</span>
                      {it.hint && <span className="min-w-0 shrink-0 truncate text-caption text-muted-foreground">{it.hint}</span>}
                    </span>
                    {it.detail && <span className="min-w-0 truncate text-caption text-muted-foreground"><Marked text={it.detail} q={wanted} /></span>}
                  </span>
                  {it.shortcut && <CommandShortcut>{shortcutText(it.shortcut)}</CommandShortcut>}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
        {searching && <div role="status" className="px-3 py-4 text-center text-caption text-muted-foreground">Searching…</div>}
      </CommandList>
    </Command>
  );
}

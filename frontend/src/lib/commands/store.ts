// The live command list and the one key handler. Screens register while mounted; everything that shows a command reads
// the same list.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { findClashes, matchesStep, normalizeShortcut, SCOPES, type Command } from "./registry";

const CHORD_MS = 1200;
let commands: Command[] = [];
const listeners = new Set<() => void>();
const publish = () => { commands = [...commands]; listeners.forEach((fn) => fn()); };

/** Adds commands until the returned function runs. A second command with an id replaces the first. */
export function registerCommands(list: Command[]): () => void {
  const ids = new Set(list.map((c) => c.id));
  const next = [...commands.filter((c) => !ids.has(c.id)), ...list];
  if (import.meta.env.DEV) {
    const clash = findClashes(next)[0];
    if (clash) throw new Error(`Shortcut clash on ${clash.shortcut}: ${clash.ids.join(", ")} (${clash.why})`);
  }
  commands = next;
  publish();
  return () => { commands = commands.filter((c) => !list.includes(c)); publish(); };
}

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const useCommandList = () => useSyncExternalStore(subscribe, () => commands);
export const commandById = (id: string) => commands.find((c) => c.id === id);
/** The key a command is on right now, for a tooltip or a menu. */
export const useShortcut = (id: string) => useCommandList().find((c) => c.id === id)?.shortcut;

/**
 * Registers commands for as long as the component is mounted. Their `run` and `when` may close over fresh state: the
 * registered copy always calls the latest. `key` says when the list itself has changed.
 */
export function useCommands(list: Command[], key: string) {
  const latest = useRef(list);
  latest.current = list;
  useEffect(() => registerCommands(latest.current.map((c, i) => ({
    ...c,
    run: () => latest.current[i]?.run(),
    when: c.when && (() => latest.current[i]?.when?.() ?? true),
  }))), [key]);
}

/** Is the person typing somewhere, so a single-key shortcut must not fire? */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || !!el.closest?.("[role=dialog] input, [cmdk-input]");
}

const modalOpen = () => !!document.querySelector('dialog[open], [role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]');
const rank = (c: Command) => SCOPES.indexOf(c.scope);

/** The one keydown handler, for the whole app. Returns the function that removes it. */
export function listenForCommands(target: Window = window): () => void {
  let chordStart = "";
  let chordAt = 0;
  const on = (e: KeyboardEvent) => {
    if (e.isComposing || e.defaultPrevented) return;
    const typing = isTyping(e.target);
    const inChord = chordStart && Date.now() - chordAt < CHORD_MS;
    // A plain key while typing can only be text: every shortcut that works in a field starts with mod. Return before any
    // work, because this runs on every key pressed in a composer.
    if (typing && !inChord && !e.metaKey && !e.ctrlKey) { chordStart = ""; return; }
    const modal = modalOpen();
    const live = commands
      .filter((c) => c.shortcut && (!modal || c.scope === "modal") && (c.when?.() ?? true))
      .map((c) => ({ c, steps: normalizeShortcut(c.shortcut!).split(" ") }))
      .filter(({ steps }) => !typing || steps[0].includes("mod+"))
      .sort((a, b) => rank(a.c) - rank(b.c));
    const started = chordStart;
    chordStart = "";
    if (inChord) {
      const hit = live.find(({ steps }) => steps.length === 2 && steps[0] === started && matchesStep(e, steps[1]));
      if (hit) { e.preventDefault(); hit.c.run(); return; }
    }
    const single = live.find(({ steps }) => steps.length === 1 && matchesStep(e, steps[0]));
    if (single) { e.preventDefault(); single.c.run(); return; }
    const opening = live.find(({ steps }) => steps.length === 2 && matchesStep(e, steps[0]));
    if (opening) { chordStart = opening.steps[0]; chordAt = Date.now(); }
  };
  target.addEventListener("keydown", on);
  return () => target.removeEventListener("keydown", on);
}

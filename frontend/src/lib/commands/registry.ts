// One command registry. A command has an id, a label, a shortcut, a scope and a `when()`, and that one record feeds the
// key handler, ⌘K, menus, tooltips and the "?" sheet, so a shortcut can't be shown in one place and differ in another.
import type { LucideIcon } from "lucide-react";

/** Narrowest first. While a modal is open only modal commands run; otherwise the narrowest match wins. */
export const SCOPES = ["modal", "editor", "panel", "screen", "global"] as const;
export type Scope = (typeof SCOPES)[number];

export interface Command {
  id: string;
  label: string;
  /** "mod+k", "?", "g o" (a chord: g, then o), "shift+arrowleft". `mod` is ⌘ on a Mac and Ctrl elsewhere. */
  shortcut?: string;
  scope: Scope;
  /** The ⌘K heading. A command with no group stays out of ⌘K. */
  group?: string;
  icon?: LucideIcon;
  hint?: string;
  keywords?: string[];
  /** Off when this says so, everywhere at once: the key does nothing and ⌘K doesn't list it. */
  when?: () => boolean;
  run: () => void;
}

export type Clash = { shortcut: string; ids: string[]; why: string };

/** Keys a browser keeps for itself or a person relies on: an app that binds them breaks the browser. */
const RESERVED = new Set(["mod+l", "mod+n", "mod+q", "mod+r", "mod+t", "mod+w"]);

const MODIFIERS = ["mod", "ctrl", "alt", "shift"];
/** One spelling per shortcut: "Shift+Mod+K" and "mod+shift+k" are the same key. */
export function normalizeShortcut(shortcut: string): string {
  return shortcut.trim().split(/\s+/).map((step) => {
    const parts = step === "+" ? ["+"] : step.toLowerCase().split("+");
    const key = parts.pop()!;
    return [...MODIFIERS.filter((m) => parts.includes(m)), key].join("+");
  }).join(" ");
}

const isChord = (s: string) => s.includes(" ");

/**
 * What can't be allowed to ship. Each is a key that would do something other than what the UI says:
 *   the same key twice in one scope, on any screen, so a key keeps its meaning from screen to screen;
 *   a screen or panel key hiding a global one (a modal or an editor may, they own the keyboard while open);
 *   a single key that swallows a chord's first step, so the chord can never run;
 *   a key the browser keeps.
 */
export function findClashes(commands: Pick<Command, "id" | "shortcut" | "scope">[]): Clash[] {
  const bound = commands.filter((c) => c.shortcut).map((c) => ({ ...c, key: normalizeShortcut(c.shortcut!) }));
  const clashes: Clash[] = [];
  bound.forEach((a, i) => {
    if (RESERVED.has(a.key)) clashes.push({ shortcut: a.key, ids: [a.id], why: "the browser keeps this key" });
    for (const b of bound.slice(i + 1)) {
      if (a.id === b.id) continue;
      const ids = [a.id, b.id];
      if (a.key === b.key && a.scope === b.scope) clashes.push({ shortcut: a.key, ids, why: `both are ${a.scope} commands` });
      else if (a.key === b.key && [a.scope, b.scope].includes("global") && ![a.scope, b.scope].some((s) => s === "modal" || s === "editor")) {
        clashes.push({ shortcut: a.key, ids, why: "it hides a global command" });
      }
      const [short, long] = isChord(a.key) ? [b, a] : [a, b];
      if (isChord(long.key) && !isChord(short.key) && long.key.split(" ")[0] === short.key) {
        clashes.push({ shortcut: short.key, ids, why: `it swallows the chord ${long.key}` });
      }
    }
  });
  return clashes;
}

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Does this key press match one step ("mod+k", "?", "shift+arrowleft")? A symbol carries its own shift. */
export function matchesStep(e: KeyboardEvent, step: string): boolean {
  const parts = step === "+" ? ["+"] : step.split("+");
  const key = parts.pop()!;
  if (e.key.toLowerCase() !== key) return false;
  const mod = parts.includes("mod");
  if ((e.metaKey || e.ctrlKey) !== mod || e.altKey !== parts.includes("alt")) return false;
  return /^[a-z0-9]|^arrow|^backspace/.test(key) ? e.shiftKey === parts.includes("shift") : true;
}

const KEY_NAMES: Record<string, string> = { arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓", escape: "Esc", enter: "Enter", backspace: "⌫" };
function keyLabel(step: string): string {
  const parts = step === "+" ? ["+"] : step.split("+");
  const key = parts.pop()!;
  const name = KEY_NAMES[key] ?? key.toUpperCase();
  const mac = isMac();
  const mods = parts.map((m) => (m === "mod" ? (mac ? "⌘" : "Ctrl") : m === "shift" ? (mac ? "⇧" : "Shift") : m === "alt" ? (mac ? "⌥" : "Alt") : m));
  return mac ? [...mods, name].join("") : [...mods, name].join(" ");
}

/** The shortcut as keycaps, one per step: "mod+k" → ["⌘K"], "g o" → ["G", "O"]. */
export const shortcutKeys = (shortcut: string): string[] => normalizeShortcut(shortcut).split(" ").map(keyLabel);
/** The shortcut in words, for a tooltip or a label: "⌘K", "G then O". */
export const shortcutText = (shortcut: string): string => shortcutKeys(shortcut).join(" then ");

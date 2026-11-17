// The shortcuts the shell itself owns, and the pinned "g" letters. Every screen's own keys are in catalog.ts, which loads with
// the screens, so the shell doesn't carry them.
import type { Command, Scope } from "./registry";

export type Entry = Pick<Command, "label" | "shortcut"> & { scope: Scope };

/** "g" then a letter goes to a screen. The letters are pinned: adding a screen never moves anyone's muscle memory. */
export const NAV_KEYS = {
  "/inbox": "i",
  "/": "o",
  "/tasks": "t",
  "/docs": "d",
  "/crm": "c",
  "/files": "f",
  "/chat": "h",
  "/approvals": "a",
  "/agents": "e",
  "/team": "m",
  "/activity": "y",
  "/settings": "s",
  "/profile": "p",
} as const;
export type PinnedHref = keyof typeof NAV_KEYS;

export const SHELL_CATALOG = {
  "palette.toggle": { label: "Search, jump anywhere, run an action", shortcut: "mod+k", scope: "global" },
  "palette.close": { label: "Close search", shortcut: "mod+k", scope: "modal" },
  "shortcuts.open": { label: "Keyboard shortcuts", shortcut: "?", scope: "global" },
  "sidebar.toggle": { label: "Show or hide the sidebar", shortcut: "mod+b", scope: "global" },
  "theme.toggle": { label: "Switch light / dark", shortcut: "mod+shift+l", scope: "global" },
  "assistant.ask": { label: "Ask the assistant", shortcut: "mod+j", scope: "global" },
} as const satisfies Record<string, Entry>;

export const navCommandId = (href: string) => `nav.${href}`;

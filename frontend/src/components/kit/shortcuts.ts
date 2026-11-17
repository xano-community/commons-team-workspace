import { useCommands } from "@/lib/commands";

export { isTyping } from "@/lib/commands";

/**
 * A keyboard shortcut for one screen, through the command registry: `key` is KeyboardEvent.key ("n", "/"), and `mod`
 * means ⌘ on a Mac, Ctrl elsewhere. Give it a `label` and the "?" sheet lists it. Single keys are ignored while the
 * person is typing; `mod` shortcuts always work.
 */
export function useHotkey(key: string, handler: () => void, opts: { mod?: boolean; enabled?: boolean; label?: string } = {}) {
  const { mod = false, enabled = true, label = "" } = opts;
  const shortcut = `${mod ? "mod+" : ""}${key.toLowerCase()}`;
  useCommands(enabled ? [{ id: `hotkey.${shortcut}`, label, shortcut, scope: "screen", run: handler }] : [], `${shortcut}|${enabled}|${label}`);
}

/** "⌘K" on a Mac, "Ctrl K" elsewhere. */
export const modKey = (k: string) =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? `⌘${k}` : `Ctrl ${k}`;

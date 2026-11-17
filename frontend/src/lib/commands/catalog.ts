// Every shortcut in the app, in one table, so the clash test sees them all without opening a screen. A screen registers
// its command by id and takes the key and the scope from here. Tools add their rows when they're built.
import { NAV_KEYS, SHELL_CATALOG, navCommandId, type Entry } from "./shell-catalog";

export const CATALOG = {
  ...SHELL_CATALOG,
  "list.search": { label: "Search the list you're on", shortcut: "/", scope: "screen" },
  "list.next": { label: "Next row", shortcut: "j", scope: "screen" },
  "list.previous": { label: "Previous row", shortcut: "k", scope: "screen" },
  "list.close": { label: "Close the open record", shortcut: "escape", scope: "panel" },
  "list.next-arrow": { label: "Next row", shortcut: "arrowdown", scope: "screen" },
  "list.previous-arrow": { label: "Previous row", shortcut: "arrowup", scope: "screen" },
  "list.open": { label: "Open the selected row", shortcut: "enter", scope: "screen" },
  "inbox.clear": { label: "Clear from the inbox", shortcut: "e", scope: "screen" },
  "inbox.read-all": { label: "Mark all read", shortcut: "shift+u", scope: "screen" },
  "chat.compose": { label: "Write a message", shortcut: "c", scope: "screen" },
  "chat.reply": { label: "Reply in a thread", shortcut: "r", scope: "screen" },
  "chat.edit": { label: "Edit the selected message", shortcut: "shift+e", scope: "screen" },
  "chat.delete": { label: "Delete the selected message", shortcut: "shift+d", scope: "screen" },
  "chat.latest": { label: "Jump to the latest message", shortcut: "shift+g", scope: "screen" },
  "chat.next-unread": { label: "Next unread conversation", shortcut: "alt+arrowdown", scope: "screen" },
  "tasks.new": { label: "New task", shortcut: "n", scope: "screen" },
  "tasks.toggle-view": { label: "Switch between list and board", shortcut: "v", scope: "screen" },
  "tasks.status": { label: "Change status", shortcut: "s", scope: "screen" },
  "tasks.priority": { label: "Change priority", shortcut: "p", scope: "screen" },
  "tasks.assign": { label: "Assign to someone", shortcut: "a", scope: "screen" },
  "tasks.assign-me": { label: "Assign to me", shortcut: "i", scope: "screen" },
  "tasks.due": { label: "Set the due date", shortcut: "d", scope: "screen" },
  "tasks.edit": { label: "Edit the title and description", shortcut: "w", scope: "screen" },
  "tasks.delete": { label: "Delete the task", shortcut: "shift+backspace", scope: "screen" },
  "tasks.move-up": { label: "Move the card up", shortcut: "shift+arrowup", scope: "screen" },
  "tasks.move-down": { label: "Move the card down", shortcut: "shift+arrowdown", scope: "screen" },
  "tasks.move-left": { label: "Move the card to the column on the left", shortcut: "shift+arrowleft", scope: "screen" },
  "tasks.move-right": { label: "Move the card to the column on the right", shortcut: "shift+arrowright", scope: "screen" },
  "tasks.column-left": { label: "Select the card to the left", shortcut: "arrowleft", scope: "screen" },
  "tasks.column-right": { label: "Select the card to the right", shortcut: "arrowright", scope: "screen" },
  "docs.apply": { label: "Apply the agent's suggestion", shortcut: "alt+enter", scope: "screen" },
  "docs.dismiss": { label: "Dismiss the agent's suggestion", shortcut: "alt+shift+enter", scope: "screen" },
  "composer.send": { label: "Send", shortcut: "enter", scope: "editor" },
  "composer.newline": { label: "New line", shortcut: "shift+enter", scope: "editor" },
  "composer.edit-last": { label: "Edit your last message", shortcut: "arrowup", scope: "editor" },
} as const satisfies Record<string, Entry>;
export type CatalogId = keyof typeof CATALOG;

/** The table as commands, for the clash test and the "?" sheet's rows that have no live command. */
export const catalogCommands = (): (Entry & { id: string })[] => [
  ...Object.entries(CATALOG).map(([id, e]) => ({ id, ...e })),
  ...Object.entries(NAV_KEYS).map(([href, key]) => ({ id: navCommandId(href), label: `Go to ${href}`, shortcut: `g ${key}`, scope: "global" as const })),
];

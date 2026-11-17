// What this app adds to the editor. Each piece works around the person's typing, never through it: the highlight is a decoration,
// so it can't touch the text or the cursor, and the keys that act on a suggestion do nothing unless one is waiting.
import { useMemo, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Extension, NodeViewWrapper, ReactNodeViewRenderer, type Editor, type NodeViewProps } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Suggestion } from "@tiptap/suggestion";
import { RecordMention } from "@xano-sdk/docs/react";
import { Hash, type LucideIcon } from "lucide-react";
import { RecordChip } from "@/components/workspace/link-chip";
import { findTarget } from "@/lib/docs/target";
import { cn } from "@/lib/utils";

const marked = new PluginKey<string>("doc-suggestion-target");

/** Marks the words a waiting suggestion would change. Empty marks nothing. */
const Highlight = Extension.create({
  name: "docSuggestionTarget",
  addProseMirrorPlugins: () => [new Plugin<string>({
    key: marked,
    state: { init: () => "", apply: (tr, find) => (tr.getMeta(marked) as string | undefined) ?? find },
    props: {
      decorations(state) {
        const target = findTarget(state.doc, marked.getState(state) ?? "");
        return target ? DecorationSet.create(state.doc, [Decoration.inline(target.from, target.to, { class: "doc-suggestion-target", "data-testid": "suggestion-target" })]) : null;
      },
    },
  })],
});

export const highlight = (editor: Editor, find: string) => {
  if (marked.getState(editor.state) !== find) editor.view.dispatch(editor.state.tr.setMeta(marked, find).setMeta("addToHistory", false));
};

/** Brings the words into view. The cursor stays where it is. */
export const reveal = (editor: Editor) => {
  const el = editor.view.dom.querySelector(".doc-suggestion-target");
  el?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
};

export type SuggestionKeys = { apply: (() => void) | null; dismiss: (() => void) | null };

const Keys = (keys: SuggestionKeys) => Extension.create({
  name: "docSuggestionKeys",
  addKeyboardShortcuts: () => ({
    "Alt-Enter": () => { if (!keys.apply) return false; keys.apply(); return true; },
    "Shift-Alt-Enter": () => { if (!keys.dismiss) return false; keys.dismiss(); return true; },
  }),
});

/** A link in the body: only `{ type, id }` is stored, and the chip asks who's looking what they may see. */
function RecordView({ node }: NodeViewProps) {
  return <NodeViewWrapper as="span" className="doc-record" contentEditable={false} data-testid="doc-record"><RecordChip type={String(node.attrs.type)} id={Number(node.attrs.id)} className="align-baseline" /></NodeViewWrapper>;
}
const RecordNode = RecordMention.extend({ addNodeView: () => ReactNodeViewRenderer(RecordView, { as: "span" }) });

export type RecordOption = { type: string; id: number; title: string; icon: LucideIcon };
type Picking = { items: RecordOption[]; index: number; rect: DOMRect | null; choose: ((o: RecordOption) => void) | null; query: string };
const CLOSED: Picking = { items: [], index: 0, rect: null, choose: null, query: "" };

/** "#" in the body, like "#" in a composer: finds a task or a doc as the person types, and drops in a link. */
function createPicker(search: (q: string) => Promise<RecordOption[]>) {
  let now = CLOSED;
  const listeners = new Set<() => void>();
  const set = (next: Picking) => { now = next; for (const l of listeners) l(); };
  const extension = Extension.create({
    name: "docRecordPicker",
    addProseMirrorPlugins() {
      const editor = this.editor;
      return [Suggestion<RecordOption>({
        editor, char: "#", pluginKey: new PluginKey("doc-record-picker"), allowSpaces: true,
        items: async ({ query }) => (query.length < 2 ? [] : search(query).catch(() => [])),
        command: ({ editor: e, range, props }) => { e.chain().focus().insertContentAt(range, [{ type: "recordMention", attrs: { type: props.type, id: props.id } }, { type: "text", text: " " }]).run(); },
        render: () => {
          const show = (p: { items: RecordOption[]; clientRect?: (() => DOMRect | null) | null; command: (o: RecordOption) => void; query: string }) => set({ items: p.items, index: 0, rect: p.clientRect?.() ?? null, choose: p.command, query: p.query });
          return {
            onStart: show, onUpdate: show, onExit: () => set(CLOSED),
            onKeyDown: ({ event }) => {
              if (!now.items.length) return false;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") { const step = event.key === "ArrowDown" ? 1 : -1; set({ ...now, index: (now.index + step + now.items.length) % now.items.length }); return true; }
              if (event.key === "Enter" || event.key === "Tab") { now.choose?.(now.items[now.index]); return true; }
              if (event.key === "Escape") { set(CLOSED); return true; }
              return false;
            },
          };
        },
      })];
    },
  });
  return { extension, subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; }, get: () => now };
}

export type Picker = ReturnType<typeof createPicker>;

export function RecordPicker({ picker }: { picker: Picker }) {
  const state = useSyncExternalStore(picker.subscribe, picker.get);
  if (!state.rect || !state.choose) return null;
  const { items, index, rect, choose, query } = state;
  // A "#" that was only ever a hash: past a space with nothing to find, it stops asking.
  if (!items.length && query.includes(" ")) return null;
  const below = rect.bottom + 6;
  return createPortal(
    <div role="listbox" aria-label="Link to a record" data-testid="doc-record-menu" style={{ top: Math.min(below, innerHeight - 240), left: Math.min(rect.left, innerWidth - 296) }} className="fixed z-50 w-72 max-w-[calc(100vw-1rem)] rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
      {!items.length && <p className="px-2 py-1.5 text-caption text-muted-foreground">{query.length < 2 ? "Type to find a task or a doc" : "Nothing matches"}</p>}
      {items.map((o, i) => { const Icon = o.icon ?? Hash; return (
        <button key={`${o.type}-${o.id}`} type="button" role="option" aria-selected={i === index} data-testid="doc-record-option" onMouseDown={(e) => { e.preventDefault(); choose(o); }}
          className={cn("flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-left text-body max-md:min-h-11", i === index && "bg-selected")}><Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{o.title}</span></button>
      ); })}
    </div>,
    document.body,
  );
}

/** Made once per doc: the editor reads its extensions when it's created. */
export function useDocExtensions(search: (q: string) => Promise<RecordOption[]>) {
  return useMemo(() => {
    const keys: SuggestionKeys = { apply: null, dismiss: null };
    const picker = createPicker(search);
    return { keys, picker, extensions: [RecordNode, Highlight, Keys(keys), picker.extension] };
  }, [search]);
}

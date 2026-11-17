// Finding the words an agent wants to change, in the editor as it is now, typing included. It uses the same rule as the server:
// exactly one match inside one block. A match that crosses a bold is fine, a mention holds no words, and two matches can't be
// told apart, so a change whose words have moved or multiplied offers Dismiss and nothing else.
import type { Node, Schema } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";

/** Stands in for a mention or a link inside a block's text, so a search can't reach across one. */
const NOT_TEXT = "￼";

export type Range = { from: number; to: number };
export type Change = { find: string; text: string; blocks: unknown[] };

export function findTarget(doc: Node, find: string): Range | null {
  if (!find) return null;
  let found: Range | null = null;
  let matches = 0;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = node.textBetween(0, node.content.size, undefined, NOT_TEXT);
    for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + 1)) {
      matches += 1;
      found = { from: pos + 1 + at, to: pos + 1 + at + find.length };
    }
    return false;
  });
  return matches === 1 ? found : null;
}

/** An addition's blocks as this editor's nodes. One it can't show is left out: an addition never stops at a bad block. */
export function addedBlocks(schema: Schema, blocks: unknown[]): Node[] {
  return blocks.flatMap((block) => {
    try { return [schema.nodeFromJSON(block)]; } catch { return []; }
  });
}

/** Words that bring marks of their own, on top of whatever the words they replace carried. Null when this editor can't show them. */
function replaceWithMarks(state: EditorState, change: Change, target: Range): Transaction | null {
  if (!change.blocks.length) return null;
  try {
    const around = state.doc.resolve(target.from + 1).marks();
    const nodes = change.blocks.map((block) => {
      const node = state.schema.nodeFromJSON(block);
      return node.mark(around.reduce((marks, mark) => mark.addToSet(marks), node.marks));
    });
    return state.tr.replaceWith(target.from, target.to, nodes);
  } catch {
    return null;
  }
}

/**
 * The edit that makes a change, as an ordinary transaction: it maps the person's cursor, it undoes with Cmd-Z, and autosave
 * sends it as theirs. Null means the words have gone, and nothing should happen.
 */
export function applySuggestion(state: EditorState, change: Change): Transaction | null {
  if (!change.find) {
    const nodes = addedBlocks(state.schema, change.blocks);
    return nodes.length ? state.tr.insert(state.doc.content.size, nodes) : null;
  }
  const target = findTarget(state.doc, change.find);
  if (!target) return null;
  return replaceWithMarks(state, change, target) ?? state.tr.insertText(change.text, target.from, target.to);
}

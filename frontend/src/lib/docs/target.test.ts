import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { addedBlocks, applySuggestion, findTarget } from "./target";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", toDOM: () => ["p", 0] },
    text: { group: "inline" },
    mention: { group: "inline", inline: true, atom: true, attrs: { id: { default: 0 } }, toDOM: () => ["span"] },
  },
  marks: { bold: { toDOM: () => ["b", 0] } },
});
const p = (...content: (string | ReturnType<typeof schema.text> | ReturnType<typeof schema.node>)[]) => schema.node("paragraph", null, content.map((c) => (typeof c === "string" ? schema.text(c) : c)));
const doc = (...blocks: ReturnType<typeof p>[]) => schema.node("doc", null, blocks);
const state = (d: ReturnType<typeof doc>, at?: number) => { const s = EditorState.create({ doc: d, schema }); return at ? s.apply(s.tr.setSelection(TextSelection.create(d, at))) : s; };
const bold = (text: string) => schema.text(text, [schema.marks.bold.create()]);

describe("findTarget", () => {
  it("finds words inside one block", () => {
    const t = findTarget(doc(p("Ship on the 14th of March.")), "14th of March");
    expect(t).toEqual({ from: 13, to: 26 });
  });
  it("finds words that cross a bold", () => {
    expect(findTarget(doc(p("Ship on the ", bold("14th"), " of March.")), "14th of March")).toEqual({ from: 13, to: 26 });
  });
  it("won't span a mention, which holds no words of its own", () => {
    expect(findTarget(doc(p("Ask ", schema.node("mention"), " today")), "Ask  today")).toBeNull();
  });
  it("won't span two blocks", () => {
    expect(findTarget(doc(p("One"), p("two")), "Onetwo")).toBeNull();
  });
  it("gives up on words that have gone", () => {
    expect(findTarget(doc(p("Ship whenever.")), "14th of March")).toBeNull();
  });
  it("gives up on words that now appear twice, because it can't know which was meant", () => {
    expect(findTarget(doc(p("Ship it."), p("Ship it.")), "Ship it")).toBeNull();
    expect(findTarget(doc(p("Ship it. Ship it.")), "Ship it")).toBeNull();
  });
});

describe("applySuggestion, with marks of its own", () => {
  const change = { find: "14th", text: "21st", blocks: [{ type: "text", text: "21st", marks: [{ type: "bold" }] }] };
  it("puts the words in with their marks, and undoes as one step", () => {
    const before = state(doc(p("Ship on the 14th of March.")));
    const after = before.apply(applySuggestion(before, change)!);
    expect(after.doc.textContent).toBe("Ship on the 21st of March.");
    expect(after.doc.child(0).child(1).marks.map((m) => m.type.name)).toEqual(["bold"]);
  });
  it("falls back to the plain words when the editor can't show the marks", () => {
    const before = state(doc(p("Ship on the 14th of March.")));
    const after = before.apply(applySuggestion(before, { ...change, blocks: [{ type: "text", text: "21st", marks: [{ type: "sparkle" }] }] })!);
    expect(after.doc.textContent).toBe("Ship on the 21st of March.");
  });
});

describe("applySuggestion", () => {
  const change = { find: "14th of March", text: "21st of March", blocks: [] };
  it("swaps the words and keeps the cursor on what the person was writing", () => {
    const before = state(doc(p("Ship on the 14th of March. And then")), 36);
    const tr = applySuggestion(before, change)!;
    const after = before.apply(tr);
    expect(after.doc.textContent).toBe("Ship on the 21st of March. And then");
    expect(after.selection.from).toBe(36);
  });
  it("moves the cursor with the text when the change is longer and comes first", () => {
    const before = state(doc(p("Ship on the 14th of March. And then")), 36);
    const after = before.apply(applySuggestion(before, { ...change, text: "very first week of April" })!);
    expect(after.doc.textBetween(after.selection.from - 8, after.selection.from)).toBe("And then");
  });
  it("keeps the marks the words had", () => {
    const before = state(doc(p("Ship on ", bold("14th of March"), ".")));
    const after = before.apply(applySuggestion(before, change)!);
    expect(after.doc.child(0).child(1).marks.map((m) => m.type.name)).toEqual(["bold"]);
  });
  it("answers nothing when the words have gone, and the doc stays as it is", () => {
    expect(applySuggestion(state(doc(p("Rewritten by a person."))), change)).toBeNull();
  });
  it("adds blocks at the end and leaves the cursor where it was", () => {
    const before = state(doc(p("First line")), 4);
    const after = before.apply(applySuggestion(before, { find: "", text: "New", blocks: [{ type: "paragraph", content: [{ type: "text", text: "New" }] }] })!);
    expect(after.doc.childCount).toBe(2);
    expect(after.doc.child(1).textContent).toBe("New");
    expect(after.selection.from).toBe(4);
  });
  it("skips an addition's blocks this editor can't show, rather than failing", () => {
    expect(addedBlocks(schema, [{ type: "paragraph" }, { type: "video" }]).map((n) => n.type.name)).toEqual(["paragraph"]);
  });
});

import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Node } from "@tiptap/pm/model";
import markdown from "../../xano/lambdas/markdown";

type Json = { type: string; text?: string; attrs?: Record<string, unknown>; marks?: Json[]; content?: Json[] };
const parse = (text: string, inline = false) => (markdown({ $input: { text, inline } }) as { ok: boolean; content: Json[] }).content;
const inline = (text: string) => parse(text)[0].content!;
const marks = (n: Json) => (n.marks ?? []).map((m) => m.type);
/** The editor's own schema: a body it can't load would show as an empty doc. */
const schema = getSchema([StarterKit.configure({ heading: { levels: [1, 2, 3] } }), TaskList, TaskItem.configure({ nested: true }), TableKit.configure({ table: { resizable: false } })]);
const loads = (content: Json[]) => { const doc = Node.fromJSON(schema, { type: "doc", content }); doc.check(); return doc; };

describe("an agent's markdown", () => {
  it("makes a table of a header, its divider and the rows under it", () => {
    const out = parse("Plan\n| Task | Owner |\n| --- | :-: |\n| Ship **it** | Scout |\n| Tell them |\nAfter");
    expect(out.map((n) => n.type)).toEqual(["paragraph", "table", "paragraph"]);
    const rows = out[1].content!;
    expect(rows.map((r) => r.content!.map((c) => c.type))).toEqual([["tableHeader", "tableHeader"], ["tableCell", "tableCell"], ["tableCell", "tableCell"]]);
    expect(rows[1].content![0].content![0].content!.map((t) => [t.text, marks(t)])).toEqual([["Ship ", []], ["it", ["bold"]]]);
    expect(rows[2].content![1]).toEqual({ type: "tableCell", content: [{ type: "paragraph" }] });
    loads(out);
  });
  it("makes a table without its outer pipes, keeps an escaped pipe, and leaves a lone pipe line as words", () => {
    const [table] = parse("a | b\n--|--\nx \\| y | z");
    expect(table.content![1].content![0].content![0].content![0].text).toBe("x | y");
    expect(parse("one | two\nthree").map((n) => n.type)).toEqual(["paragraph", "paragraph"]);
    expect(parse("| a | b |\n| --- |").map((n) => n.type)).toEqual(["paragraph", "paragraph"]);
  });
  it("makes headings, down to the three the editor has", () => {
    expect(parse("# One\n## Two\n### Three\n#### Four").map((n) => n.attrs?.level)).toEqual([1, 2, 3, 3]);
  });
  it("leaves no blank blocks between sections", () => {
    expect(parse("## A\n\n\nWords\n\n").map((n) => n.type)).toEqual(["heading", "paragraph"]);
  });
  it("keeps one paragraph per line, as plain text always did", () => {
    expect(parse("One\nTwo").map((n) => n.content![0].text)).toEqual(["One", "Two"]);
  });
  it("makes the review's doc real: bullets, numbers and a checklist", () => {
    const out = parse("## Meeting Details\n- Date:\n- Attendees:\n\n## Agenda\n1. Review & Context\n2. Key Objectives\n\n## Action Items\n- [ ] Action item - Owner - Due date");
    expect(out.map((n) => n.type)).toEqual(["heading", "bulletList", "heading", "orderedList", "heading", "taskList"]);
    expect(out[5].content![0]).toMatchObject({ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ text: "Action item - Owner - Due date" }] }] });
    loads(out);
  });
  it("takes every list marker, keeps a list's start, and holds a list across blank lines", () => {
    expect(parse("* a\n+ b").map((n) => n.type)).toEqual(["bulletList"]);
    expect(parse("3) c\n4) d")[0]).toMatchObject({ type: "orderedList", attrs: { start: 3 } });
    expect(parse("1. a\n\n2. b")[0].content).toHaveLength(2);
  });
  it("nests by indent, in lists and checklists", () => {
    const [list] = parse("- a\n  - b\n    - c\n- d\n\t- e");
    expect(list.content).toHaveLength(2);
    expect(list.content![0].content![1].content![0].content![1].type).toBe("bulletList");
    expect(list.content![1].content![1].type).toBe("bulletList");
    loads(parse("- [ ] a\n  - [x] b\n  - c\n1. d\n   - e"));
  });
  it("splits a run that changes kind, and ticks either way", () => {
    const out = parse("- [x] a\n- [X] b\n- c\n1. d");
    expect(out.map((n) => n.type)).toEqual(["taskList", "bulletList", "orderedList"]);
    expect(out[0].content!.map((n) => n.attrs?.checked)).toEqual([true, true]);
  });
  it("keeps an item's indented next line as part of it", () => {
    const [list] = parse("- a\n  more\n- b");
    expect(list.content![0].content!.map((n) => n.content![0].text)).toEqual(["a", "more"]);
  });
  it("makes bold, italics, bold italics, links and code", () => {
    const out = inline("a **b** *c* __d__ _e_ ***f*** `g` [h](https://x.io/i)");
    expect(out.filter((n) => marks(n).length).map((n) => [n.text, marks(n)])).toEqual([
      ["b", ["bold"]], ["c", ["italic"]], ["d", ["bold"]], ["e", ["italic"]], ["f", ["bold", "italic"]], ["g", ["code"]], ["h", ["link"]],
    ]);
    loads(parse("a **b** *c* `g` [h](https://x.io/i)"));
  });
  it("nests marks, and takes them in headings and list items", () => {
    expect(inline("**a *b***").map((n) => [n.text, marks(n)])).toEqual([["a ", ["bold"]], ["b", ["bold", "italic"]]]);
    expect(inline("[**a**](https://x.io)")[0].marks!.map((m) => m.type).sort()).toEqual(["bold", "link"]);
    expect(parse("## A **b**")[0].content![1].marks![0].type).toBe("bold");
    expect(parse("- **b**")[0].content![0].content![0].content![0].marks![0].type).toBe("bold");
  });
  it("keeps code on its own, because the editor's code mark allows no other", () => {
    expect(marks(inline("**`a`**")[0])).toEqual(["code"]);
    expect(marks(inline("[`a`](https://x.io)")[0])).toEqual(["link"]);
    loads(parse("**`a`** [`b`](https://x.io)"));
  });
  it("leaves words that only look like markup alone", () => {
    for (const words of ["snake_case_name", "2 * 3 * 4", "a*b", "**", "* not closed", "`open", "[no](link", "cost: $5 _", "1.5 million", "#hashtag", "-5 degrees"]) {
      const out = parse(words);
      if (words === "* not closed") expect(out[0].type).toBe("bulletList");
      else expect(out).toEqual([{ type: "paragraph", content: [{ type: "text", text: words }] }]);
    }
  });
  it("honours a backslash", () => {
    expect(inline("\\*not\\* \\# \\[x\\]")).toEqual([{ type: "text", text: "*not* # [x]" }]);
  });
  it("keeps a fenced block word for word, closed or not", () => {
    expect(parse("```js\n**a**\n\n- b\n```\nAfter")).toEqual([
      { type: "codeBlock", attrs: { language: "js" }, content: [{ type: "text", text: "**a**\n\n- b" }] },
      { type: "paragraph", content: [{ type: "text", text: "After" }] },
    ]);
    expect(parse("```\nnever closed")[0].content![0].text).toBe("never closed");
    expect(parse("```\n```")[0]).toEqual({ type: "codeBlock", attrs: { language: null } });
    loads(parse("```\n```\n~~~ <b>\nx\n~~~"));
  });
  it("makes a rule and a quote", () => {
    expect(parse("a\n\n---\n\n***\n\n> b\n> c").map((n) => n.type)).toEqual(["paragraph", "horizontalRule", "horizontalRule", "blockquote"]);
    expect(parse("> - a")[0].content![0].type).toBe("bulletList");
    loads(parse("> # a\n>\n> b\n\n---"));
  });
  it("gives an empty doc one empty paragraph, because the editor needs a block", () => {
    expect(parse("")).toEqual([{ type: "paragraph" }]);
    expect(parse("  \n\n ")).toEqual([{ type: "paragraph" }]);
  });
  it("keeps line endings and stray control characters out", () => {
    expect(parse("a\r\nb\u0000c\rd").map((n) => n.content![0].text)).toEqual(["a", "bc", "d"]);
  });
  it("reads inline only when asked, for a replacement inside a line", () => {
    expect(parse("- **a**", true)).toEqual([{ type: "text", text: "- " }, { type: "text", text: "a", marks: [{ type: "bold" }] }]);
    expect(parse("", true)).toEqual([]);
  });
});

describe("an agent's markdown is untrusted", () => {
  const safe = (n: Json): boolean => ["doc", "paragraph", "heading", "bulletList", "orderedList", "listItem", "taskList", "taskItem", "codeBlock", "blockquote", "horizontalRule", "text"].includes(n.type) && (n.content ?? []).every(safe);
  it("leaves HTML as the words it is", () => {
    for (const html of ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "<b>bold</b>", "<!-- note -->", "<iframe src=//x></iframe>"]) {
      expect(parse(html)).toEqual([{ type: "paragraph", content: [{ type: "text", text: html }] }]);
    }
  });
  it("makes a link only to the web or an email", () => {
    expect(inline("[a](http://x.io)")[0].marks).toEqual([{ type: "link", attrs: { href: "http://x.io" } }]);
    expect(inline("[a](HTTPS://x.io)")[0].marks![0].attrs!.href).toBe("HTTPS://x.io");
    expect(inline("[a](mailto:a@x.io)")[0].marks![0].attrs!.href).toBe("mailto:a@x.io");
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,<script>", "vbscript:x", "file:///etc/passwd", "//x.io", "/docs/1", "https://x.io\"onmouseover=\"a", "https://<x>", "http://"]) {
      const words = `[a](${bad})`;
      const out = parse(words);
      expect(JSON.stringify(out)).not.toContain("href");
      expect(out[0].content!.map((n) => n.text).join("")).toBe(words.replace("\t", "\t"));
    }
  });
  it("makes no image, because a doc's body holds no remote picture", () => {
    expect(JSON.stringify(parse("![a](https://x.io/track.gif)"))).not.toContain("href");
    expect(inline("![a](https://x.io/track.gif)")).toEqual([{ type: "text", text: "![a](https://x.io/track.gif)" }]);
  });
  it("gives a code block's language no way out of its class", () => {
    expect(parse("```\"><script>\nx\n```")[0].attrs).toEqual({ language: null });
  });
  it("can't name a person, a record or a node of its own", () => {
    const out = parse('{"type":"recordMention","attrs":{"type":"task","id":1}}\n<@1>\n@Ada\n<#task:1>');
    expect(out.every(safe)).toBe(true);
    expect(out.every((n) => n.type === "paragraph")).toBe(true);
  });
  it("finishes fast on what's built to be slow", () => {
    const started = Date.now();
    for (const nasty of ["*a ".repeat(30_000), "[".repeat(60_000), "`".repeat(60_000), "_a ".repeat(30_000), "**".repeat(30_000), "> ".repeat(30_000), Array.from({ length: 5000 }, (_, i) => `${" ".repeat(i)}- a`).join("\n")]) {
      expect(parse(nasty).every(safe)).toBe(true);
    }
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

// Documents, on @xano-sdk/docs. A doc lives in a space and follows that space's rules, its owner included. Its hooks call
// functions by name, because those functions reach back to this file for the doc table.
import { and, c, cmp, col, cond, expr, expect, f, or, ref, resp, s, type AnyTableDef } from "@xano/sdk";
import { defineDocs } from "@xano-sdk/docs";
import { rbac } from "./rbac.js";
import { user } from "./table/user.js";
import { space } from "./table/spaces/space.js";
import { gateActive } from "./function/members/gate.js";
import { blocksFromMarkdown } from "./function/docs/markdown.js";
import { SEED_DOCS } from "./world.js";

/** A human admin reaches every space. Docs routes take only a person's token, so nobody here is an agent's key. */
const oversees = and(expr(ref("actor.kind"), "=", c.text("human")), rbac.has(ref("actor.role"), "space.oversee"));

export const docs = defineDocs({
  user,
  canonical: "docs",
  // `is_demo` marks the seeded docs, so Clear demo data can find them (KTD5). Every doc a person starts leaves it false.
  // `excerpt`: the first paragraph, which docs/changed keeps after each write, so a list shows words without reading a body.
  fields: { space_id: f.tableRef(space), is_demo: f.bool(), excerpt: f.text() },
  // The rule can read only the doc and the person's row, so it reads user.space_ids, which membership keeps beside space_member.
  // It sits above ownership: someone who leaves a space loses the docs they wrote there.
  visibility: {
    record: or(oversees, cond.in(ref("record.space_id"), ref("actor.space_ids"))),
    where: or(oversees, cmp(col("space_id"), "in", ref("actor.space_ids"))),
  },
  middleware: { pre: [gateActive] },
  permissions: {
    editTeam: (role) => rbac.has(role, "docs.edit"),
    manage: (role) => rbac.has(role, "team.manage"),
  },
  onMention: (m) => [s.function.run({ fn: "docs/mentioned", as: "doc_mention", input: { doc_id: m.docId, user_id: m.userId, actor_id: m.actorId, space_id: m.fields.space_id } })],
  onChange: (e) => [s.function.run({ fn: "docs/changed", as: "doc_told", input: { op: c.text(e.op), doc_id: e.docId, actor_id: e.actorId, space_id: e.fields.space_id } })],
});

Object.assign(docs.doc, { seed: SEED_DOCS });

// Every agent write comes through `docs/from_text`, so this is where its markdown becomes real blocks.
Object.assign(docs.fns.fromText, {
  description: "Turn an agent's markdown into a Tiptap body, with nothing in it but the editor's own blocks and marks.",
  stack: blocksFromMarkdown(docs.fns.fromText.stack ?? []),
  tests: [
    { name: "markdown becomes blocks, with no blank ones", input: { text: c.text("## Plan\n\n- [ ] Ship it\n") }, expect: [
      expect.to_equal(resp("content"), c.array([
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Plan" }] },
        { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Ship it" }] }] }] },
      ])),
    ] },
  ],
});

/** The doc table, loosely typed: the module's row type doesn't know this app's `fields`. */
export const docTable: AnyTableDef = docs.doc;

/** The routes a person's browser uses. A doc starts in a space through `doc-create`, so creating, listing and naming people stay behind the space rule. */
const { info, get, save, del, undelete, versions, saveVersion, version, restore } = docs.endpoints;
export const docRoutes = [info, get, save, del, undelete, versions, saveVersion, version, restore];
export const docWrites = [save, del, undelete, saveVersion, restore];

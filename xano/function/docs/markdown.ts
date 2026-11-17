// The one place an agent's words become a doc's body. The module's `docs/from_text` is the door every agent write goes through, a
// new doc and an addition alike, so xano/docs.ts puts this in front of it. It's a lambda because no statement can parse inline
// marks. A body that fails, or a plan that has no lambdas, gets the module's own plain paragraphs: words are never lost.
import { c, defineFunction, expr, fl, inp, input, obj, ref, s, withFilters, type Statement } from "@xano/sdk";
import { lam } from "@xano/sdk/node";

const parse = () => s.try_catch({ try: [s.lambda({ as: "parsed", code: lam.file("../../lambdas/markdown.ts") })], catch: [] });
const parsedWell = () => expr(ref("parsed.ok", { safe: true }), "=", c.bool(true));

/** `docs/from_text`'s new stack: `plain` is the module's own, which binds the same `blocks` its response reads. */
export const blocksFromMarkdown = (plain: readonly Statement[]) => [
  s.set_var("parsed", c.null()),
  parse(),
  s.conditional({ when: parsedWell(), then: [s.set_var("blocks", ref("parsed.content"))], else: [...plain] }),
];

/** Words with marks for inside a line, where a list or a heading means nothing. Plain words when the lambda can't run. */
export const inlineMarkdown = defineFunction({
  name: "docs/inline_markdown",
  description: "An agent's words for inside a line, as text nodes with their marks.",
  input: { text: input.text(), inline: input.bool() },
  stack: [
    s.set_var("parsed", c.null()),
    parse(),
    s.set_var("nodes", withFilters(c.array([]), fl.array_push(obj({ type: c.text("text"), text: inp("text") })))),
    s.conditional({ when: parsedWell(), then: [s.update_var("nodes", ref("parsed.content"))] }),
  ],
  response: ref("nodes"),
});

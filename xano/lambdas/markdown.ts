// An agent's markdown as Tiptap JSON, for `docs/from_text`. Agents' words are untrusted, so this only ever builds the node and mark
// types listed here, from text: raw HTML stays the words it is, and a link needs a web or email address. Everything that isn't
// markup falls through as text, so a doc never loses words. Each search gives up for good once it fails, so a line built to be
// slow stays linear. Only this function's body is sent to the engine, which is why its helpers live inside it.
type Mark = { type: string; attrs?: { href: string } };
type Block = { type: string; text?: string; attrs?: Record<string, unknown>; marks?: Mark[]; content?: Block[] };
type Line = { indent: number; rest: string };
type Item = { list: "bulletList" | "orderedList" | "taskList"; start: number; checked: boolean; words: string };

export default function ({ $input }: { $input: { text?: string | null; inline?: boolean | null } }) {
  const MOST_DEPTH = 8;
  const SAFE_LINK = /^(?:https?:\/\/|mailto:)[^\s<>"'`\\]+$/i;
  const PUNCTUATION = /^[!-/:-@[-`{-~]$/;
  const WORD = /^[\p{L}\p{N}]$/u;

  function inline(text: string, marks: Mark[], depth: number): Block[] {
    const out: Block[] = [];
    let plain = "";
    const flush = () => {
      if (plain) out.push({ type: "text", text: plain, ...(marks.length ? { marks } : {}) });
      plain = "";
    };
    const never = new Set<string>();
    const has = (name: string) => marks.some((m) => m.type === name);
    const space = (at: number) => at < 0 || at >= text.length || /\s/.test(text[at]);
    const word = (at: number) => at >= 0 && at < text.length && WORD.test(text[at]);

    /** Where `mark` closes, past `from`, skipping what's escaped or in code. -1 means it doesn't. */
    const closing = (mark: string, from: number) => {
      for (let at = from; at < text.length; at += 1) {
        if (text[at] === "\\") { at += 1; continue; }
        if (!text.startsWith(mark, at) || space(at - 1)) continue;
        if (mark[0] === "_" && word(at + mark.length)) continue;
        // `**a***` closes on its last two stars, so an italic inside it keeps its own.
        if (mark.length > 1 && text[at + mark.length] === mark[0]) continue;
        if (mark.length === 1 && text[at + 1] === mark) { at += 1; continue; }
        return at;
      }
      return -1;
    };

    let at = 0;
    while (at < text.length) {
      const char = text[at];
      if (char === "\\" && PUNCTUATION.test(text[at + 1] ?? "")) { plain += text[at + 1]; at += 2; continue; }
      if (char === "`") {
        let run = 1;
        while (text[at + run] === "`") run += 1;
        const fence = "`".repeat(run);
        const end = never.has(fence) ? -1 : text.indexOf(fence, at + run);
        if (end > at + run) {
          flush();
          // The editor's code mark takes no other. Inside a link the link matters more.
          const link = marks.find((m) => m.type === "link");
          out.push({ type: "text", text: text.slice(at + run, end), marks: [link ?? { type: "code" }] });
          at = end + run;
        } else {
          if (end < 0) never.add(fence);
          plain += fence;
          at += run;
        }
        continue;
      }
      if (char === "[" && depth < MOST_DEPTH && !has("link") && text[at - 1] !== "!" && !never.has("[")) {
        const close = text.indexOf("](", at + 1);
        if (close < 0) never.add("[");
        const end = close < 0 ? -1 : text.indexOf(")", close + 2);
        if (close > at + 1 && end > 0) {
          let last = end;
          while (text[last + 1] === ")" && text.slice(close + 2, last + 1).includes("(")) last += 1;
          const href = text.slice(close + 2, last);
          if (SAFE_LINK.test(href) && !/^(?:https?:\/\/|mailto:)$/i.test(href)) {
            flush();
            out.push(...inline(text.slice(at + 1, close), [...marks, { type: "link", attrs: { href } }], depth + 1));
            at = last + 1;
            continue;
          }
          plain += text.slice(at, last + 1);
          at = last + 1;
          continue;
        }
      }
      if ((char === "*" || char === "_") && depth < MOST_DEPTH) {
        let run = 1;
        while (text[at + run] === char && run < 3) run += 1;
        let handled = false;
        for (let size = run; size >= 1 && !handled; size -= 1) {
          const mark = char.repeat(size);
          if (never.has(mark) || space(at + size) || (char === "_" && word(at - 1))) continue;
          const end = closing(mark, at + size + 1);
          if (end < 0) { never.add(mark); continue; }
          const inner = size === 1 ? [{ type: "italic" }] : size === 2 ? [{ type: "bold" }] : [{ type: "bold" }, { type: "italic" }];
          flush();
          out.push(...inline(text.slice(at + size, end), [...marks, ...inner.filter((m) => !has(m.type))], depth + 1));
          at = end + size;
          handled = true;
        }
        if (handled) continue;
        plain += text.slice(at, at + run);
        at += run;
        continue;
      }
      plain += char;
      at += 1;
    }
    flush();
    return out;
  }

  const paragraph = (words: string): Block => {
    const content = inline(words, [], 0);
    return content.length ? { type: "paragraph", content } : { type: "paragraph" };
  };

  const read = (raw: string): Line => {
    const spaces = /^[ \t]*/.exec(raw)![0];
    return { indent: spaces.replace(/\t/g, "    ").length, rest: raw.slice(spaces.length) };
  };

  function itemOf(rest: string): Item | null {
    const found = /^([-*+]|(\d{1,9})[.)])(?:[ \t]+(.*))?$/.exec(rest);
    if (!found) return null;
    const words = (found[3] ?? "").trimEnd();
    if (found[2]) return { list: "orderedList", start: Number(found[2]), checked: false, words };
    const task = /^\[([ xX])\](?:[ \t]+(.*))?$/.exec(words);
    if (task) return { list: "taskList", start: 1, checked: task[1] !== " ", words: (task[2] ?? "").trim() };
    return { list: "bulletList", start: 1, checked: false, words };
  }

  /** A table row's cells, split on each pipe that isn't escaped. A line with no pipe isn't a row. */
  function cellsOf(rest: string): string[] | null {
    if (!rest.includes("|")) return null;
    const cells: string[] = [];
    let cell = "";
    for (let at = 0; at < rest.length; at += 1) {
      if (rest[at] === "\\" && rest[at + 1] === "|") { cell += "\\|"; at += 1; continue; }
      if (rest[at] === "|") { cells.push(cell.trim()); cell = ""; continue; }
      cell += rest[at];
    }
    cells.push(cell.trim());
    // The pipes at either end only frame the row.
    if (rest.trimStart()[0] === "|") cells.shift();
    if (rest.trimEnd().endsWith("|") && !rest.trimEnd().endsWith("\\|")) cells.pop();
    return cells.length ? cells : null;
  }
  /** The line under a table's header, `| --- | :-: |`, with a column for each of the header's. */
  const isDivider = (rest: string, columns: number) => {
    const cells = cellsOf(rest);
    return !!cells && cells.length === columns && cells.every((c) => /^:?-+:?$/.test(c));
  };

  const isRule = (rest: string) => /^(?:-[ \t]*){3,}$|^(?:\*[ \t]*){3,}$|^(?:_[ \t]*){3,}$/.test(rest);

  /** The next line that isn't blank. */
  const nextFilled = (lines: string[], from: number) => {
    let at = from;
    while (at < lines.length && !lines[at].trim()) at += 1;
    return at;
  };

  /** One list, and any list nested in it. Answers the line it stopped at, so a run of a different kind starts a list of its own. */
  function list(lines: string[], from: number, depth: number): { node: Block; next: number } {
    const first = read(lines[from]);
    const kind = itemOf(first.rest)!;
    const items: Block[] = [];
    let at = from;
    while (at < lines.length) {
      const line = read(lines[at]);
      const item = isRule(line.rest) ? null : itemOf(line.rest);
      if (!item || item.list !== kind.list || line.indent > first.indent + 1 || line.indent + 1 < first.indent) break;
      const content: Block[] = [paragraph(item.words)];
      at += 1;
      while (at < lines.length) {
        const filled = nextFilled(lines, at);
        if (filled >= lines.length) { at = filled; break; }
        const next = read(lines[filled]);
        if (next.indent <= first.indent + 1) break;
        if (itemOf(next.rest) && depth < MOST_DEPTH) {
          const nested = list(lines, filled, depth + 1);
          content.push(nested.node);
          at = nested.next;
        } else if (filled === at) {
          content.push(paragraph(next.rest.trim()));
          at += 1;
        } else break;
      }
      items.push(item.list === "taskList" ? { type: "taskItem", attrs: { checked: item.checked }, content } : { type: "listItem", content });
      const filled = nextFilled(lines, at);
      if (filled < lines.length && filled !== at) {
        const next = read(lines[filled]);
        const same = itemOf(next.rest);
        if (!same || same.list !== kind.list || next.indent !== first.indent) break;
        at = filled;
      }
    }
    const attrs = kind.list === "orderedList" && kind.start !== 1 ? { attrs: { start: kind.start } } : {};
    return { node: { type: kind.list, ...attrs, content: items }, next: Math.max(at, from + 1) };
  }

  function blocks(lines: string[], depth: number): Block[] {
    const out: Block[] = [];
    let at = 0;
    while (at < lines.length) {
      const line = read(lines[at]);
      const rest = line.rest.trimEnd();
      if (!rest) { at += 1; continue; }

      const fence = /^(`{3,}|~{3,})[ \t]*(.*)$/.exec(rest);
      if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
        const shut = new RegExp(`^[ \\t]*${fence[1][0]}{${fence[1].length},}[ \\t]*$`);
        const code: string[] = [];
        at += 1;
        while (at < lines.length && !shut.test(lines[at])) { code.push(lines[at]); at += 1; }
        at += 1;
        const language = /^[\w+#.-]{1,30}$/.test(fence[2].trim()) ? fence[2].trim() : null;
        const words = code.join("\n");
        out.push({ type: "codeBlock", attrs: { language }, ...(words ? { content: [{ type: "text", text: words }] } : {}) });
        continue;
      }

      const heading = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?$/.exec(rest);
      if (heading) {
        const content = inline(heading[2], [], 0);
        out.push({ type: "heading", attrs: { level: Math.min(heading[1].length, 3) }, ...(content.length ? { content } : {}) });
        at += 1;
        continue;
      }

      if (isRule(rest)) { out.push({ type: "horizontalRule" }); at += 1; continue; }

      if (rest[0] === ">" && depth < MOST_DEPTH) {
        const quoted: string[] = [];
        while (at < lines.length && read(lines[at]).rest[0] === ">") { quoted.push(read(lines[at]).rest.slice(1).replace(/^ /, "")); at += 1; }
        const content = blocks(quoted, depth + 1);
        if (content.length) out.push({ type: "blockquote", content });
        continue;
      }

      const head = cellsOf(rest);
      if (head && at + 1 < lines.length && isDivider(read(lines[at + 1]).rest.trimEnd(), head.length)) {
        const row = (cells: string[], type: "tableHeader" | "tableCell"): Block => ({
          type: "tableRow",
          content: head.map((_, i) => ({ type, content: [paragraph(cells[i] ?? "")] })),
        });
        const rows: Block[] = [row(head, "tableHeader")];
        at += 2;
        while (at < lines.length) {
          const cells = cellsOf(read(lines[at]).rest.trimEnd());
          if (!cells) break;
          rows.push(row(cells, "tableCell"));
          at += 1;
        }
        out.push({ type: "table", content: rows });
        continue;
      }

      if (itemOf(rest)) {
        const made = list(lines, at, 0);
        out.push(made.node);
        at = made.next;
        continue;
      }

      out.push(paragraph(rest));
      at += 1;
    }
    return out;
  }

  try {
    // NUL can't be stored, and the rest of the control characters mean nothing in a doc.
    const text = String($input.text ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    if ($input.inline) return { ok: true, content: inline(text, [], 0) };
    const content = blocks(text.split("\n"), 0);
    return { ok: true, content: content.length ? content : [{ type: "paragraph" }] };
  } catch {
    return { ok: false, content: [] };
  }
}

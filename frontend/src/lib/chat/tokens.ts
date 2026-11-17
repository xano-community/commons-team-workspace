// A message body is plain text with `<@5>` for a person and `<#doc:12>` for a record. Names aren't stored, so a rename shows
// everywhere and a title can't outlive someone's access. The composer shows names, and swaps them for tokens on sending.
export type Segment =
  | { t: "text"; v: string }
  | { t: "person"; id: number }
  | { t: "record"; type: string; id: number }
  | { t: "link"; url: string };
export type Pick = { display: string; token: string };
export type Trigger = { char: "@" | "#"; query: string; start: number };

const TOKEN = /<@(\d+)>|<#([a-z_]+):(\d+)>|\bhttps?:\/\/[^\s<>]+/g;
const TRAILING = /[.,;:!?)\]]+$/;

export function parseBody(body: string): Segment[] {
  const out: Segment[] = [];
  const text = (v: string) => { if (!v) return; const last = out.at(-1); if (last?.t === "text") last.v += v; else out.push({ t: "text", v }); };
  let at = 0;
  for (const m of body.matchAll(TOKEN)) {
    text(body.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1]) out.push({ t: "person", id: Number(m[1]) });
    else if (m[2]) out.push({ t: "record", type: m[2], id: Number(m[3]) });
    else {
      // A sentence's full stop isn't part of its link.
      const url = m[0].replace(TRAILING, "");
      out.push({ t: "link", url });
      text(m[0].slice(url.length));
    }
  }
  text(body.slice(at));
  return out;
}

export const peopleIn = (body: string): number[] => [...new Set(parseBody(body).flatMap((s) => (s.t === "person" ? [s.id] : [])))];

export function recordsIn(body: string): { type: string; id: number }[] {
  const seen = new Map<string, { type: string; id: number }>();
  for (const s of parseBody(body)) if (s.t === "record") seen.set(`${s.type}:${s.id}`, { type: s.type, id: s.id });
  return [...seen.values()];
}

export const stripRecords = (body: string) => body.replace(/\s*<#[a-z_]+:\d+>/g, "").trim();
/** The same for people, where it's a name that raised the warning. */
export const stripNames = (body: string, ids: number[]) => ids.reduce((text, id) => text.replace(new RegExp(`\\s*<@${id}>`, "g"), ""), body).trim();

/** Longest name first, so "@Morgan Reyes" isn't read as "@Morgan" and a stray " Reyes". */
export function encodeBody(text: string, picks: Pick[]): string {
  let out = text;
  for (const p of [...picks].sort((a, b) => b.display.length - a.display.length)) out = out.split(p.display).join(p.token);
  return out;
}

/** A body back into what someone would have typed. A token with no known name stays as it is, so nothing is lost. */
export function decodeBody(body: string, names: { person: (id: number) => string | null; record: (type: string, id: number) => string | null }): { text: string; picks: Pick[] } {
  const picks: Pick[] = [];
  const text = parseBody(body).map((s) => {
    if (s.t === "text") return s.v;
    if (s.t === "link") return s.url;
    const name = s.t === "person" ? names.person(s.id) : names.record(s.type, s.id);
    const token = s.t === "person" ? `<@${s.id}>` : `<#${s.type}:${s.id}>`;
    if (!name) return token;
    const display = `${s.t === "person" ? "@" : "#"}${name}`;
    if (!picks.some((p) => p.token === token)) picks.push({ display, token });
    return display;
  }).join("");
  return { text, picks };
}

/** The word being typed at the caret, when it starts a mention. An email address has text before its @, so it doesn't. */
export function activeTrigger(text: string, caret: number): Trigger | null {
  const m = /(^|\s)([@#])([^\s@#]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { char: m[2] as Trigger["char"], query: m[3], start: m.index + m[1].length };
}

export function applyPick(text: string, trigger: Trigger, caret: number, display: string): { text: string; caret: number } {
  const inserted = `${display} `;
  return { text: text.slice(0, trigger.start) + inserted + text.slice(caret), caret: trigger.start + inserted.length };
}

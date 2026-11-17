#!/usr/bin/env node
// Docs in real windows, against a deployed backend on the local Engine: what a workflow test can't see. Two people in one doc, an
// agent's change landing on someone mid-sentence, a save that loses a race, history, links, every state, the phone layout, and
// what an autosave wakes. The agent's side runs through the engine's own function runner, so no model is needed. With --model it
// also asks a real agent, from inside a doc, while someone keeps typing. Screenshots land in --out, to be looked at.
//
//   node frontend/scripts/docs-check.mjs --backend <url> --frontend <url> [--out qa/docs] [--model]
//
// Exit 0 = pass, 1 = a check failed, 2 = usage.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { launchBrowser } from "./browser.mjs";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const backend = opt("backend")?.replace(/\/$/, "");
const frontend = opt("frontend")?.replace(/\/$/, "");
const out = resolve(opt("out", "qa/docs"));
const withModel = argv.includes("--model");
if (!backend || !frontend) { console.error("usage: docs-check.mjs --backend <url> --frontend <url> [--out <dir>]"); process.exit(2); }
mkdirSync(out, { recursive: true });

const report = { backend, frontend, errors: [] };
const fail = (check, detail) => { report.errors.push({ check, detail }); console.log(`✗ ${check}: ${detail}`); };
const pass = (check, detail = "") => console.log(`✓ ${check}${detail ? `: ${detail}` : ""}`);
const check = (ok, what, detail = "") => (ok ? pass(what, detail) : fail(what, detail || "no"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const routes = JSON.parse(execFileSync("npx", ["xanosdk", "routes", "./xano/index.ts", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).routes;
const pathOf = (verb, name, params = {}) => Object.entries(params).reduce((p, [k, v]) => p.replace(`{${k}}`, v), routes.find((r) => r.verb === verb && r.ref.split("/").slice(1).join("/") === name).path);
const http = async (verb, path, token, body) => {
  const res = await fetch(backend + path, { method: verb, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  if (!res.ok && res.status !== 409) throw Object.assign(new Error(`${verb} ${path}: ${res.status} ${JSON.stringify(json)}`), { status: res.status });
  return json;
};
const signIn = async (persona) => (await http("POST", pathOf("POST", "auth/demo"), null, { persona })).authToken;
const avery = await signIn("admin");
const morgan = await signIn("member");
const riley = await signIn("guest");
const meOf = (t) => http("GET", pathOf("GET", "auth/me"), t);
const [averyMe, morganMe, rileyMe] = await Promise.all([meOf(avery), meOf(morgan), meOf(riley)]);
const scoutId = 4;   // The seeded agent: xano/world.ts.

// The agent's seat: the same function its tool calls, run by the engine for a run-less connected agent.
const meta = JSON.parse(execFileSync("npx", ["xanosdk", "local", "token", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
let rpc = 0;
const runFunction = async (name, input) => {
  const res = await fetch(`${backend}/_engine/mcp`, { method: "POST", headers: { authorization: `Bearer ${meta.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name: "xano_run_function", arguments: { name, input } } }) });
  const answer = await res.json();
  if (answer.error || answer.result?.isError) throw new Error(`${name}: ${JSON.stringify(answer.error ?? answer.result).slice(0, 300)}`);
  const run = JSON.parse(answer.result?.content?.[0]?.text ?? "{}").result;
  return run?.result ?? run;
};
const agentFiles = (id, find, text, note = "") => runFunction("agents/save_doc", { actor_id: scoutId, run_id: 0, id, title: "", find, text, note });

const paragraph = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
const heading = (text, level = 2) => ({ type: "heading", attrs: { level }, content: [{ type: "text", text }] });
const makeDoc = (token, space, title, blocks) => http("POST", pathOf("POST", "doc-create"), token, { space_id: space, title, body: { type: "doc", content: blocks } });
const readDoc = async (id, token = morgan) => (await http("GET", pathOf("GET", "docs/{id}", { id }), token)).doc;
const saveDoc = (id, token, base, title, blocks) => http("POST", pathOf("POST", "docs/{id}/save", { id }), token, { base_version: base, title, body: { type: "doc", content: blocks } });
const BRIEF = [
  paragraph("The relaunch moves Marlow to the new storefront, with final bike specs from Riley's team and a one-week soft launch before the press date."),
  heading("Dates"),
  paragraph("Specs lock on Thursday. Checkout goes live on the 14th of March, with the comparison table to follow."),
  heading("Who does what"),
  paragraph("Morgan runs the import. Avery owns payments and the live keys."),
];

const browser = await launchBrowser();
async function open(persona, { width = 1440, height = 900, theme = "light", mobile = false } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
  page.on("pageerror", (e) => fail("page error", e.message.slice(0, 240)));
  await page.goto(frontend, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="demo-login"]', { timeout: 20000 });
  await page.evaluate((who) => [...document.querySelectorAll('[data-testid="demo-login"]')].find((b) => b.textContent?.includes(who))?.click(), persona);
  await page.waitForFunction(() => !document.querySelector('[data-testid="demo-login"]'), { timeout: 20000 });
  await page.waitForFunction(() => document.documentElement.dataset.live === "live", { timeout: 15000 }).catch(() => {});
  return page;
}
const go = async (page, path) => {
  await page.evaluate((p) => { history.pushState({}, "", p); dispatchEvent(new PopStateEvent("popstate")); }, path);
  await page.waitForNetworkIdle({ idleTime: 250, timeout: 8000 }).catch(() => {});
};
const see = (page, selector, timeout = 6000) => page.waitForSelector(selector, { timeout }).then(() => true).catch(() => false);
const seeText = (page, text, timeout = 6000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text).then(() => true).catch(() => false);
const gone = (page, selector, timeout = 6000) => page.waitForFunction((s) => !document.querySelector(s), { timeout }, selector).then(() => true).catch(() => false);
const shot = async (page, name) => { await sleep(120); await page.screenshot({ path: join(out, `${name}.png`) }); };
const bodyText = (page) => page.evaluate(() => document.querySelector('[data-testid="docs-body"]')?.innerText ?? "");
const saved = (page, timeout = 8000) => page.waitForFunction(() => document.querySelector('[data-testid="docs-save-status"]')?.dataset.status === "saved", { timeout }).then(() => true).catch(() => false);
/** The cursor, as the words either side of it. */
const caret = (page) => page.evaluate(() => { const s = getSelection(); const n = s.anchorNode; const t = n?.textContent ?? ""; return { before: t.slice(Math.max(0, s.anchorOffset - 12), s.anchorOffset), after: t.slice(s.anchorOffset, s.anchorOffset + 6), focused: !!document.activeElement?.closest('[data-testid="docs-body"]') }; });
const typeAtEnd = async (page) => { await page.click('[data-testid="docs-body"] > :last-child'); await page.keyboard.press("End"); };
const axe = async (page, name) => {
  await page.evaluate(axeSource);
  const result = await page.evaluate(() => window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }));
  const bad = result.violations.map((v) => `${v.id} (${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(", ")})`);
  check(!bad.length, `${name}: axe`, bad.join("; "));
};
const phoneChecks = async (page, name) => {
  const { wide, small } = await page.evaluate(() => {
    const seen = [...document.querySelectorAll('main a, main button, main [role="combobox"], main input, main textarea')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest("[data-testid=docs-body]"); });
    return { wide: document.documentElement.scrollWidth > innerWidth + 1, small: seen.filter((e) => { const r = e.getBoundingClientRect(); return (r.height < 43.5 && r.width < 43.5) || r.height < 30; }).map((e) => (e.getAttribute("aria-label") || e.textContent || e.tagName).slice(0, 24)).slice(0, 6) };
  });
  check(!wide, `${name}: nothing runs off a 390 px screen`);
  check(!small.length, `${name}: touch targets are 44 px`, small.join(", "));
};
/** Counts what a page's socket hears from now on. */
const listen = async (page) => {
  const session = await page.createCDPSession();
  await session.send("Network.enable");
  const frames = [];
  session.on("Network.webSocketFrameReceived", (e) => frames.push(e.response.payloadData));
  return frames;
};

const SPACE = 2;   // Marlow relaunch: Morgan, Avery and Scout.
const CLIENT_ROOM = 3;   // Morgan, Avery and Riley the guest.
const stamp = Date.now() % 100000;
try {
  // ── Empty, then the first doc, from the screen ───────────────────────────────────────────────────
  const a = await open("Morgan");
  await go(a, "/docs");
  check(await see(a, '[data-testid="docs-page"]'), "the docs screen opens from its route");
  await go(a, `/docs?space=${CLIENT_ROOM}&q=zzzz-${stamp}`);
  check(await see(a, '[data-testid="docs-no-match"]'), "a search that finds nothing says so");
  await shot(a, "list-no-match-light");
  await go(a, "/docs?view=trash");
  await sleep(300); await shot(a, "list-trash-light");

  const brief = await makeDoc(morgan, SPACE, `Launch brief ${stamp}`, BRIEF);
  await makeDoc(avery, SPACE, "Launch-day runbook", [paragraph("Who does what on the 14th, and how we roll back.")]);
  await makeDoc(morgan, CLIENT_ROOM, "Size guide notes", [paragraph("Sales keep asking about it, so it moves up the page.")]);
  await go(a, "/docs");
  check(await seeText(a, `Launch brief ${stamp}`), "the list shows a doc in a space");
  await shot(a, "list-light");
  await go(a, `/docs?space=${SPACE}`);
  await a.keyboard.press("n");
  check(await see(a, '[data-testid="doc-editor"]', 8000), "n starts a doc in the space on screen");
  await a.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "docs-title", { timeout: 4000 }).catch(() => fail("new doc", "the title wasn't focused"));
  await a.keyboard.type("Scratch notes");
  await a.keyboard.press("Enter");
  await sleep(100);
  await a.keyboard.type("A first line.");
  check(await saved(a), "typing autosaves");
  await shot(a, "doc-new-light");

  // ── Two windows, one doc ─────────────────────────────────────────────────────────────────────────
  const path = `/docs/${brief.id}`;
  await go(a, path);
  const b = await open("Avery");
  await go(b, path);
  check(await see(a, '[data-testid="doc-editor"]'), "the doc opens");
  const inRoom = (page) => page.waitForFunction(() => !!document.querySelector('[data-testid="doc-editor"] [data-kit="presence"]'), { timeout: 8000 }).then(() => true).catch(() => false);
  check(await inRoom(a), "the first window shows the second person in the doc");
  check(await inRoom(b), "the second window shows the first person in the doc");
  await shot(a, "doc-presence-light");

  // B reads while A saves: B's screen follows, and B's cursor stays on its words.
  await b.click('[data-testid="docs-body"] h2');
  await typeAtEnd(a);
  await a.keyboard.type(" Soft launch first.");
  check(await saved(a), "the first window saves");
  check(await seeText(b, "Soft launch first."), "the second window shows the save without typing anything");
  await go(b, "/docs");

  // ── "@" draws agents as the app does: a rounded square for an agent, a circle for a person ──────────
  await typeAtEnd(a);
  await a.keyboard.type(" @");
  await see(a, '[data-testid="docs-mention-menu"] [role="option"]');
  const faces = await a.$$eval('[data-testid="docs-mention-menu"] [role="option"]', (opts) => opts.map((o) => {
    const face = o.querySelector('[data-slot="avatar"]');
    return { name: o.textContent.trim(), kind: face?.dataset.kind ?? null, round: face ? getComputedStyle(face).borderTopLeftRadius.endsWith("%") ? parseFloat(getComputedStyle(face).borderTopLeftRadius) >= 50 : parseFloat(getComputedStyle(face).borderTopLeftRadius) >= face.offsetWidth / 2 : null };
  }));
  const scoutFace = faces.find((f) => f.name.includes("Scout"));
  const averyFace = faces.find((f) => f.name.includes("Avery"));
  check(scoutFace?.kind === "agent" && scoutFace.round === false, "the @ menu draws an agent as a rounded square", JSON.stringify(scoutFace));
  check(averyFace?.kind === "person" && averyFace.round === true, "the @ menu draws a person as a circle", JSON.stringify(averyFace));
  await shot(a, "doc-mention-menu-light");
  await a.keyboard.press("Escape");
  await a.keyboard.press("Backspace");
  await a.keyboard.press("Backspace");
  check(await saved(a), "closing the @ menu leaves the doc as it was");

  // ── An agent's change while someone types ────────────────────────────────────────────────────────
  await typeAtEnd(a);
  const typing = (async () => { for (const w of "One more thing we should not forget about the press date and the embargo".split(" ")) { await a.keyboard.type(`${w} `, { delay: 12 }); await sleep(40); } })();
  await sleep(500);
  const filed = await agentFiles(brief.id, "14th of March", "21st of March", "The live keys land on Wednesday, so the 14th no longer holds.");
  check(filed.status === "pending", "with someone typing, an agent's change waits", JSON.stringify(filed).slice(0, 120));
  check(await see(a, '[data-testid="suggestion-bar"]'), "the suggestion appears while they type");
  await typing;
  check((await bodyText(a)).includes("the press date and the embargo"), "their words are all there");
  check((await bodyText(a)).includes("14th of March"), "the agent's words aren't in the doc");
  const during = await caret(a);
  check(during.focused && during.before.includes("embargo"), "the cursor is where they left it, in the editor", JSON.stringify(during));
  check(await see(a, '[data-testid="suggestion-target"]'), "the words it would change are marked in the doc");
  await shot(a, "doc-suggestion-light");
  check(await saved(a), "their typing saved past the suggestion");
  const beforeApply = await readDoc(brief.id);
  check(beforeApply.text.includes("14th of March") && beforeApply.text.includes("embargo"), "the server holds their words and not the agent's");

  // Apply from the keyboard, in the middle of writing.
  await a.keyboard.type("Then ");
  await a.keyboard.down("Alt"); await a.keyboard.press("Enter"); await a.keyboard.up("Alt");
  check(await gone(a, '[data-testid="suggestion-bar"]'), "Option-Enter applies it without leaving the line");
  check((await bodyText(a)).includes("21st of March"), "the change is in the doc");
  const afterApply = await caret(a);
  check(afterApply.focused && afterApply.before.includes("Then"), "the cursor didn't move", JSON.stringify(afterApply));
  await a.keyboard.type("done.");
  check(await saved(a), "the applied change saves as the person's own");
  const applied = await readDoc(brief.id);
  check(applied.text.includes("21st of March") && applied.text.includes("Then done."), "the server has both");
  await a.keyboard.down("Meta"); await a.keyboard.press("z"); await a.keyboard.up("Meta");

  // A queue, in order, by mouse.
  await sleep(100);
  await a.keyboard.type(" ");
  const q1 = await agentFiles(brief.id, "Specs lock on Thursday", "Specs lock on Friday at noon", "Riley's lead needs one more day.");
  const q2 = await agentFiles(brief.id, "", "## Open questions\nDoes the soft launch need its own press note?", "Worth deciding before the press date.");
  check(q1.status === "pending" && q2.status === "pending", "while someone's working, each change queues");
  check(await see(a, '[data-testid="suggestion-count"]'), "the bar says how many are waiting");
  await shot(a, "doc-suggestion-queue-light");
  await a.click('[data-testid="suggestion-apply"]');
  check(await seeText(a, "Specs lock on Friday at noon"), "Apply puts the first one in");
  await a.waitForFunction(() => document.querySelector('[data-testid="suggestion-added"]'), { timeout: 5000 }).catch(() => fail("queue", "the next one didn't take its place"));
  await shot(a, "doc-suggestion-addition-light");
  await a.click('[data-testid="suggestion-apply"]');
  check(await seeText(a, "Open questions"), "an addition lands at the end");
  check(await saved(a), "both save");

  // Text changed: its words go while it's waiting, in the editor, before any save.
  await a.click('[data-testid="docs-body"]');
  const stale = await agentFiles(brief.id, "Morgan runs the import", "Riley's team runs the import", "");
  check(stale.status === "pending", "a change filed while they're busy waits");
  await see(a, '[data-testid="suggestion-apply"]');
  await a.evaluate(() => { const walker = document.createTreeWalker(document.querySelector('[data-testid="docs-body"]'), NodeFilter.SHOW_TEXT); let n; while ((n = walker.nextNode())) if (n.textContent.includes("Morgan runs the import")) { const r = document.createRange(); const i = n.textContent.indexOf("Morgan"); r.setStart(n, i); r.setEnd(n, i + 6); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return; } });
  await a.keyboard.type("Sam");
  check(await see(a, '[data-testid="suggestion-stale"]'), "words edited away show Text changed at once, before any save");
  check(!(await a.$('[data-testid="suggestion-apply"]')), "and Apply isn't there");
  await shot(a, "doc-suggestion-stale-light");
  await a.click('[data-testid="suggestion-dismiss"]');
  check(await gone(a, '[data-testid="suggestion-bar"]'), "Dismiss clears it");
  check(await saved(a), "the person's edit stands");

  // Idle: nobody working, so it goes in by itself, on every open window, and the cursor keeps its words.
  await go(b, path);
  await b.click('[data-testid="docs-body"] p');
  await sleep(16_000);
  const idle = await agentFiles(brief.id, "Avery owns payments", "Avery owns payments, tax", "Tax rules sit with payments.");
  check(idle.status === "applied", "on a quiet doc an agent's change applies at once", JSON.stringify(idle).slice(0, 120));
  check(await seeText(a, "Avery owns payments, tax"), "the first window shows it");
  check(await seeText(b, "Avery owns payments, tax"), "the second window shows it");
  check(await see(a, '[data-testid="suggestion-applied"]'), "and says what happened");
  await shot(a, "doc-applied-light");
  await a.click('[data-testid="suggestion-applied"] button');

  // A person-to-person race keeps the dialog.
  await b.click('[data-testid="docs-body"] h2');
  await typeAtEnd(b);
  const now = await readDoc(brief.id);
  await b.keyboard.type("Avery's line.");
  await saveDoc(brief.id, morgan, now.version, now.title, [...now.body.content, paragraph("Morgan got there first.")]);
  check(await see(b, '[data-testid="docs-conflict"]', 8000), "two people's race opens the conflict dialog");
  await shot(b, "doc-conflict-light");
  await b.click('[data-testid="docs-conflict-theirs-btn"]');
  check(await gone(b, '[data-testid="docs-conflict"]'), "the dialog closes on a choice");
  await go(b, "/docs");

  // An agent's edit that beats a person's first keystroke: the keystroke never reached the server, so it can't have waited.
  await a.setRequestInterception(true);
  const dropKeystrokes = (r) => { if (r.url().includes("doc-editing")) void r.abort(); else void r.continue(); };
  a.on("request", dropKeystrokes);
  await sleep(16_000);
  await typeAtEnd(a);
  await a.keyboard.type("A sentence that started first.");
  const raced = await agentFiles(brief.id, "with the comparison table to follow", "and the comparison table after that", "");
  check(raced.status === "applied", "with nothing heard from the keyboard, the change goes in", JSON.stringify(raced).slice(0, 120));
  check(await saved(a), "the person's save lands");
  check(!(await a.$('[data-testid="docs-conflict"]')), "no dialog interrupts them");
  check(await see(a, '[data-testid="suggestion-bar"]'), "the agent's change comes back as a suggestion");
  const race = await readDoc(brief.id);
  check(race.text.includes("A sentence that started first.") && !race.text.includes("comparison table after that"), "their words won");
  await a.click('[data-testid="suggestion-dismiss"]');
  a.off("request", dropKeystrokes);
  await a.setRequestInterception(false);

  // ── What an autosave wakes ───────────────────────────────────────────────────────────────────────
  const third = await open("Avery");
  await go(third, `/docs?space=${SPACE}`);
  const heard = await listen(third);
  await sleep(1000);
  await typeAtEnd(a);
  for (let i = 0; i < 4; i += 1) { await a.keyboard.type(`beat ${i} `); await saved(a); }
  await sleep(600);
  const docFrames = heard.filter((f) => f.includes('"entity":"doc"') || f.includes("doc_saved"));
  check(docFrames.length <= 1, "four autosaves wake a list in the same space at most once", `${docFrames.length} frames`);
  await third.close();

  // ── History and links ────────────────────────────────────────────────────────────────────────────
  const project = (await http("GET", pathOf("GET", "task-setup"), morgan)).projects.find((p) => p.space_id === SPACE);
  const task = await http("POST", pathOf("POST", "tasks"), morgan, { project_id: project.id, client_id: `docs-check-${stamp}`, title: `Book the review ${stamp}`, status: "todo", priority: "none" });
  await typeAtEnd(a);
  await a.keyboard.type(" See #Book the");
  check(await see(a, '[data-testid="doc-record-option"]'), "# finds a task from the body");
  await shot(a, "doc-link-picker-light");
  await a.keyboard.press("Enter");
  check(await see(a, '[data-testid="doc-record"] [data-kit="link-chip"]'), "the link lands as a chip with the task's name");
  check(await saved(a), "and it saves");
  const linked = await readDoc(brief.id);
  check(!linked.text.includes("Book the review"), "the title isn't copied into the doc's text");
  check(await see(a, '[data-testid="links-panel"] [data-kit="link-chip"]'), "the links panel shows it");
  const backlinks = await http("GET", `${pathOf("GET", "links")}?type=task&id=${task.id}`, morgan);
  check(backlinks.backlinks.some((l) => l.type === "doc" && l.id === brief.id), "the task shows the doc as a backlink");

  await a.click('[data-testid="docs-history-open"]');
  check(await see(a, '[data-testid="docs-version-preview"], [role="dialog"]'), "history opens");
  await sleep(500);
  await shot(a, "doc-history-light");
  await a.keyboard.press("Escape"); await sleep(150);
  const history = await http("GET", pathOf("GET", "docs/{id}/versions", { id: brief.id }), morgan);
  const first = history.at(-1);
  await http("POST", pathOf("POST", "docs/{id}/restore", { id: brief.id }), morgan, { version_id: first.id });
  const unlinked = await http("GET", `${pathOf("GET", "links")}?type=doc&id=${brief.id}`, morgan);
  check(!unlinked.forward.length, "restoring a version with no link removes the link");
  check(await seeText(a, "14th of March", 8000), "and the open editor shows the restored text");

  // ── The thread ───────────────────────────────────────────────────────────────────────────────────
  await a.click('[data-testid="doc-thread-empty"] [data-testid="composer-input"]');
  await a.keyboard.type("Should we hold this until the keys land?");
  await a.keyboard.press("Enter");
  check(await seeText(a, "Should we hold this until the keys land?"), "the first comment opens the doc's thread");
  await shot(a, "doc-thread-light");

  // ── An agent working here, from its run ──────────────────────────────────────────────────────────
  const asked = await readDoc(brief.id);
  await saveDoc(brief.id, morgan, asked.version, asked.title, [...asked.body.content, { type: "paragraph", content: [{ type: "mention", attrs: { id: scoutId, label: "Scout" } }, { type: "text", text: " check the dates, please." }] }]);
  check(await see(a, '[data-testid="agent-here"]', 8000), "naming an agent in a doc shows a run on it, from the run's row");
  await shot(a, "doc-agent-here-light");
  await a.click('[data-testid="agent-here"]');
  check(await see(a, '[data-testid="run-chip"]'), "the mark opens the run");
  await sleep(200); await shot(a, "doc-agent-run-light");
  await a.keyboard.press("Escape");

  // ── Who can't, and what's gone ───────────────────────────────────────────────────────────────────
  const guest = await open("Riley");
  const clientDoc = await makeDoc(morgan, CLIENT_ROOM, `Client notes ${stamp}`, [paragraph("Sizes run a little large this year.")]);
  await go(guest, `/docs/${clientDoc.id}`);
  check(await see(guest, '[data-testid="doc-read-only"]'), "a guest reads a doc with a plain note");
  check(!(await guest.$('[data-testid="suggestion-bar"]')), "and sees no suggestion bar");
  await shot(guest, "doc-guest-light");
  await go(guest, `/docs/${brief.id}`);
  check(await see(guest, '[data-testid="doc-not-found"]'), "a doc in another space can't be opened");
  await shot(guest, "doc-no-access-light");
  await go(a, "/docs/999999");
  check(await see(a, '[data-testid="doc-not-found"]'), "a doc that doesn't exist says so");

  const archiveSpace = await http("POST", pathOf("POST", "spaces"), avery, { name: `Old work ${stamp}`, visibility: "private" });
  await http("POST", pathOf("POST", "spaces/{id}/members", { id: archiveSpace.id }), avery, { user_id: morganMe.id, history_ok: true });
  const old = await makeDoc(morgan, archiveSpace.id, "Last year's plan", [paragraph("All done.")]);
  await http("PATCH", pathOf("PATCH", "spaces/{id}", { id: archiveSpace.id }), avery, { name: archiveSpace.name, visibility: "private", guests_can_create: false, archived: true });
  await go(a, `/docs/${old.id}`);
  check(await see(a, '[data-testid="doc-archived"]'), "an archived space's doc reads with a note");
  check(await a.$eval('[data-testid="docs-body"]', (e) => e.getAttribute("contenteditable") === "false"), "and can't be typed in");
  await shot(a, "doc-archived-light");

  // Removed while typing: what they wrote isn't lost with the screen.
  const roomy = await http("POST", pathOf("POST", "spaces"), avery, { name: `Short stay ${stamp}`, visibility: "private" });
  await http("POST", pathOf("POST", "spaces/{id}/members", { id: roomy.id }), avery, { user_id: morganMe.id, history_ok: true });
  const stay = await makeDoc(avery, roomy.id, "Shared for now", [paragraph("Read this.")]);
  await go(a, `/docs/${stay.id}`);
  await see(a, '[data-testid="doc-editor"]');
  await typeAtEnd(a);
  await a.keyboard.type("Words worth keeping.");
  await http("POST", pathOf("POST", "spaces/{id}/members/{user_id}/remove", { id: roomy.id, user_id: morganMe.id }), avery, {});
  check(await see(a, '[data-testid="doc-removed"]', 10000), "someone removed from the space is told, in place");
  check(await seeText(a, "Words worth keeping."), "and keeps what they wrote");
  await shot(a, "doc-removed-light");

  // A failed load, then a save that can't reach the server.
  await a.setRequestInterception(true);
  const failing = (r) => { if (r.url().includes("doc-list")) void r.respond({ status: 500, contentType: "application/json", body: '{"message":"The server is having a moment."}' }); else void r.continue(); };
  a.on("request", failing);
  await go(a, "/docs?q=fail");
  check(await see(a, '[data-testid="docs-failed"]', 10000), "a list that fails to load offers Try again");
  await shot(a, "list-failed-light");
  a.off("request", failing);
  const offline = (r) => { if (r.url().includes("/save")) void r.abort(); else void r.continue(); };
  a.on("request", offline);
  await go(a, path);
  await see(a, '[data-testid="doc-editor"]');
  await typeAtEnd(a);
  await a.keyboard.type("Typed while the network was down.");
  await a.waitForFunction(() => document.querySelector('[data-testid="docs-save-status"]')?.dataset.status === "offline", { timeout: 6000 }).catch(() => fail("offline", "the status didn't say so"));
  await shot(a, "doc-offline-light");
  a.off("request", offline);
  await a.setRequestInterception(false);
  check(await saved(a, 40000), "a save that failed lands when the network comes back");

  // ── A real agent, asked from inside a doc, with someone still typing ─────────────────────────────
  if (withModel) {
    const real = await makeDoc(morgan, SPACE, `Press plan ${stamp}`, [paragraph("The press date is the 14th of March, and the embargo lifts at nine.")]);
    await go(a, `/docs/${real.id}`);
    await see(a, '[data-testid="doc-editor"]');
    await typeAtEnd(a);
    await a.keyboard.type(" @Sco");
    await a.waitForSelector('[data-testid="docs-mention-menu"] [role="option"]', { timeout: 6000 });
    await a.keyboard.press("Enter");
    await a.keyboard.type(`please use save_doc to change "14th of March" to "21st of March", then finish. `);
    check(await saved(a), "the mention saves");
    check(await see(a, '[data-testid="agent-here"]', 10000), "the agent shows as working here");
    await shot(a, "real-agent-working-light");
    const line = "I'm still writing this part while the agent works on the dates, and I don't want to be interrupted.";
    let at = 0;
    const started = Date.now();
    while (!(await a.$('[data-testid="suggestion-bar"]')) && Date.now() - started < 120_000) { await a.keyboard.type(`${line.split(" ")[at++ % 19]} `); await sleep(250); }
    check(await see(a, '[data-testid="suggestion-bar"]', 1000), "a real agent's change arrives as a suggestion while someone types", `${Math.round((Date.now() - started) / 1000)} s`);
    check(await a.evaluate(() => !!document.activeElement?.closest('[data-testid="docs-body"]')), "their cursor stayed in the doc");
    check((await bodyText(a)).includes("14th of March"), "the doc's words are untouched");
    await shot(a, "real-agent-suggestion-light");
    await a.click('[data-testid="suggestion-dismiss"]');
    await gone(a, '[data-testid="suggestion-bar"]');
    check(await seeText(a, "dismissed this suggestion", 60_000), "the run's thread says it was dismissed");
    await a.waitForFunction(() => !document.querySelector('[data-testid="agent-here"][data-state="working"]'), { timeout: 90_000 }).catch(() => {});
    const runs = await http("GET", `${pathOf("GET", "agent-runs")}?doc_id=${real.id}`, morgan);
    check(!/\bedited\b/i.test(runs.items[0]?.last_note ?? ""), "the run never says Edited", runs.items[0]?.last_note);
    await shot(a, "real-agent-done-light");
  }

  // ── Both themes, desktop and phone ───────────────────────────────────────────────────────────────
  const pending = await http("POST", pathOf("POST", "doc-editing/{id}", { id: brief.id }), morgan, {});
  check(pending.ok, "the keystroke route answers");
  await agentFiles(brief.id, "The relaunch moves Marlow to the new storefront", "The relaunch moves Marlow onto the new storefront", "Reads better.");
  for (const theme of ["light", "dark"]) {
    const desk = await open("Morgan", { theme });
    await go(desk, "/docs"); await sleep(300); await shot(desk, `list-${theme}-desktop`); await axe(desk, `list, ${theme}`);
    await go(desk, path); await see(desk, '[data-testid="suggestion-bar"]'); await sleep(300); await shot(desk, `doc-${theme}-desktop`); await axe(desk, `doc, ${theme}`);
    await desk.close();
    const phone = await open("Morgan", { width: 390, height: 844, theme, mobile: true });
    await go(phone, "/docs"); await sleep(300); await shot(phone, `list-${theme}-phone`); await phoneChecks(phone, `list, ${theme}`); await axe(phone, `phone list, ${theme}`);
    await go(phone, path); await see(phone, '[data-testid="suggestion-bar"]'); await sleep(300); await shot(phone, `doc-${theme}-phone`); await phoneChecks(phone, `doc, ${theme}`); await axe(phone, `phone doc, ${theme}`);
    await go(phone, `${path}?pane=thread`); await sleep(400); await shot(phone, `thread-${theme}-phone`); await phoneChecks(phone, `thread, ${theme}`);
    await phone.close();
  }
} catch (e) {
  fail("the run stopped", e.stack ?? String(e));
} finally {
  await browser.close();
}
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(report.errors.length ? `\n${report.errors.length} failed` : "\nall passed");
process.exit(report.errors.length ? 1 : 0);

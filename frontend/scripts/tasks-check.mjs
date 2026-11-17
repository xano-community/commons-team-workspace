#!/usr/bin/env node
// Tasks in real windows, against a deployed backend: what a workflow test can't see. Keyboard-only work, a drag, two people
// in two browsers, a refused move rolling back by name, a saved filter across a reload, every state, the phone layout, and the
// speed budgets at 4x CPU throttle. Screenshots land in --out, to be looked at.
//
//   node frontend/scripts/tasks-check.mjs --backend <url> --frontend <url> [--out qa/tasks]
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
const out = resolve(opt("out", "qa/tasks"));
if (!backend || !frontend) { console.error("usage: tasks-check.mjs --backend <url> --frontend <url> [--out <dir>]"); process.exit(2); }
mkdirSync(out, { recursive: true });

const CPU_THROTTLE = 4;
const BUDGETS = { optimistic: { p75: 50, p95: 100 }, keyStep: { p75: 50, p95: 100 }, secondWindow: { p75: 250, p95: 500 } };
const report = { backend, frontend, cpuThrottle: CPU_THROTTLE, timings: {}, errors: [] };
const fail = (check, detail) => { report.errors.push({ check, detail }); console.log(`✗ ${check}: ${detail}`); };
const pass = (check, detail = "") => console.log(`✓ ${check}${detail ? `: ${detail}` : ""}`);
const check = (ok, what, detail = "") => (ok ? pass(what, detail) : fail(what, detail || "no"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const percentile = (sorted, p) => sorted[Math.ceil((p / 100) * sorted.length) - 1];
function judge(name, budget, samples) {
  const good = samples.filter((s) => s !== null).sort((a, b) => a - b);
  const missed = samples.length - good.length;
  const p75 = percentile(good, 75), p95 = percentile(good, 95);
  report.timings[name] = { samples: samples.length, missed, p75: Math.round(p75), p95: Math.round(p95), budget };
  check(!missed && p75 <= budget.p75 && p95 <= budget.p95, `${name} budget`, `p75 ${Math.round(p75)} ms, p95 ${Math.round(p95)} ms over ${samples.length} samples (${budget.p75}/${budget.p95})${missed ? `, ${missed} missed` : ""}`);
}

const routes = JSON.parse(execFileSync("npx", ["xanosdk", "routes", "./xano/index.ts", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).routes;
const pathOf = (verb, name, params = {}) => Object.entries(params).reduce((p, [k, v]) => p.replace(`{${k}}`, v), routes.find((r) => r.verb === verb && r.ref.split("/").slice(1).join("/") === name).path);
const http = async (verb, path, token, body) => {
  const res = await fetch(backend + path, { method: verb, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(`${verb} ${path}: ${res.status} ${JSON.stringify(json)}`), { status: res.status });
  return json;
};
const signIn = async (persona) => (await http("POST", pathOf("POST", "auth/demo"), null, { persona })).authToken;
const avery = await signIn("admin");
const morgan = await signIn("member");
const riley = await signIn("guest");
const meOf = (t) => http("GET", pathOf("GET", "auth/me"), t);
const [averyMe, morganMe, rileyMe] = await Promise.all([meOf(avery), meOf(morgan), meOf(riley)]);
const stamp = Date.now();
const makeSpace = async (name, members = [morganMe.id]) => {
  const space = await http("POST", pathOf("POST", "spaces"), avery, { name, visibility: "private" });
  for (const id of members) await http("POST", pathOf("POST", "spaces/{id}/members", { id: space.id }), avery, { user_id: id, history_ok: true });
  return space;
};
const makeProject = (space, name) => http("POST", pathOf("POST", "projects"), avery, { space_id: space.id, name });
let made = 0;
const makeTask = (project, title, more = {}) => http("POST", pathOf("POST", "tasks"), avery, { project_id: project.id, client_id: `check-${stamp}-${++made}`, title, status: "todo", priority: "none", ...more });
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

const browser = await launchBrowser();

async function open(index, { width = 1440, height = 900, theme = "light", mobile = false } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
  page.on("pageerror", (e) => fail("page error", e.message.slice(0, 200)));
  await page.goto(frontend, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="demo-login"]', { timeout: 20000 });
  // By name: sign-in lists Morgan first, and these indexes are the seed's order (Avery, Morgan, Riley).
  await page.evaluate((name) => [...document.querySelectorAll('[data-testid="demo-login"]')].find((b) => b.textContent?.includes(name))?.click(), ["Avery", "Morgan", "Riley"][index]);
  await page.waitForFunction(() => !document.querySelector('[data-testid="demo-login"]'), { timeout: 20000 });
  await page.waitForFunction(() => document.documentElement.dataset.live === "live", { timeout: 15000 });
  return page;
}
const go = async (page, path) => {
  await page.evaluate((p) => { history.pushState({}, "", p); dispatchEvent(new PopStateEvent("popstate")); }, path);
  await page.waitForNetworkIdle({ idleTime: 250, timeout: 8000 }).catch(() => {});
};
const see = (page, selector, timeout = 5000) => page.waitForSelector(selector, { timeout }).then(() => true).catch(() => false);
const seeText = (page, text, timeout = 5000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text).then(() => true).catch(() => false);
const gone = (page, text, timeout = 5000) => page.waitForFunction((t) => !document.body.innerText.includes(t), { timeout }, text).then(() => true).catch(() => false);
const column = (page, status) => page.evaluate((s) => [...document.querySelectorAll(`[data-kanban-column="${s}"] [data-kit="kanban-card"] > span`)].map((e) => e.textContent), status);
const press = async (page, ...keys) => { for (const k of keys) { await page.keyboard.press(k); await sleep(30); } };
const chord = async (page, mod, key) => { await page.keyboard.down(mod); await page.keyboard.press(key); await page.keyboard.up(mod); await sleep(30); };
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });
const axe = async (page, name) => {
  await page.evaluate(axeSource);
  const result = await page.evaluate(() => window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }));
  const bad = result.violations.map((v) => `${v.id} (${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(", ")})`);
  check(!bad.length, `${name}: axe`, bad.join("; "));
};
/** Every clickable thing on a phone is at least 44 px one way or the other's cell, and nothing runs off the side. */
const phoneChecks = async (page, name) => {
  const { wide, small } = await page.evaluate(() => {
    const seen = [...document.querySelectorAll('main a, main button, main [role="combobox"], main input, main textarea')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && !e.closest('[aria-hidden="true"]'); });
    return { wide: document.documentElement.scrollWidth > innerWidth + 1, small: seen.filter((e) => { const r = e.getBoundingClientRect(); return r.height < 43.5 && r.width < 43.5 || r.height < 30; }).map((e) => `${e.tagName}${e.dataset.testid ? `#${e.dataset.testid}` : ""}:${e.getAttribute("aria-label") ?? e.textContent.slice(0, 20)}`).slice(0, 8) };
  });
  check(!wide, `${name}: nothing runs off a 390 px screen`);
  check(!small.length, `${name}: touch targets are 44 px`, small.join(", "));
};

try {
  const space = await makeSpace(`Northwind ${stamp}`, [morganMe.id, rileyMe.id]);
  const launch = await makeProject(space, "Spring launch");
  const site = await makeProject(space, "Website refresh");
  const scoped = `/tasks?space=${space.id}`;

  // ── A team's real board, for the eye as much as for the checks ───────────────────────────────────
  const seeds = [
    ["Draft the launch announcement", { project: launch, status: "in_progress", priority: "high", due_on: day(2), assignee_id: morganMe.id }],
    ["Review pricing page copy", { project: site, status: "in_review", priority: "medium", due_on: day(1), assignee_id: averyMe.id }],
    ["Fix checkout redirect on Safari", { project: site, status: "todo", priority: "urgent", due_on: day(-1), assignee_id: morganMe.id }],
    ["Interview three beta customers", { project: launch, status: "todo", priority: "high", due_on: day(5) }],
    ["Prepare the press kit", { project: launch, status: "backlog", priority: "low" }],
    ["Update onboarding emails", { project: site, status: "backlog", priority: "none", due_on: day(12) }],
    ["Ship the status page", { project: site, status: "done", priority: "medium", assignee_id: averyMe.id }],
  ];
  const tasks = {};
  for (const [title, m] of seeds) { const { project, ...rest } = m; tasks[title] = await makeTask(project, title, rest); }

  const a = await open(0);
  const b = await open(1);
  await go(a, scoped); await go(b, scoped);
  check(await seeText(a, "Draft the launch announcement"), "the list shows a space's tasks");
  await shot(a, "list-light");
  check(await see(a, '[data-testid="task-group"]'), "the list groups tasks by status");

  // ── The whole of a task, by keyboard alone ───────────────────────────────────────────────────────
  await a.bringToFront();
  await a.mouse.click(700, 880);
  await press(a, "n");
  check(await see(a, '[data-testid="new-task"]'), "n opens a new task");
  check(await a.evaluate(() => !document.querySelector('[data-testid="new-task"]').getAnimations().some((x) => x.playState === "running")), "a dialog opened by a key doesn't animate");
  await a.keyboard.type("Book the launch venue");
  await press(a, "Enter");
  const seenFast = await a.waitForFunction(() => document.body.innerText.includes("Book the launch venue"), { timeout: 500 }).then(() => true).catch(() => false);
  check(seenFast, "a new task shows at once");
  await sleep(500);
  await press(a, "j");
  check(await a.evaluate(() => !!document.querySelector("[data-task-row][data-selected]")), "j selects a row");
  check(await a.evaluate(() => document.activeElement?.closest("[data-task-row]") !== null), "focus follows the selection, for a screen reader");
  const rowTitle = () => a.evaluate(() => document.querySelector("[data-task-row][data-selected] a span")?.textContent);
  const first = await rowTitle();
  await press(a, "j", "k");
  check(await rowTitle() === first, "k comes back");
  const pickFrom = async (word) => { await a.keyboard.type(word); await sleep(60); await press(a, "Enter"); };
  await press(a, "s"); check(await see(a, '[data-testid="task-menu"]', 1000), "s opens the status menu");
  check(await a.evaluate(() => !document.querySelector('[data-testid="task-menu"]').getAnimations({ subtree: true }).some((x) => x.playState === "running")), "a menu opened by a key doesn't animate");
  await pickFrom("In review");
  await press(a, "p"); await pickFrom("Urgent");
  await press(a, "a"); await see(a, '[data-testid="assign-option"]', 2000); await pickFrom("Morgan");
  await sleep(350);
  check(!(await a.$('[data-testid="task-menu"]')), "a menu closes when it's answered");
  const after = await http("GET", `${pathOf("GET", "tasks")}?space_id=${space.id}&q=${encodeURIComponent(first)}`, avery);
  check(after.items[0]?.status === "in_review" && after.items[0]?.priority === "urgent" && after.items[0]?.assignee_id === morganMe.id, "status, priority and assignee all saved by key", JSON.stringify(after.items[0] && [after.items[0].status, after.items[0].priority, after.items[0].assignee_id]));
  await press(a, "d"); await see(a, '[data-testid="due-input"]', 1000); await pickFrom("Tomorrow");
  await sleep(250);
  await press(a, "Enter");
  check(await see(a, '[data-testid="task-detail"]'), "Enter opens the task");
  await press(a, "w");
  check(await see(a, '[data-testid="task-editor"]'), "w edits it");
  await a.keyboard.type(" Confirm the room and catering.");
  await press(a, "Enter");
  check(await seeText(a, "Confirm the room and catering."), "the description saves from the keyboard");
  await press(a, "Escape");
  check(await see(a, '[data-testid="tasks-page"]'), "Escape goes back to the list");

  // ── ⌘K finds a task, from anywhere ──────────────────────────────────────────────────────────────
  await go(a, "/");
  await chord(a, "Meta", "k");
  await sleep(100);
  await a.keyboard.type("press kit");
  await sleep(700);
  await press(a, "Enter");
  check(await seeText(a, "Prepare the press kit", 3000) && await see(a, '[data-testid="task-detail"]', 3000), "⌘K finds a task and opens it");
  await chord(a, "Meta", "k");
  await sleep(100);
  await a.keyboard.type("new task");
  await sleep(200);
  await press(a, "Enter");
  check(await see(a, '[data-testid="new-task"]', 3000), "⌘K's New task works from any screen");
  await press(a, "Escape");
  await sleep(100);
  await press(a, "Shift+?".split("+")[1]);
  check(await seeText(a, "Move the card to the column on the right", 2000), "the ? sheet lists the task keys");
  await press(a, "Escape");
  await go(a, scoped);

  // ── An agent on a task, with its mark ───────────────────────────────────────────────────────────
  const scout = (await http("GET", pathOf("GET", "app/people"), avery)).find((p) => p.name === "Scout");
  await http("POST", pathOf("POST", "spaces/{id}/members", { id: space.id }), avery, { user_id: scout.id });
  const research = tasks["Interview three beta customers"];
  await go(a, `/tasks/${research.id}`);
  await press(a, "a");
  await see(a, '[data-testid="assign-option"]', 2000);
  await sleep(100);
  check(await a.evaluate(() => !!document.querySelector('[data-testid="task-menu"] [data-testid="agent-mark"]')), "the assignee picker marks an agent");
  await shot(a, "assign-agent-light");
  await a.keyboard.type("Scout");
  await sleep(80);
  await press(a, "Enter");
  check(await a.waitForFunction(() => document.querySelector('[data-field="assignee"]')?.textContent.includes("Scout") && !!document.querySelector('[data-field="assignee"] [data-testid="agent-mark"]'), { timeout: 2000 }).then(() => true).catch(() => false), "an agent on a task keeps its mark");
  await press(a, "Escape");
  await go(a, scoped);
  check(await a.waitForFunction(() => !!document.querySelector('[data-task-row] [data-kind="agent"]'), { timeout: 3000 }).then(() => true).catch(() => false), "a list row shows the agent's face");

  // ── Saved filters ────────────────────────────────────────────────────────────────────────────────
  await go(a, `${scoped}&priority=urgent`);
  check(await gone(a, "Prepare the press kit"), "a filter narrows the list");
  await a.click('[data-testid="save-view-button"]');
  await see(a, '[data-testid="save-view"]');
  await a.keyboard.type("Urgent work");
  await press(a, "Enter");
  check(await seeText(a, "Urgent work"), "a saved filter joins the strip");
  await a.reload({ waitUntil: "domcontentloaded" });
  await see(a, '[data-testid="tasks-page"]', 8000);
  await go(a, scoped);
  check(await seeText(a, "Urgent work", 6000), "a saved filter survives a reload");
  await a.evaluate(() => [...document.querySelectorAll('[data-testid="view-pill"]')].find((e) => e.textContent === "Urgent work").click());
  check(await gone(a, "Prepare the press kit"), "choosing it applies it");
  await a.click('[data-testid="view-delete"]');
  check(await gone(a, "Urgent work"), "a saved filter deletes");
  await go(a, `${scoped}&q=zebra-nothing`);
  check(await see(a, '[data-testid="tasks-no-match"]'), "nothing matched has its own state");
  await shot(a, "state-no-match-light");

  // ── The board, by key and by hand, in two windows ───────────────────────────────────────────────
  const boardPath = `${scoped}&view=board`;
  await go(a, boardPath); await go(b, boardPath);
  check(await see(a, '[data-signature-view="kanban"]'), "the board is the marked signature view");
  await shot(a, "board-light");
  await a.bringToFront();
  await a.mouse.click(5, 880);
  await press(a, "j");
  const selectedCard = () => a.evaluate(() => document.querySelector("[data-kanban-card][data-selected] [data-kit=kanban-card] > span")?.textContent);
  await sleep(100);
  const todoBefore = await column(a, "todo");
  await press(a, "ArrowRight");
  await sleep(60);
  check(todoBefore.includes(await selectedCard()), "arrows walk across columns", await selectedCard());
  const moving = await selectedCard();
  await chord(a, "Shift", "ArrowRight");
  await sleep(250);
  check((await column(a, "in_progress")).includes(moving), "shift and an arrow moves a card to the next column, with no pointer");
  check(await a.evaluate(() => !!document.activeElement?.closest("[data-kanban-card]")), "the card keeps focus after a keyboard move");
  await b.bringToFront();
  check(await b.waitForFunction((t) => [...document.querySelectorAll('[data-kanban-column="in_progress"] [data-kit="kanban-card"] > span')].some((e) => e.textContent === t), { timeout: 3000 }, moving).then(() => true).catch(() => false), "the move reaches the second window with no reload");

  // In-column order, across windows and a reload.
  await a.bringToFront();
  const before = await column(a, "in_progress");
  await chord(a, "Shift", "ArrowUp");
  await sleep(300);
  const reordered = await column(a, "in_progress");
  check(before.length < 2 || reordered.indexOf(moving) === before.indexOf(moving) - 1 || before.indexOf(moving) === 0, "shift and up moves a card up its column", reordered.join(" / "));
  await b.bringToFront();
  await sleep(600);
  check(JSON.stringify(await column(b, "in_progress")) === JSON.stringify(reordered), "the second window shows the same order", (await column(b, "in_progress")).join(" / "));
  await b.reload({ waitUntil: "domcontentloaded" });
  await see(b, '[data-signature-view="kanban"]', 8000); await sleep(600);
  check(JSON.stringify(await column(b, "in_progress")) === JSON.stringify(reordered), "the order survives a reload");

  // A real drag.
  await a.bringToFront();
  const dragged = (await column(a, "backlog"))[0];
  const drag = await a.evaluate(() => {
    const card = document.querySelector('[data-kanban-column="backlog"] [data-kanban-card]').getBoundingClientRect();
    const to = document.querySelector('[data-kanban-column="in_review"]').getBoundingClientRect();
    return { from: [card.x + 30, card.y + 20], to: [to.x + to.width / 2, to.y + to.height - 30] };
  });
  await a.mouse.move(...drag.from); await a.mouse.down(); await sleep(50);
  await a.mouse.move(drag.from[0] + 40, drag.from[1] + 10, { steps: 4 }); await a.mouse.move(...drag.to, { steps: 10 }); await sleep(80);
  await a.mouse.up(); await sleep(350);
  check((await column(a, "in_review")).at(-1) === dragged, "a dragged card lands where it's dropped", (await column(a, "in_review")).join(" / "));

  // ── A refused write rolls back, and says which task ─────────────────────────────────────────────
  await a.setRequestInterception(true);
  const refuse = (req) => {
    if (req.method() === "POST" && /\/tasks\/\d+\/move$/.test(req.url())) req.respond({ status: 400, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ code: "ERROR_CODE_INPUT_ERROR", message: "This space is archived." }) });
    else req.continue();
  };
  a.on("request", refuse);
  const rollback = (await column(a, "in_review"))[0];
  await a.evaluate((t) => { [...document.querySelectorAll("[data-kanban-card] [tabindex]")].find((e) => e.textContent.includes(t)).focus(); }, rollback);
  await sleep(80);
  await chord(a, "Shift", "ArrowRight");
  const shownThenBack = await a.waitForFunction((t) => [...document.querySelectorAll('[data-kanban-column="in_review"] [data-kit="kanban-card"] > span')].some((e) => e.textContent === t), { timeout: 2000 }, rollback).then(() => true).catch(() => false);
  check(shownThenBack, "a refused move goes back to its column");
  check(await seeText(a, `Couldn't move ${rollback} to Done. This space is archived.`, 3000), "a refusal names the task and the reason");
  await shot(a, "rollback-toast-light");
  a.off("request", refuse);
  await a.setRequestInterception(false);

  // ── A task: fields, links, a thread with a mark, and a reply reaching the inbox ─────────────────
  const venue = tasks["Draft the launch announcement"];
  await go(a, `/tasks/${venue.id}`); await go(b, `/tasks/${venue.id}`);
  check(await see(a, '[data-testid="task-thread-empty"]'), "a task with no comments says so");
  await a.bringToFront();
  await a.focus('[data-testid="task-thread"] [data-testid="composer-input"]');
  await a.keyboard.type("Morgan, can you share the outline today?");
  await press(a, "Enter");
  check(await seeText(a, "can you share the outline today", 4000), "the first comment starts the thread");
  await b.bringToFront();
  check(await seeText(b, "can you share the outline today", 4000), "the thread reaches the second window");
  await b.click('[data-testid="task-thread"] [data-testid="composer-input"]');
  await b.keyboard.type("Yes, by end of day.");
  await press(b, "Enter");
  await a.bringToFront();
  check(await seeText(a, "Yes, by end of day.", 4000), "a reply comes back");
  const aveInbox = await http("GET", pathOf("GET", "app/notifications"), avery);
  check(aveInbox.items.some((n) => n.kind === "reply" && n.link.startsWith(`/tasks/${venue.id}`)), "the reply is an inbox item that opens the task");
  await a.click('[data-testid="add-link"]');
  await sleep(250);
  await a.keyboard.type("press kit");
  await see(a, '[data-testid="add-link-option"]', 3000);
  await sleep(120);
  await press(a, "Enter");
  check(await a.waitForFunction(() => !!document.querySelector('[data-testid="links-panel"] [data-kit="link-chip"]'), { timeout: 3000 }).then(() => true).catch(() => false), "a link shows in the panel");
  await shot(a, "detail-light");
  await go(a, `/tasks/${tasks["Prepare the press kit"].id}`);
  check(await a.waitForFunction(() => /Linked from 1/.test(document.querySelector('[data-testid="links-panel"]')?.textContent ?? ""), { timeout: 3000 }).then(() => true).catch(() => false), "the other side shows the link");

  // ── Deleting, with its way back ─────────────────────────────────────────────────────────────────
  const doomed = await makeTask(launch, "Cancel the old domain");
  await go(a, `/tasks/${doomed.id}`);
  await chord(a, "Shift", "Backspace");
  check(await see(a, '[data-testid="task-trashed"]'), "a deleted task says so, and offers Restore");
  await shot(a, "state-trashed-light");
  await a.click('[data-testid="task-restore"]');
  check(await gone(a, "This task is in the trash"), "Restore brings it back");

  // ── Removal: the assignee, and an open editor ───────────────────────────────────────────────────
  const held = await makeTask(launch, "Sign off the budget", { assignee_id: morganMe.id });
  await go(b, `/tasks/${held.id}`);
  await b.bringToFront();
  await press(b, "w");
  await see(b, '[data-testid="task-editor"]');
  await b.keyboard.type("Words someone was typing");
  await sleep(100);
  await http("POST", pathOf("POST", "spaces/{id}/members/{user_id}/remove", { id: space.id, user_id: morganMe.id }), avery, {});
  check(await see(b, '[data-testid="task-removed"]', 6000), "someone removed sees that they lost access");
  check((await b.evaluate(() => document.querySelector('[data-testid="held-text"]')?.textContent ?? "")).includes("Words someone was typing"), "an open editor keeps its text, with Copy");
  await shot(b, "state-removed-light");
  await go(a, `/tasks/${held.id}`);
  check(await see(a, '[data-testid="task-left"]'), "the task says who left, and has nobody on it");
  await shot(a, "state-left-light");
  await http("POST", pathOf("POST", "spaces/{id}/members", { id: space.id }), avery, { user_id: morganMe.id });

  // ── Every other state ───────────────────────────────────────────────────────────────────────────
  const empty = await makeSpace(`Empty ${stamp}`, [rileyMe.id]);
  await go(a, `/tasks?space=${empty.id}`);
  check(await see(a, '[data-testid="tasks-no-project"], [data-testid="tasks-never"]'), "a space with no tasks says so");
  await shot(a, "state-empty-light");
  const finished = await makeSpace(`Finished ${stamp}`, []);
  const closed = await makeProject(finished, "Wrapped up");
  await makeTask(closed, "One last thing", { status: "done" });
  await go(a, `/tasks?space=${finished.id}`);
  check(await see(a, '[data-testid="tasks-all-done"]'), "all done has its own state");
  await shot(a, "state-all-done-light");
  await go(a, `/tasks?space=${finished.id}&view=board`);
  check(await see(a, '[data-signature-view="kanban"]'), "a finished board still shows its Done column");
  await go(a, "/tasks?space=2147483647");
  check(await see(a, '[data-testid="tasks-no-access"]'), "a space that can't be reached reads as not there");
  await go(a, "/tasks/2147483647");
  check(await see(a, '[data-testid="task-not-found"]'), "a task that can't be reached reads as not there");
  await shot(a, "state-not-found-light");
  await http("PATCH", pathOf("PATCH", "spaces/{id}", { id: finished.id }), avery, { name: finished.name, visibility: "private", guests_can_create: false, archived: true });
  await go(a, `/tasks?space=${finished.id}&finished=1`);
  check(await see(a, '[data-testid="tasks-archived"]'), "an archived space says it's read-only");
  await shot(a, "state-archived-light");

  // A guest: reads and comments, and is told why they can't change a task.
  const guest = await open(2);
  await go(guest, scoped);
  check(await see(guest, '[data-testid="tasks-read-only"]'), "a guest is told what they can do here");
  check(!(await guest.$('[data-testid="new-task-button"]')), "a guest has no New task");
  await shot(guest, "state-guest-light");
  await go(guest, `/tasks/${venue.id}`);
  check(await see(guest, '[data-testid="task-read-only"]'), "a guest reads a task, and can't change it");
  await go(guest, `/tasks?space=${empty.id}`);
  await guest.close();

  // ── Screens to look at, and what axe says ───────────────────────────────────────────────────────
  await go(a, scoped); await axe(a, "list");
  await go(a, boardPath); await axe(a, "board");
  await go(a, `/tasks/${venue.id}`); await sleep(400); await axe(a, "task");
  const dark = await open(0, { theme: "dark" });
  await go(dark, scoped); await sleep(300); await shot(dark, "list-dark"); await axe(dark, "list, dark");
  await go(dark, boardPath); await sleep(300); await shot(dark, "board-dark"); await axe(dark, "board, dark");
  await go(dark, `/tasks/${venue.id}`); await sleep(400); await shot(dark, "detail-dark"); await axe(dark, "task, dark");
  await dark.keyboard.press("s"); await sleep(250); await shot(dark, "menu-dark"); await dark.keyboard.press("Escape");
  await dark.close();

  for (const theme of ["light", "dark"]) {
    const phone = await open(0, { width: 390, height: 844, theme, mobile: true });
    await go(phone, scoped); await sleep(300); await shot(phone, `phone-list-${theme}`); await phoneChecks(phone, `phone list, ${theme}`);
    check(await phone.evaluate(() => [...document.querySelectorAll('[data-kit="bottom-nav"] a')].map((e) => e.textContent.trim()).join()).then((t) => /Inbox.*Chat.*Tasks/.test(t)), "the bottom bar shows Inbox, Chat and Tasks");
    await go(phone, boardPath); await sleep(300); await shot(phone, `phone-board-${theme}`); await phoneChecks(phone, `phone board, ${theme}`);
    check(await phone.evaluate(() => { const el = document.querySelector('[data-signature-view="kanban"]'); return el.scrollWidth > el.clientWidth; }), "a phone's board scrolls by column");
    await go(phone, `/tasks/${venue.id}`); await sleep(400); await shot(phone, `phone-detail-${theme}`); await phoneChecks(phone, `phone task, ${theme}`);
    check(await phone.evaluate(() => getComputedStyle(document.querySelector('[data-testid="task-thread"]')).display === "none"), "a phone shows one pane at a time");
    await go(phone, `/tasks/${venue.id}?pane=thread`); await sleep(400); await shot(phone, `phone-thread-${theme}`); await phoneChecks(phone, `phone thread, ${theme}`);
    await phone.close();
  }

  // ── Speed, at 4x throttle ───────────────────────────────────────────────────────────────────────
  const big = await makeSpace(`Big ${stamp}`, [morganMe.id]);
  const bigProject = await makeProject(big, "A long backlog");
  for (let i = 0; i < 300; i += 20) await Promise.all(Array.from({ length: 20 }, (_, n) => makeTask(bigProject, `Backlog item ${i + n + 1}`, { status: ["backlog", "todo", "in_progress"][n % 3] })));
  const fast = await open(0);
  const cdp = await fast.createCDPSession();
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
  await go(fast, `/tasks?space=${big.id}&view=board`);
  await see(fast, '[data-signature-view="kanban"]', 10000); await sleep(1500);
  const mounted = await fast.evaluate(() => document.querySelectorAll("[data-kanban-card]").length);
  check(mounted < 120, "a 300-card board draws only what can be seen", `${mounted} cards mounted`);
  const paint = (selector, action) => fast.evaluate((sel, act) => new Promise((resolve) => {
    const start = performance.now();
    const seen = () => { if (eval(act)) { requestAnimationFrame(() => resolve(performance.now() - start)); return; } if (performance.now() - start > 2000) resolve(null); else requestAnimationFrame(seen); };
    document.querySelector(sel)?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true }));
    requestAnimationFrame(seen);
  }), selector, action);
  await fast.mouse.click(5, 880);
  await press(fast, "j"); await sleep(200);
  const optimistic = [], keys = [];
  for (let i = 0; i < 20; i++) {
    const id = await fast.evaluate(() => document.querySelector("[data-kanban-card][data-selected]")?.dataset.kanbanCard);
    const from = await fast.evaluate(() => document.querySelector("[data-kanban-card][data-selected]")?.closest("[data-kanban-column]").dataset.kanbanColumn);
    const right = from !== "done";
    const start = await fast.evaluate(() => performance.now());
    await fast.keyboard.down("Shift"); await fast.keyboard.press(right ? "ArrowRight" : "ArrowLeft"); await fast.keyboard.up("Shift");
    const took = await fast.evaluate((card, was, t0) => new Promise((resolve) => {
      const tick = () => { const col = document.querySelector(`[data-kanban-card="${card}"]`)?.closest("[data-kanban-column]")?.dataset.kanbanColumn; if (col && col !== was) requestAnimationFrame(() => resolve(performance.now() - t0)); else if (performance.now() - t0 > 1500) resolve(null); else requestAnimationFrame(tick); };
      tick();
    }), id, from, start);
    optimistic.push(took);
    await sleep(220);
  }
  const measures = await fast.evaluate(() => performance.getEntriesByName("optimistic", "measure").map((m) => m.duration));
  judge("optimistic", BUDGETS.optimistic, measures.slice(-20));
  report.timings.optimisticRoundTrip = { samples: optimistic.length, note: "script round trip, includes CDP overhead", p75: Math.round(percentile(optimistic.filter(Boolean).sort((x, y) => x - y), 75)) };
  for (let i = 0; i < 20; i++) {
    const start = await fast.evaluate(() => { window.__t = performance.now(); return window.__t; });
    await fast.keyboard.press(i % 2 ? "k" : "j");
    keys.push(await fast.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - window.__t), 0)))));
    await sleep(60);
  }
  report.timings.keyStep = { samples: keys.length, p75: Math.round(percentile([...keys].sort((x, y) => x - y), 75)), note: "includes the script's CDP round trip" };
  console.log(`  j/k step, with script overhead: p75 ${report.timings.keyStep.p75} ms`);
  await fast.close();

  // Second window: from the moment one window sends, to the other painting it.
  const w1 = await open(0), w2 = await open(1);
  await go(w1, `/tasks?space=${big.id}&view=board`); await go(w2, `/tasks?space=${big.id}&view=board`);
  await sleep(1200);
  const second = [];
  const target = await makeTask(bigProject, "Travels between windows", { status: "in_review" });
  await sleep(800);
  for (let i = 0; i < 12; i++) {
    const to = i % 2 ? "in_review" : "done";
    await w2.evaluate((id, col) => { window.__seen = new Promise((resolve) => { const t0 = performance.now(); const tick = () => { const at = document.querySelector(`[data-kanban-card="${id}"]`)?.closest("[data-kanban-column]")?.dataset.kanbanColumn; if (at === col) resolve(performance.now() - t0); else if (performance.now() - t0 > 3000) resolve(null); else requestAnimationFrame(tick); }; tick(); }); }, target.id, to);
    await http("POST", pathOf("POST", "tasks/{id}/move", { id: target.id }), avery, { status: to, before_id: 0 });
    second.push(await w2.evaluate(() => window.__seen));
    await sleep(300);
  }
  judge("secondWindow", BUDGETS.secondWindow, second);
  await w1.close(); await w2.close();
} catch (e) {
  fail("the run stopped", e.stack?.slice(0, 500) ?? String(e));
} finally {
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(report.errors.length ? `✗ ${report.errors.length} check(s) failed: ${join(out, "report.json")}` : `✓ tasks: every check passed: ${join(out, "report.json")}`);
  process.exit(report.errors.length ? 1 : 0);
}

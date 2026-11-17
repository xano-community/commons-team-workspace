#!/usr/bin/env node
// Customers in real windows, against a deployed backend: what a workflow test can't see. Keyboard-only work, a drag, two people in two
// browsers, a refused move rolling back by name, a company page that differs by viewer, the guest's walk, the note warning, every
// designed state, the phone layout, and the speed budgets at 4x CPU throttle. Screenshots land in --out, to be looked at.
//
//   node frontend/scripts/crm-check.mjs --backend <url> --frontend <url> [--out qa/crm]
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
const out = resolve(opt("out", "qa/crm"));
if (!backend || !frontend) { console.error("usage: crm-check.mjs --backend <url> --frontend <url> [--out <dir>]"); process.exit(2); }
mkdirSync(out, { recursive: true });

const CPU_THROTTLE = 4;
const BUDGETS = { optimistic: { p75: 50, p95: 100 }, secondWindow: { p75: 250, p95: 500 } };
const report = { backend, frontend, cpuThrottle: CPU_THROTTLE, timings: {}, errors: [] };
const fail = (what, detail) => { report.errors.push({ check: what, detail }); console.log(`✗ ${what}: ${detail}`); };
const check = (ok, what, detail = "") => (ok ? console.log(`✓ ${what}${detail ? `: ${detail}` : ""}`) : fail(what, detail || "no"));
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
const stamp = Date.now();
let made = 0;
const key = () => `crm-check-${stamp}-${++made}`;

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
const press = async (page, ...keys) => { for (const k of keys) { await page.keyboard.press(k); await sleep(30); } };
const shift = async (page, k) => { await page.keyboard.down("Shift"); await page.keyboard.press(k); await page.keyboard.up("Shift"); await sleep(40); };
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });
const column = (page, id) => page.evaluate((s) => [...document.querySelectorAll(`[data-kanban-column="${s}"] [data-kit="kanban-card"] > span`)].map((e) => e.textContent), String(id));
const selectedTitle = (page) => page.evaluate(() => document.querySelector("[data-kanban-card][data-selected] [data-kit=kanban-card] > span")?.textContent);
const countOf = (page, panel) => page.evaluate((p) => Number(document.querySelector(`[data-testid="panel-${p}"] [data-testid="panel-count"]`)?.textContent), panel);
const axe = async (page, name) => {
  await page.evaluate(axeSource);
  const result = await page.evaluate(() => window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }));
  const bad = result.violations.map((v) => `${v.id} (${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(", ")})`);
  check(!bad.length, `${name}: axe`, bad.join("; "));
};
/** Every clickable thing on a phone is big enough to hit, and nothing runs off the side. */
const phoneChecks = async (page, name) => {
  const { wide, small } = await page.evaluate(() => {
    const seen = [...document.querySelectorAll('main a, main button, main [role="combobox"], main input, main textarea')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; });
    return { wide: document.documentElement.scrollWidth > innerWidth + 1, small: seen.filter((e) => { const r = e.getBoundingClientRect(); return (r.height < 43.5 && r.width < 43.5) || r.height < 30; }).map((e) => `${e.tagName}:${(e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 24)}`).slice(0, 6) };
  });
  check(!wide, `${name}: nothing runs off a 390 px screen`);
  check(!small.length, `${name}: touch targets are 44 px`, small.join(", "));
};
/** A screen as it'd be if the server answered this: for the states seed data can't reach. */
async function withAnswer(page, match, answer, run) {
  await page.setRequestInterception(true);
  const on = (req) => { if (req.method() === "GET" && match.test(req.url())) req.respond({ headers: { "access-control-allow-origin": "*" }, contentType: "application/json", ...answer(req) }); else req.continue(); };
  page.on("request", on);
  await run();
  page.off("request", on);
  await page.setRequestInterception(false);
}

try {
  const setup = await http("GET", pathOf("GET", "crm-setup"), avery);
  const stageNamed = (name) => setup.stages.find((s) => s.name === name);
  const [lead, proposal, won] = [stageNamed("Lead"), stageNamed("Proposal"), stageNamed("Won")];
  const companies = (await http("GET", pathOf("GET", "companies"), avery)).items;
  const marlow = companies.find((c) => c.name === "Marlow Cycles");
  check(companies.length === 7 && marlow, "the seed world has its companies", `${companies.length}`);
  const dealOn = (title, stage, more = {}) => http("POST", pathOf("POST", "deals"), avery, { client_id: key(), company_id: marlow.id, stage_id: stage.id, title, value: 2500, ...more });

  const a = await open(0);
  const b = await open(1);
  await go(a, "/crm"); await go(b, "/crm");
  check(await see(a, '[data-signature-view="crm"]'), "the pipeline is a marked signature view");
  check(await seeText(a, "Marlow care plan"), "the board shows the seeded deals");
  check(await seeText(a, "Customers"), "the nav says Customers");
  await sleep(300);
  await shot(a, "pipeline-light");
  await axe(a, "pipeline");

  // ── The whole of a deal, by keyboard alone ───────────────────────────────────────────────────────
  await a.bringToFront();
  await a.mouse.click(1300, 880);
  await press(a, "n");
  check(await see(a, '[data-testid="deal-dialog"]', 1500), "n opens a new deal");
  check(await a.evaluate(() => !document.querySelector('[data-testid="deal-dialog"]').getAnimations().some((x) => x.playState === "running")), "a dialog opened by a key doesn't animate");
  await a.keyboard.type(`Keyboard deal ${stamp}`);
  await a.click('[data-testid="deal-company"]');
  await see(a, '[data-testid="deal-company-option"]', 3000);
  await a.keyboard.type("Marlow");
  await a.waitForFunction(() => { const o = [...document.querySelectorAll('[data-testid="deal-company-option"]')]; return o.length === 1 && o[0].textContent.includes("Marlow"); }, { timeout: 3000 });
  await press(a, "Enter");
  await sleep(100);
  await a.type('[data-testid="deal-value"]', "4200");
  await press(a, "Enter");
  check(await a.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 500 }, `Keyboard deal ${stamp}`).then(() => true).catch(() => false), "a new deal shows at once");
  await sleep(600);
  await a.mouse.click(1300, 880);
  await press(a, "Escape", "j");
  check(!!(await selectedTitle(a)), "j selects a card");
  check(await a.evaluate(() => document.activeElement?.closest("[data-kanban-card]") !== null), "focus follows the selection, for a screen reader");
  const first = await selectedTitle(a);
  await press(a, "ArrowRight");
  check(await selectedTitle(a) !== first, "an arrow walks to the next stage");
  await press(a, "ArrowLeft");
  check(await selectedTitle(a) === first, "and back");
  const created = (await http("GET", `${pathOf("GET", "pipeline")}?q=${stamp}`, avery)).items[0];
  check(created?.value === 4200 && created.stage_id === lead.id && created.company_name === "Marlow Cycles", "the new deal saved its value, stage and company", JSON.stringify(created));
  await a.evaluate((t) => { [...document.querySelectorAll("[data-kanban-card] [tabindex]")].find((e) => e.textContent.includes(t)).focus(); }, created.title);
  await press(a, "s");
  check(await see(a, '[data-testid="crm-menu"]', 1000), "s opens the stage menu");
  await a.keyboard.type("Proposal"); await sleep(60); await press(a, "Enter");
  await press(a, "a"); await see(a, '[data-testid="owner-option"]', 2000); await a.keyboard.type("Morgan"); await sleep(80); await press(a, "Enter");
  await sleep(400);
  const moved = await http("GET", pathOf("GET", "deals/{id}", { id: created.id }), avery);
  check(moved.deal.stage_id === proposal.id && moved.deal.owner_name === "Morgan Reyes", "stage and owner both saved by key", `${moved.deal.stage_name} ${moved.deal.owner_name}`);
  await shift(a, "ArrowRight");
  await sleep(350);
  const across = await http("GET", pathOf("GET", "deals/{id}", { id: created.id }), avery);
  check(across.deal.stage_name === "Negotiation", "shift and an arrow moves the card a stage", across.deal.stage_name);
  await press(a, "Enter");
  check(await see(a, '[data-testid="deal-detail"]'), "Enter opens the deal");
  await press(a, "w");
  check(await see(a, '[data-testid="edit-deal-dialog"]', 1500), "w edits it");
  await press(a, "Escape");
  await sleep(150);
  await press(a, "Escape");
  check(await see(a, '[data-testid="crm-board"]'), "Escape goes back to the board");

  // ── ⌘K, and the ? sheet ─────────────────────────────────────────────────────────────────────────
  await go(a, "/");
  await a.keyboard.down("Meta"); await a.keyboard.press("k"); await a.keyboard.up("Meta");
  await sleep(100);
  await a.keyboard.type("Harbour");
  await sleep(700);
  await press(a, "Enter");
  check(await see(a, '[data-testid="company-detail"]', 3000) && await seeText(a, "Harbour Line Ferries"), "⌘K finds a company and opens it");
  await a.keyboard.down("Meta"); await a.keyboard.press("k"); await a.keyboard.up("Meta");
  await sleep(100);
  await a.keyboard.type("new company");
  await sleep(200);
  await press(a, "Enter");
  check(await see(a, '[data-testid="company-dialog"]', 3000), "⌘K's New company works from any screen");
  await press(a, "Escape");
  await sleep(120);
  await go(a, "/crm");
  await press(a, "g", "c");
  check(await see(a, '[data-testid="crm-board"]', 2000), "g c goes to customers");

  // ── A real drag ─────────────────────────────────────────────────────────────────────────────────
  const dragged = (await column(a, lead.id))[0];
  const drag = await a.evaluate((from, to) => {
    const card = document.querySelector(`[data-kanban-column="${from}"] [data-kanban-card]`).getBoundingClientRect();
    const target = document.querySelector(`[data-kanban-column="${to}"]`).getBoundingClientRect();
    return { from: [card.x + 40, card.y + 20], to: [target.x + 60, target.y + target.height - 40] };
  }, String(lead.id), String(proposal.id));
  await a.mouse.move(...drag.from); await a.mouse.down(); await sleep(50);
  await a.mouse.move(drag.from[0] + 40, drag.from[1] + 10, { steps: 4 }); await a.mouse.move(...drag.to, { steps: 10 }); await sleep(80);
  await a.mouse.up(); await sleep(450);
  check((await column(a, proposal.id)).at(-1) === dragged, "a dragged card lands where it's dropped", (await column(a, proposal.id)).join(" / "));

  // ── Two windows ─────────────────────────────────────────────────────────────────────────────────
  check(await b.waitForFunction((t, s) => [...document.querySelectorAll(`[data-kanban-column="${s}"] [data-kit="kanban-card"] > span`)].some((e) => e.textContent === t), { timeout: 3000 }, dragged, String(proposal.id)).then(() => true).catch(() => false), "moving a deal updates a second window");
  await shot(b, "second-window-light");

  // ── A refused move rolls back, and says which deal ──────────────────────────────────────────────
  await a.setRequestInterception(true);
  const refuse = (req) => {
    if (req.method() === "POST" && /\/deals\/\d+\/(stage|move)$/.test(req.url())) req.respond({ status: 400, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ code: "ERROR_CODE_BAD_REQUEST", message: "This record was deleted." }) });
    else req.continue();
  };
  a.on("request", refuse);
  const rollback = (await column(a, proposal.id))[0];
  await a.evaluate((t) => { [...document.querySelectorAll("[data-kanban-card] [tabindex]")].find((e) => e.textContent.includes(t)).focus(); }, rollback);
  await shift(a, "ArrowRight");
  check(await seeText(a, `Couldn't move ${rollback} to Negotiation. This record was deleted.`, 2000), "a refused move names the deal", rollback);
  await sleep(300);
  check((await column(a, proposal.id)).includes(rollback), "and the card goes back");
  await shot(a, "move-refused-light");
  a.off("request", refuse);
  await a.setRequestInterception(false);

  // ── A company page, for two viewers ──────────────────────────────────────────────────────────────
  const secret = await http("POST", pathOf("POST", "spaces"), avery, { name: `Board pack ${stamp}`, visibility: "private" });
  const project = await http("POST", pathOf("POST", "projects"), avery, { space_id: secret.id, name: "Renewal" });
  const hidden = await http("POST", pathOf("POST", "tasks"), avery, { project_id: project.id, client_id: key(), title: `Private pricing ${stamp}`, status: "todo", priority: "none" });
  await http("POST", pathOf("POST", "links"), avery, { from_type: "task", from_id: hidden.id, to_type: "company", to_id: marlow.id });
  const page = `/crm/companies/${marlow.id}`;
  await go(a, page); await go(b, page);
  await see(a, '[data-testid="crm-panels"]'); await see(b, '[data-testid="crm-panels"]');
  await sleep(300);
  const [averyTasks, morganTasks] = [await countOf(a, "tasks"), await countOf(b, "tasks")];
  check(averyTasks === morganTasks + 1, "two viewers see different counts on one company", `Avery ${averyTasks}, Morgan ${morganTasks}`);
  check(await seeText(a, `Private pricing ${stamp}`, 1000), "the one who reaches it sees the task");
  check(!(await b.evaluate((t) => document.body.innerText.includes(t), `Private pricing ${stamp}`)), "the other sees no trace of it");
  await shot(a, "company-light");
  await axe(a, "company page");
  await b.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);

  // ── Linking a task to a company from chat ──────────────────────────────────────────────────────
  const conversations = await http("GET", pathOf("GET", "conversations"), morgan);
  const launch = conversations.find((c) => c.name === "marlow-launch");
  const tasks = (await http("GET", `${pathOf("GET", "tasks")}?q=${encodeURIComponent("runbook")}`, morgan)).items;
  const before = await countOf(b, "tasks");
  await http("POST", pathOf("POST", "conversations/{id}/messages", { id: launch.id }), morgan, { client_msg_id: key(), body: `<#company:${marlow.id}> is waiting on <#task:${tasks[0].id}>` });
  check(await b.waitForFunction((n) => Number(document.querySelector('[data-testid="panel-tasks"] [data-testid="panel-count"]')?.textContent) === n, { timeout: 4000 }, before + 1).then(() => true).catch(() => false), "a task linked from chat shows on the company page, live", `${before} -> ${await countOf(b, "tasks")}`);

  // ── The note warning ───────────────────────────────────────────────────────────────────────────
  await a.bringToFront();
  const box = '[data-testid="crm-notes"] [data-testid="composer-input"]';
  await see(a, box);
  await a.click(box);
  await a.keyboard.type("Pricing is 40% off for @Ril");
  await sleep(150);
  await press(a, "Enter");
  check(await see(a, '[data-kit="mention-warning"]', 3000), "naming a guest in a note shows the warning");
  check(await seeText(a, "can't open customers, so won't be told", 1000), "the warning says what happens");
  check(!(await a.evaluate(() => document.querySelector('[data-kit="mention-warning"]').innerText.includes("Add to space"))), "and it offers no add");
  await press(a, "Enter");
  await sleep(200);
  check(!(await seeText(a, "Pricing is 40% off", 300).then(async (t) => t && await a.$('[data-testid="crm-note"]') && await a.evaluate(() => [...document.querySelectorAll('[data-testid="crm-note"]')].some((n) => n.innerText.includes("Pricing is 40% off"))))), "Enter holds while the warning shows");
  await shot(a, "note-warning-light");
  await a.evaluate(() => [...document.querySelectorAll('[data-kit="mention-warning"] button')].find((x) => x.textContent === "Send anyway").click());
  check(await a.waitForFunction(() => [...document.querySelectorAll('[data-testid="crm-note"]')].some((n) => n.innerText.includes("Pricing is 40% off")), { timeout: 3000 }).then(() => true).catch(() => false), "Send anyway adds the note");
  await sleep(500);
  const guestInbox = await http("GET", pathOf("GET", "app/notifications"), riley);
  check(!JSON.stringify(guestInbox).includes("40%") && !(guestInbox.items ?? []).some((n) => /mentioned you/.test(n.title) && (n.link ?? "").includes("/crm")), "and nothing of it reaches the guest");

  // ── The guest's walk ───────────────────────────────────────────────────────────────────────────
  const g = await open(2);
  check(!(await g.evaluate(() => [...document.querySelectorAll("nav a")].some((x) => x.textContent.includes("Customers")))), "a guest's nav has no Customers");
  await go(g, "/crm");
  check(await see(g, '[data-testid="crm-no-access"]'), "a guest who types the address sees the no-permission state");
  await shot(g, "no-access-light");
  await go(g, page);
  check(await see(g, '[data-testid="crm-no-access"]'), "and the same on a company's page");
  check(!(await g.evaluate(() => document.body.innerText.includes("Marlow Cycles"))), "with no name on it");
  const client = conversations.find((c) => c.name === "marlow-oakline");
  await http("POST", pathOf("POST", "conversations/{id}/messages", { id: client.id }), morgan, { client_msg_id: key(), body: `Update on <#company:${marlow.id}> is in the deck.` });
  await go(g, `/chat/${client.id}`);
  check(await g.waitForFunction(() => !!document.querySelector('[data-kit="link-chip"][data-state="locked"]'), { timeout: 5000 }).then(() => true).catch(() => false), "a guest sees a locked chip for a company");
  check(!(await g.evaluate(() => [...document.querySelectorAll('[data-kit="link-chip"]')].some((c) => c.textContent.includes("Marlow Cycles")))), "with no title on it");
  await shot(g, "locked-chip-light");
  await g.close();

  // ── Every designed state ───────────────────────────────────────────────────────────────────────
  await go(a, "/crm?q=zzz-nothing");
  check(await see(a, '[data-testid="crm-no-match"]'), "nothing matched has its own state");
  await shot(a, "state-no-match-light");
  await go(a, "/crm");
  const empty = (over) => () => ({ status: 200, body: JSON.stringify({ stages: setup.stages.map((s) => ({ ...s, deals: 0, value: 0 })), items: [], ever: 0, open: 0, companies: 0, limit: 100, ...over }) });
  await withAnswer(a, /\/pipeline/, empty({}), async () => {
    await go(a, "/crm/contacts"); await go(a, "/crm");
    await a.evaluate(() => dispatchEvent(new Event("focus")));
    check(await see(a, '[data-testid="crm-no-companies"]'), "never had any has its own state");
    await shot(a, "state-no-companies-light");
  });
  await withAnswer(a, /\/pipeline/, empty({ companies: 3 }), async () => {
    await go(a, "/crm/contacts"); await go(a, "/crm");
    check(await see(a, '[data-testid="crm-no-deals"]'), "companies with no deals has its own state");
    await shot(a, "state-no-deals-light");
  });
  await withAnswer(a, /\/pipeline/, () => ({ status: 200, body: JSON.stringify({ stages: setup.stages.map((s) => ({ ...s, deals: s.kind === "won" ? 1 : 0, value: s.kind === "won" ? 9000 : 0 })), items: [{ id: 999991, title: "Closed deal", stage_id: won.id, stage_kind: "won", stage_name: "Won", rank: 1, value: 9000, company_name: "Marlow Cycles", owner_id: 0, closed_at: 1, deleted_at: null, close_on: null }], ever: 1, open: 0, companies: 3, limit: 100 }) }), async () => {
    await go(a, "/crm/contacts"); await go(a, "/crm");
    check(await see(a, '[data-testid="crm-all-closed"]'), "all closed has its own state, above the board");
    await shot(a, "state-all-closed-light");
  });
  await withAnswer(a, /\/pipeline/, () => ({ status: 500, body: JSON.stringify({ message: "The server stopped answering." }) }), async () => {
    await a.evaluate(() => { window.__retry = true; });
    await go(a, "/crm?close=month");
    check(await see(a, '[data-testid="crm-failed"]', 12000), "a failed load has its own state, with Try again");
    await shot(a, "state-failed-light");
  });
  await go(a, "/crm");
  await go(a, "/crm/companies?q=zzz-nothing");
  check(await see(a, '[data-testid="companies-no-match"]'), "a list has its own nothing matched");
  await go(a, "/crm/companies");
  check(await see(a, '[data-testid="company-list"]'), "the companies list shows");
  await press(a, "j", "j");
  check(await a.evaluate(() => !!document.querySelector('[data-row][data-selected]')), "j walks the companies list");
  await shot(a, "companies-light");
  await axe(a, "companies");
  await go(a, "/crm/contacts");
  check(await see(a, '[data-testid="contact-list"]'), "the contacts list shows");
  await shot(a, "contacts-light");
  await go(a, "/crm?space=1");
  check(await see(a, '[data-testid="crm-all-spaces"]'), "a chosen space says it doesn't narrow customers");
  await go(a, "/crm/companies/999999");
  check(await see(a, '[data-testid="crm-record-not-found"]'), "a company that isn't there reads as not found");
  await shot(a, "state-not-found-light");

  // ── A deal deleted, then back ──────────────────────────────────────────────────────────────────
  const bin = await dealOn(`Trash me ${stamp}`, lead);
  await go(a, `/crm/deals/${bin.id}`);
  await see(a, '[data-testid="deal-detail"]');
  await a.keyboard.down("Shift"); await a.keyboard.press("Backspace"); await a.keyboard.up("Shift");
  check(await seeText(a, `Deleted Trash me ${stamp}`, 2000), "a delete says what went, with Undo");
  await see(a, '[data-testid="crm-trashed"]', 2000);
  await a.reload({ waitUntil: "domcontentloaded" });
  check(await see(a, '[data-testid="crm-trashed"]', 6000), "a deleted deal says it's in the trash");
  await shot(a, "state-trashed-light");
  await a.click('[data-testid="crm-restore"]');
  check(await a.waitForFunction(() => !document.querySelector('[data-testid="crm-trashed"]'), { timeout: 3000 }).then(() => true).catch(() => false), "and Restore brings it back");

  // ── Stages, for an admin ───────────────────────────────────────────────────────────────────────
  await go(a, "/crm");
  await a.click('[data-testid="stages-button"]');
  check(await see(a, '[data-testid="stages-dialog"]'), "an admin can edit the stages");
  await a.type('[data-testid="stage-new"]', `Discovery ${stamp}`);
  await press(a, "Enter");
  check(await a.waitForFunction((n) => document.querySelectorAll('[data-testid="stage-row"]').length === n, { timeout: 3000 }, setup.stages.length + 1).then(() => true).catch(() => false), "a new stage joins the list");
  await shot(a, "stages-light");
  const holding = await a.evaluate(() => { const rows = [...document.querySelectorAll('[data-testid="stage-row"]')]; const lead = rows.find((r) => r.querySelector("input").value === "Lead"); lead.querySelector('[data-testid="stage-delete"]').click(); return true; });
  check(holding && await see(a, '[data-testid="stages-problem"]', 2000), "a stage with deals says to move them first");
  await a.evaluate((n) => { [...document.querySelectorAll('[data-testid="stage-row"]')].find((r) => r.querySelector("input").value === n).querySelector('[data-testid="stage-delete"]').click(); }, `Discovery ${stamp}`);
  await a.waitForFunction((n) => document.querySelectorAll('[data-testid="stage-row"]').length === n, { timeout: 3000 }, setup.stages.length).catch(() => {});
  await press(a, "Escape");
  await go(b, "/crm");
  check(!(await b.$('[data-testid="stages-button"]')), "a member doesn't get the stages button");

  // ── Dark ───────────────────────────────────────────────────────────────────────────────────────
  const dark = await open(0, { theme: "dark" });
  await go(dark, "/crm"); await see(dark, '[data-testid="crm-board"]'); await sleep(300); await shot(dark, "pipeline-dark");
  await axe(dark, "pipeline in dark");
  await go(dark, page); await see(dark, '[data-testid="crm-panels"]'); await sleep(300); await shot(dark, "company-dark");
  const care = (await http("GET", `${pathOf("GET", "pipeline")}?q=${encodeURIComponent("Marlow care plan")}`, avery)).items[0];
  await go(dark, `/crm/deals/${care.id}`); await see(dark, '[data-testid="crm-notes"]'); await sleep(500); await shot(dark, "deal-dark");
  await go(dark, "/crm/companies"); await sleep(250); await shot(dark, "companies-dark");
  await dark.close();
  await go(a, `/crm/deals/${care.id}`); await see(a, '[data-testid="crm-notes"]'); await sleep(500); await shot(a, "deal-light");
  check(await seeText(a, "Scout", 1500) && await a.evaluate(() => !!document.querySelector('[data-testid="crm-note"] [data-testid="agent-mark"]')), "an agent's note carries its mark");
  await axe(a, "deal page");

  // ── The phone ──────────────────────────────────────────────────────────────────────────────────
  for (const theme of ["light", "dark"]) {
    const phone = await open(1, { width: 390, height: 844, mobile: true, theme });
    await go(phone, "/crm"); await see(phone, '[data-testid="crm-board"]'); await sleep(350); await shot(phone, `phone-pipeline-${theme}`);
    if (theme === "light") {
      await phoneChecks(phone, "pipeline");
      check(await phone.evaluate(() => { const s = document.querySelector("[data-kit=kanban]"); return s.scrollWidth > s.clientWidth && getComputedStyle(s).scrollSnapType.includes("x"); }), "boards scroll by column on a phone");
      await phone.tap('[data-kanban-jump]:nth-child(4)').catch(() => {});
      await sleep(500); await shot(phone, "phone-pipeline-scrolled");
    }
    await go(phone, page); await see(phone, '[data-testid="crm-panels"]'); await sleep(350); await shot(phone, `phone-company-${theme}`);
    if (theme === "light") {
      await phoneChecks(phone, "company page");
      await go(phone, `${page}?pane=thread`); await sleep(350); await shot(phone, "phone-company-thread");
    }
    await go(phone, `/crm/deals/${care.id}`); await see(phone, '[data-testid="crm-notes"]'); await sleep(350); await shot(phone, `phone-deal-${theme}`);
    if (theme === "light") {
      await phoneChecks(phone, "deal page");
      await go(phone, "/crm/companies"); await sleep(250); await shot(phone, "phone-companies"); await phoneChecks(phone, "companies");
      await go(phone, "/crm/contacts"); await sleep(250); await shot(phone, "phone-contacts");
      await go(phone, "/crm?q=zzz-nothing"); await sleep(250); await shot(phone, "phone-no-match");
    }
    await phone.close();
  }

  // ── Speed, with the CPU slowed ─────────────────────────────────────────────────────────────────
  const fast = await open(0);
  const cdp = await fast.createCDPSession();
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
  await go(fast, "/crm");
  await see(fast, '[data-testid="crm-board"]');
  const racer = await dealOn(`Racer ${stamp}`, lead);
  await sleep(800);
  await fast.evaluate((t) => { [...document.querySelectorAll("[data-kanban-card] [tabindex]")].find((e) => e.textContent.includes(t))?.focus(); }, racer.title);
  for (let i = 0; i < 20; i++) { await shift(fast, i % 2 ? "ArrowLeft" : "ArrowRight"); await sleep(260); }
  const measures = await fast.evaluate(() => performance.getEntriesByName("optimistic", "measure").map((m) => m.duration));
  judge("optimistic", BUDGETS.optimistic, measures.slice(-20));
  await fast.close();

  const w1 = await open(0), w2 = await open(1);
  await go(w1, "/crm"); await go(w2, "/crm");
  await sleep(1200);
  const second = [];
  for (let i = 0; i < 12; i++) {
    const to = i % 2 ? lead : proposal;
    await w2.evaluate((id, col) => { window.__seen = new Promise((resolve) => { const t0 = performance.now(); const tick = () => { const at = document.querySelector(`[data-kanban-card="${id}"]`)?.closest("[data-kanban-column]")?.dataset.kanbanColumn; if (at === col) resolve(performance.now() - t0); else if (performance.now() - t0 > 3000) resolve(null); else requestAnimationFrame(tick); }; tick(); }); }, racer.id, String(to.id));
    await http("POST", pathOf("POST", "deals/{id}/move", { id: racer.id }), avery, { stage_id: to.id, before_id: 0 });
    second.push(await w2.evaluate(() => window.__seen));
    await sleep(300);
  }
  judge("secondWindow", BUDGETS.secondWindow, second);
  await w1.close(); await w2.close();
} catch (e) {
  fail("the run stopped", e.stack?.slice(0, 600) ?? String(e));
} finally {
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(report.errors.length ? `✗ ${report.errors.length} check(s) failed: ${join(out, "report.json")}` : `✓ customers: every check passed: ${join(out, "report.json")}`);
  process.exit(report.errors.length ? 1 : 0);
}

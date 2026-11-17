#!/usr/bin/env node
// The first minute (F1), as an evaluator lives it, against a deployed demo with no model key. One browser, one profile, two real
// windows: Morgan signs in and lands on Scout's waiting request, changes a word and approves it, follows links across the tools,
// opens Avery in a second window of the same browser, and the two swap live messages. Then Morgan assigns a task to Scout and
// sees the exact key command. Every step is a real click, and the screenshots land in --out, to be looked at.
//
// With --no-seed it checks the other first run instead (F4, KTD9): a backend deployed from xano/production.ts. Every demo door is
// shut, no demo row exists, the first admin sets up through the page, and the pipeline works from there.
//
//   node frontend/scripts/first-run-check.mjs --backend <url> --frontend <url> [--out qa/first-run]
//   node frontend/scripts/first-run-check.mjs --backend <url> --frontend <url> --no-seed --setup-token <token> [--out qa/no-seed]
//
// The demo deploy must hold no model key: with one, the request would still be a sample, but the key command never shows.
// Exit 0 = pass, 1 = a check failed, 2 = usage.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchBrowser } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const backend = opt("backend")?.replace(/\/$/, "");
const frontend = opt("frontend")?.replace(/\/$/, "");
const noSeed = argv.includes("--no-seed");
const setupToken = opt("setup-token");
const out = resolve(opt("out", noSeed ? "qa/no-seed" : "qa/first-run"));
if (!backend || !frontend || (noSeed && !setupToken)) { console.error("usage: first-run-check.mjs --backend <url> --frontend <url> [--out <dir>] [--no-seed --setup-token <token>]"); process.exit(2); }
mkdirSync(out, { recursive: true });

const report = { backend, frontend, errors: [] };
const fail = (what, detail) => { report.errors.push({ what, detail }); console.log(`✗ ${what}: ${detail}`); };
const check = (good, what, detail = "") => (good ? console.log(`✓ ${what}${detail ? `: ${detail}` : ""}`) : fail(what, detail || "no"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const routes = JSON.parse(execFileSync("npx", ["xanosdk", "routes", "./xano/index.ts", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).routes;
const pathOf = (verb, name, params = {}) => Object.entries(params).reduce((p, [k, v]) => p.replace(`{${k}}`, v), routes.find((r) => r.verb === verb && r.ref.split("/").slice(1).join("/") === name).path);
const raw = async (verb, path, token, body) => {
  const res = await fetch(backend + path, { method: verb, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const http = async (verb, path, token, body) => {
  const r = await raw(verb, path, token, body);
  if (r.status >= 400) throw new Error(`${verb} ${path}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
};
if (noSeed) await emptyFirstRun();

// What the first minute needs: a fresh demo, with its sample request still waiting, and no model key.
const morganToken = (await http("POST", pathOf("POST", "auth/demo"), null, { persona: "member" })).authToken;
const hosted = await http("GET", pathOf("GET", "agents/hosted"), morganToken);
const conversations = await http("GET", pathOf("GET", "conversations"), morganToken);
const room = conversations.find((c) => c.name === "marlow-oakline");
const sample = room && (await http("GET", `${pathOf("GET", "agent-runs")}?conversation_id=${room.id}`, morganToken)).items.find((r) => r.sample);
if (hosted.model_ready) { console.error("✗ this deploy holds a model key: F1 is the no-key first minute. Deploy without one."); process.exit(1); }
if (!sample || sample.status !== "waiting") { console.error(`✗ the sample request isn't waiting (${sample?.status ?? "missing"}): F1 needs a fresh demo. Redeploy with --reset.`); process.exit(1); }
check(true, "a fresh demo with no model key", `key ${hosted.key_name} unset, Scout's sample waiting in #${room.name}`);
const runRow = async () => (await http("GET", `${pathOf("GET", "agent-runs")}?conversation_id=${room.id}`, morganToken)).items.find((r) => r.id === sample.id);

const browser = await launchBrowser();
// One profile for the whole check: both windows share its storage, as two windows of one person's browser do.
const ctx = await browser.createBrowserContext();
const errors = [];
const watch = (page) => {
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
};
const setup = async (page, width = 1440, theme = "light") => {
  await page.setViewport({ width, height: width < 500 ? 844 : 900, hasTouch: width < 500, isMobile: width < 500, deviceScaleFactor: width < 500 ? 2 : 1 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
  watch(page);
};
// A window in the background gets no frames, so whichever window acts or is captured comes to the front first.
const shot = async (page, name) => { await page.bringToFront(); await sleep(200); await page.screenshot({ path: join(out, `${name}.png`) }); };
const see = (page, selector, timeout = 10000) => page.waitForSelector(selector, { timeout }).then(() => true, () => false);
const seeText = (page, text, timeout = 8000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text).then(() => true, () => false);
const whoIs = (page) => page.evaluate(() => document.querySelector('[data-kit="user-menu"]')?.textContent ?? "");
const signInAs = async (page, label) => {
  await page.goto(`${frontend}/sign-in`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="demo-login"]', { timeout: 20000 });
  await page.evaluate((name) => [...document.querySelectorAll('[data-testid="demo-login"]')].find((b) => b.textContent?.includes(name))?.click(), label);
};

// ── 1. Sign in as Morgan, and land on Scout's request ─────────────────────────────────────────────────────────────────────────
const a = await ctx.newPage();
await setup(a);
await signInAs(a, "Morgan");
check(await a.waitForFunction(() => location.pathname === "/inbox", { timeout: 15000 }).then(() => true, () => false), "a demo signs in to the inbox", await a.evaluate(() => location.pathname + location.search));
check(await see(a, '[data-testid="approval-card"][data-status="pending"]'), "Scout's request is open on landing, with no click");
const card = await a.evaluate(() => {
  const c = document.querySelector('[data-testid="approval-card"]');
  return { text: c?.innerText ?? "", sample: !!c?.querySelector('[data-testid="sample-run"]'), body: c?.querySelector('[data-testid="approval-body"]')?.textContent ?? "", audience: c?.querySelector('[data-testid="approval-audience"]')?.textContent ?? "" };
});
check(/Scout[\s\S]*wants to reply in a thread in[\s\S]*marlow-oakline/.test(card.text), "it says Scout wants to reply in the client room's thread", card.text.replace(/\s+/g, " ").slice(0, 80));
check(card.sample, "it's labelled Sample run");
check(card.body.includes("size guide"), "it shows the exact words it would post", card.body.slice(0, 60));
check(card.audience.includes("Riley"), "it names the guest who'll read it", card.audience);
check(!/expires/i.test(card.text), "a sample shows no expiry date");
await shot(a, "inbox-proposal-light");

// ── 1b. The same landing at every size and in both themes, before anyone decides ───────────────────────────────────────────────────────────────────────────
for (const [width, theme] of [[1440, "dark"], [390, "light"], [390, "dark"]]) {
  const p = await ctx.newPage();
  await setup(p, width, theme);
  await signInAs(p, "Morgan");
  await p.waitForFunction(() => location.pathname === "/inbox", { timeout: 15000 }).catch(() => {});
  check(await see(p, '[data-testid="approval-card"][data-status="pending"]', 10000), `Scout's request is open on landing at ${width} px ${theme}`);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(overflow <= 0, `and the page doesn't scroll sideways`, `${overflow} px`);
  await shot(p, `inbox-proposal-${width}-${theme}`);
  await p.close();
}


// ── 2. Change a word, and approve ─────────────────────────────────────────────────────────────────────────────────────────────
await a.click('[data-testid="approval-edit"]');
await a.waitForSelector('[data-testid="approval-text"]');
const original = await a.$eval('[data-testid="approval-text"]', (t) => t.value);
const edited = original.replace("Wednesday", "Tuesday");
check(edited !== original, "the proposal has a word to change");
await a.$eval('[data-testid="approval-text"]', (t) => { t.select(); });
await a.keyboard.type(edited, { delay: 0 });
await a.click('[data-testid="approval-approve"]');
check(await see(a, '[data-testid="approval-card"][data-status="approved"], [data-testid="approval-outcome"]', 15000), "approving answers at once");
const outcome = await a.evaluate(() => document.querySelector('[data-testid="approval-outcome"]')?.textContent ?? "");
check(/approved|posted/i.test(outcome), "the card says what happened", outcome);
await shot(a, "inbox-approved-light");
let ended = null;
for (let i = 0; i < 40 && ended?.status !== "done"; i++) { ended = await runRow(); if (ended?.status !== "done") await sleep(250); }
check(ended?.status === "done", "the sample run finishes on the decision", ended?.status);
check(!ended?.started_at, "and no model ran for it", `started_at ${ended?.started_at ?? "null"}`);

await a.goto(`${frontend}/chat/${sample.thread_id}`, { waitUntil: "domcontentloaded" });
check(await seeText(a, "Tuesday"), "the post in the thread carries the edited word");
const post = await a.evaluate(() => {
  const m = [...document.querySelectorAll('[data-kit="message"]')].find((el) => el.textContent?.includes("Tuesday"));
  return m ? { text: m.innerText, approver: m.querySelector('[data-testid="message-approved-by"]')?.textContent ?? "" } : null;
});
check(!!post && post.text.includes("Scout") && post.approver.includes("Morgan"), "it reads Scout · approved by Morgan", post ? `${post.text.split("\n")[0]} / ${post.approver}` : "no post");
check(!post?.text.includes("Wednesday"), "and not the words Scout first proposed");
await shot(a, "approved-post-light");
// Where Morgan asked: the request's run is done, still labelled for what it was.
await a.goto(`${frontend}/chat/${room.id}`, { waitUntil: "domcontentloaded" });
await see(a, '[data-testid="run-chip"][data-state="done"]', 8000);
const chip = await a.evaluate(() => { const c = document.querySelector('[data-testid="run-chip"]'); return c ? { state: c.dataset.state, sample: !!c.querySelector('[data-testid="sample-run"]'), note: c.querySelector('[data-testid="run-note"]')?.textContent ?? "" } : null; });
check(chip?.state === "done" && chip.sample && /Posted/.test(chip.note), "the run on Morgan's ask shows done, labelled Sample run", JSON.stringify(chip));
await shot(a, "approved-run-light");

// ── 3. Follow links across the tools ──────────────────────────────────────────────────────────────────────────────────────────
const follow = async (page, href, words) => {
  const clicked = await page.evaluate((h) => { const l = [...document.querySelectorAll('a[data-kit="link-chip"]')].find((el) => el.getAttribute("href")?.startsWith(h)); l?.click(); return !!l; }, href);
  if (!clicked) return false;
  return page.waitForFunction((h) => location.pathname.startsWith(h), { timeout: 8000 }, href).then(() => seeText(page, words), () => false);
};
await a.goto(`${frontend}/crm/companies`, { waitUntil: "domcontentloaded" });
await seeText(a, "Marlow Cycles");
await a.evaluate(() => [...document.querySelectorAll("a")].find((l) => l.textContent?.includes("Marlow Cycles"))?.click());
check(await see(a, '[data-testid="company-detail"]') && await seeText(a, "Marlow Cycles"), "Marlow, the customer, opens from Customers");
await see(a, 'a[data-kit="link-chip"][href^="/tasks/"]', 8000);
const linkedFrom = await a.evaluate(() => [...new Set([...document.querySelectorAll('a[data-kit="link-chip"]')].map((l) => l.getAttribute("href")?.split("/")[1]))]);
check(["tasks", "docs", "files", "chat"].every((t) => linkedFrom.includes(t)), "it links to work in every other tool", linkedFrom.join(", "));
await shot(a, "linked-customer-light");
check(await follow(a, "/tasks/", ""), "the customer links to its tasks", await a.evaluate(() => location.pathname));
await shot(a, "linked-task-light");
const fromTask = await a.evaluate(() => [...document.querySelectorAll('a[data-kit="link-chip"]')].map((l) => l.getAttribute("href")).filter((h) => h && !h.startsWith("/tasks/"))[0] ?? "");
check(!!fromTask && await follow(a, fromTask.split("?")[0], ""), "and the task links on, to another tool", fromTask);

// ── 4. Open as Avery in a new window, and talk live ───────────────────────────────────────────────────────────────────────────
await a.goto(`${frontend}/chat/${room.id}`, { waitUntil: "domcontentloaded" });
await see(a, '[data-testid="composer-input"]');
// The menu loads apart from the shell, so the first press may land on the button it replaces: press until it's open. A real
// press, as the loaded menu opens on the pointer going down, which a script's click() never sends.
let menuOpen = false;
for (let i = 0; i < 4 && !menuOpen; i++) {
  await a.click('[data-kit="user-menu"]').catch(() => {});
  menuOpen = await see(a, '[data-kit="open-as-admin"]', 2500);
}
check(menuOpen, "the user menu offers to open Avery in a new window");
await shot(a, "open-as-menu-light");
const opened = ctx.waitForTarget((t) => t.type() === "page" && t.url().includes("as=admin"), { timeout: 15000 });
await a.evaluate(() => document.querySelector('[data-kit="open-as-admin"]')?.click());
const target = await opened.catch(() => null);
const b = target && await target.page();
check(!!b, "it opens a second window in the same browser");
if (b) {
  await setup(b);
  await b.bringToFront();
  check(await b.waitForFunction((id) => location.pathname === `/chat/${id}`, { timeout: 20000 }, room.id).then(() => true, () => false), "the new window opens on the same conversation", await b.evaluate(() => location.pathname));
  await see(b, '[data-kit="user-menu"]');
  check((await whoIs(b)).includes("Avery"), "as Avery", await whoIs(b));
  check((await whoIs(a)).includes("Morgan"), "while the first window is still Morgan", await whoIs(a));
  await see(b, '[data-testid="composer-input"]');
  await shot(b, "open-as-avery-light");
  const stamp = Date.now().toString(36);
  const say = async (page, words) => { await page.bringToFront(); await page.click('[data-testid="composer-input"]'); await page.keyboard.type(words); await page.keyboard.press("Enter"); };
  await say(a, `Morgan here, live ${stamp}`);
  await b.bringToFront();
  check(await seeText(b, `Morgan here, live ${stamp}`, 8000), "Avery's window shows Morgan's message live, with no reload");
  await say(b, `Avery back, live ${stamp}`);
  await a.bringToFront();
  check(await seeText(a, `Avery back, live ${stamp}`, 8000), "and Morgan's shows Avery's reply");
  await shot(a, "live-exchange-morgan-light");
  await shot(b, "live-exchange-avery-light");
  await a.bringToFront(); await a.reload({ waitUntil: "domcontentloaded" }); await see(a, '[data-kit="user-menu"]');
  await b.bringToFront(); await b.reload({ waitUntil: "domcontentloaded" });
  await see(a, '[data-kit="user-menu"]'); await see(b, '[data-kit="user-menu"]');
  check((await whoIs(a)).includes("Morgan") && (await whoIs(b)).includes("Avery"), "after a reload each window is still its own person", `${await whoIs(a)} / ${await whoIs(b)}`);
}

// ── 5. Assign a task to Scout, and see the exact key command ──────────────────────────────────────────────────────────────────
const tasks = await http("GET", `${pathOf("GET", "tasks")}?q=${encodeURIComponent("Accessibility pass")}`, morganToken);
const job = tasks.items?.[0];
check(!!job, "a Marlow task to give Scout", job?.title);
if (job) {
  await a.bringToFront();
  await a.goto(`${frontend}/tasks/${job.id}`, { waitUntil: "domcontentloaded" });
  await see(a, '[data-field="assignee"]');
  await a.keyboard.press("a");
  await see(a, '[data-testid="assign-option"]', 3000);
  await a.keyboard.type("Scout"); await sleep(100); await a.keyboard.press("Enter");
  check(await see(a, '[data-testid="run-chip"]', 8000), "assigning Scout shows its run at once");
  check(await see(a, '[data-testid="run-key-how"]', 8000), "Morgan, a member, is offered the key command in a demo");
  await a.click('[data-testid="run-key-how"]').catch(() => {});
  check(await see(a, '[data-testid="run-key-command"]', 3000), "How to add one shows the command");
  const command = await a.evaluate(() => document.querySelector('[data-testid="run-key-command"]')?.textContent ?? "");
  check(command === `printf %s "$KEY" | npx @xano/sdk env set ${hosted.key_name}`, "it's the exact command for this backend's key", command);
  await shot(a, "assigned-scout-key-command-light");
}

check(!errors.length, "no console errors", errors.slice(0, 3).join(" | "));
await browser.close();
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(report.errors.length ? `\n${report.errors.length} failed` : "\nall passed");
process.exit(report.errors.length ? 1 : 0);

/** F4's first run, on a backend with no seed: shut doors, no demo rows, setup through the page, then a working pipeline. */
async function emptyFirstRun() {
  const status = await http("GET", pathOf("GET", "auth/status"));
  if (!status.setup_required) { console.error("✗ this backend is already set up: --no-seed needs a fresh deploy of xano/production.ts."); process.exit(1); }
  check(status.setup_ready && !status.demo_mode && !status.signup_open, "an empty backend asks for setup, with demo mode and sign-up off", JSON.stringify(status));
  check((await http("GET", pathOf("GET", "auth/demo/personas"))).length === 0, "it offers no demo people");
  for (const persona of ["admin", "member", "guest"]) {
    const r = await raw("POST", pathOf("POST", "auth/demo"), null, { persona });
    check(r.status >= 400 && !r.json?.authToken, `demo sign-in as ${persona} is refused`, String(r.status));
  }
  const signup = await raw("POST", pathOf("POST", "auth/signup"), null, { name: "Stranger", email: "stranger@no-seed.example", password: "Stranger-pass-1" });
  check(signup.status >= 400 && !signup.json?.authToken, "open sign-up is refused", String(signup.status));
  const wrong = await raw("POST", pathOf("POST", "auth/setup"), null, { setup_token: "not-the-token", workspace_name: "Nope", name: "Nope", email: "nope@no-seed.example", password: "Nope-pass-1" });
  check(wrong.status >= 400, "setup refuses a wrong token", String(wrong.status));

  const browser = await launchBrowser();
  const ctx = await browser.createBrowserContext();
  const errors = [];
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${frontend}/`, { waitUntil: "domcontentloaded" });
  check(await page.waitForSelector('[data-testid="setup-form"]', { timeout: 20000 }).then(() => true, () => false), "the app opens on first-admin setup");
  check(!(await page.$('[data-testid="demo-login"]')), "and offers no demo sign-in");
  await page.screenshot({ path: join(out, "setup-light.png") });
  const fill = async (id, value) => { await page.click(`#${id}`); await page.keyboard.type(value); };
  await fill("setup-workspace", "Northwind Studio"); await fill("setup-name", "Sam Okafor"); await fill("setup-email", "sam@no-seed.example");
  await fill("setup-password", "Northwind-pass-1"); await fill("setup-token", setupToken);
  await page.click('[data-testid="setup-form"] button[type="submit"]');
  check(await page.waitForSelector('[data-testid="overview"]', { timeout: 20000 }).then(() => true, () => false), "setup signs the admin in, to the overview");
  const token = await page.evaluate(() => localStorage.getItem("app.token"));
  check(!!token, "with a real session, shared by the browser's tabs");

  // Nothing of the demo: one person, one space with #general, and no work, customers or files yet.
  const people = await http("GET", pathOf("GET", "app/people"), token);
  check(people.length === 1 && people[0].name === "Sam Okafor", "the only person is the admin who set it up", people.map((p) => p.name).join(", "));
  const spaces = await http("GET", pathOf("GET", "spaces"), token);
  const spaceList = spaces.spaces;
  check(spaceList.length === 1 && spaceList[0].name === "Northwind Studio", "one space, named for the workspace", spaceList.map((x) => x.name).join(", "));
  const convs = await http("GET", pathOf("GET", "conversations"), token);
  check(convs.length === 1 && convs[0].name === "general", "one channel, #general", convs.map((x) => x.name).join(", "));
  const empty = async (name, path) => { const r = await http("GET", path, token); const items = r.items ?? r; check(Array.isArray(items) && items.length === 0, `no ${name}`, `${items?.length}`); };
  await empty("tasks", pathOf("GET", "tasks"));
  await empty("files", pathOf("GET", "files"));
  await empty("companies", pathOf("GET", "companies"));
  const found = await http("GET", `${pathOf("GET", "search")}?q=Marlow`, token);
  check(!(found.items ?? []).length, "search finds nothing of the demo company", `${(found.items ?? []).length}`);
  const hostedAgents = await http("GET", pathOf("GET", "agents/hosted"), token);
  check(!hostedAgents.items.length, "no demo agents");

  // The pipeline setup made, used for real: a company, a deal in its first stage, then Won.
  const pipeline = await http("GET", pathOf("GET", "pipeline"), token);
  const stages = pipeline.stages ?? [];
  check(JSON.stringify(stages.map((x) => x.name)) === JSON.stringify(["Lead", "Qualified", "Proposal", "Negotiation", "Won", "Lost"]), "setup made the default pipeline", stages.map((x) => x.name).join(", "));
  const won = stages.find((x) => x.kind === "won");
  const company = await http("POST", pathOf("POST", "companies"), token, { client_id: crypto.randomUUID(), name: "Harbour Bikes" });
  const deal = await http("POST", pathOf("POST", "deals"), token, { client_id: crypto.randomUUID(), company_id: company.id, stage_id: stages[0]?.id, title: "Harbour Bikes storefront", value: 12000 });
  const closed = await http("POST", pathOf("POST", "deals/{id}/stage", { id: deal.id }), token, { stage_id: won?.id });
  check(closed.stage_id === won?.id && !!closed.closed_at, "a deal can be created and moved to Won");

  for (const [width, theme] of [[1440, "light"], [1440, "dark"], [390, "light"], [390, "dark"]]) {
    await page.setViewport({ width, height: width < 500 ? 844 : 900, hasTouch: width < 500, isMobile: width < 500, deviceScaleFactor: width < 500 ? 2 : 1 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
    for (const [name, path, ready] of [["overview", "/", "overview"], ["inbox", "/inbox", "inbox-page"], ["chat", "/chat", null], ["tasks", "/tasks", null], ["docs", "/docs", null], ["customers", "/crm", null], ["files", "/files", null], ["agents", "/agents", null]]) {
      await page.goto(`${frontend}${path}`, { waitUntil: "domcontentloaded" });
      if (ready) await page.waitForSelector(`[data-testid="${ready}"]`, { timeout: 10000 }).catch(() => {});
      await sleep(900);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      if (overflow > 0) fail(`${name} at ${width} px ${theme} scrolls sideways`, `${overflow} px`);
      await page.screenshot({ path: join(out, `${name}-${width}-${theme}.png`) });
    }
  }
  check(!errors.length, "no console errors", errors.slice(0, 3).join(" | "));
  await browser.close();
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(report.errors.length ? `\n${report.errors.length} failed` : "\nall passed");
  process.exit(report.errors.length ? 1 : 0);
}

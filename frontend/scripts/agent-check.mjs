#!/usr/bin/env node
// Hosted agents in a real browser with a real model, against a deployed backend: what a workflow test can't see. The door a run
// comes in through, a mention and an assignment from start to finish, Stop, Retry, and every screen at desktop and phone width
// in both themes. Then the agent experience (U21): Add Agent, an agent's page, its keys, a sponsor hand-over, run states from
// real rows, "Add it?" and a connected agent's pick-up. With --no-model it proves the plain no-key state instead, and spends nothing.
//
//   node frontend/scripts/agent-check.mjs --backend <url> --frontend <url> [--out qa/agents] [--no-model]
//
// Exit 0 = pass, 1 = a check failed, 2 = usage.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { launchBrowser } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const backend = opt("backend")?.replace(/\/$/, "");
const frontend = opt("frontend")?.replace(/\/$/, "");
const out = resolve(opt("out", "qa/agents"));
const noModel = argv.includes("--no-model");
if (!backend || !frontend) { console.error("usage: agent-check.mjs --backend <url> --frontend <url> [--out <dir>] [--no-model]"); process.exit(2); }
mkdirSync(out, { recursive: true });

const report = { backend, frontend, errors: [], runs: [] };
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
const signIn = async (persona) => (await http("POST", pathOf("POST", "auth/demo"), null, { persona })).authToken;
const send = (token, id, body) => http("POST", pathOf("POST", "conversations/{id}/messages", { id }), token, { client_msg_id: crypto.randomUUID(), body });
const runsOf = (token, q) => http("GET", pathOf("GET", "agent-runs") + q, token);

const morgan = await signIn("member");
const avery = await signIn("admin");
const conversations = await http("GET", pathOf("GET", "conversations"), morgan);
const launch = conversations.find((c) => c.name === "marlow-launch");
const hosted = await http("GET", pathOf("GET", "agents/hosted"), morgan);
const scout = hosted.items.find((a) => a.name === "Scout") ?? hosted.items[0];
check(!!launch && !!scout, "the seeded channel and Scout are there");
check(!!scout.brief, "Scout has a brief");
check(hosted.model_ready === !noModel, "model_ready says what this deploy holds", String(hosted.model_ready));
check(!JSON.stringify(hosted).match(/AIza|sk-ant/), "nothing that looks like a key reaches a screen");

// The door. Only a token the runner minted for a claimed run gets through.
const door = pathOf("POST", "agent-runs/execute");
const personal = await http("POST", pathOf("POST", "agent/connections"), morgan, { name: "Check key", scope: "read_write", days: 1 });
for (const [who, token] of [["no token", null], ["a person's token", morgan], ["a person's agent key", personal.token]]) {
  const r = await raw("POST", door, token, {});
  check(r.status === 401 || r.status === 403, `${who} can't start a run`, String(r.status));
}

const browser = await launchBrowser();
const consoleErrors = [];
const openAs = async (persona, width, theme) => {
  const height = width < 500 ? 844 : 900;
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height, hasTouch: width < 500, isMobile: width < 500, deviceScaleFactor: width < 500 ? 2 : 1 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.goto(`${frontend}/sign-in`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="demo-login"]', { timeout: 15000 });
  await page.evaluate((name) => [...document.querySelectorAll('[data-testid="demo-login"]')].find((b) => b.textContent?.includes(name))?.click(), { member: "Morgan", admin: "Avery", guest: "Riley" }[persona]);
  await page.waitForSelector('[data-kit="user-menu"], [data-kit="user-menu-compact"]', { timeout: 15000 });
  return page;
};
const shot = async (page, name) => { await sleep(150); await page.screenshot({ path: join(out, `${name}.png`) }); };
/** axe at WCAG 2.1 AA, on the page or on what `include` picks out. */
const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const axeCheck = async (page, name, include) => {
  await page.evaluate(axeSource);
  const axe = await page.evaluate((sel) => window.axe.run(sel ? { include: [[sel]] } : document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }), include ?? null);
  const bad = axe.violations.map((v) => `${v.id} (${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(", ")})`);
  check(!bad.length, `${name}: axe`, bad.join("; "));
};
const stateOf = (page, within = "body") => page.evaluate((sel) => { const chips = document.querySelectorAll(`${sel} [data-testid="run-chip"]`); const c = chips[chips.length - 1]; return c ? { state: c.dataset.state, label: c.querySelector('[data-testid="run-label"]')?.textContent, note: c.querySelector('[data-testid="run-note"]')?.textContent ?? "" } : null; }, within);
/** Watches a chip until it settles, keeping every label it showed. */
const watch = async (page, within, seconds = 120) => {
  const seen = [];
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    const s = await stateOf(page, within);
    if (s && seen.at(-1) !== s.label) seen.push(s.label);
    if (s && (s.state === "done" || s.state === "failed")) return { seen, final: s, took: Date.now() - started };
    await sleep(120);
  }
  return { seen, final: await stateOf(page, within), took: Date.now() - started };
};
const typeMention = async (page, text) => {
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 15000 });
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type("@Sco");
  await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 5000 });
  await page.keyboard.press("Enter");
  await sleep(50);
  await page.keyboard.type(` ${text}`);
  await page.keyboard.press("Enter");
};

// Chat: mention Scout in the real composer, and watch it work.
const desk = await openAs("member", 1440, "light");
await desk.goto(`${frontend}/chat/${launch.id}`, { waitUntil: "domcontentloaded" });
await desk.waitForSelector('[data-testid="message-list"]', { timeout: 15000 });
await desk.waitForSelector('[data-testid="run-chip"]', { timeout: 10000 }).catch(() => {});
await shot(desk, "chat-seeded-light");
await axeCheck(desk, "run chip, done", '[data-testid="run-chip"]');
const seededChip = await stateOf(desk, '[data-testid="conversation"]');
check(seededChip?.state === "done", "Scout's finished work is on show from the first look", seededChip?.label ?? "no chip");

const started = Date.now();
await typeMention(desk, noModel ? "can you list what's left on checkout?" : "in two lines, what's the riskiest thing left on checkout? Add one task for it, for me, due on Friday.");
await desk.waitForFunction(() => [...document.querySelectorAll('[data-testid="run-chip"]')].some((c) => !["done", "failed"].includes(c.dataset.state)), { timeout: 5000 }).catch(() => fail("run chip", "no live chip within 5 s of the mention"));
report.chipMs = Date.now() - started;
check(report.chipMs < 3000, "a visible state appears at once", `${report.chipMs} ms`);

if (noModel) {
  const s = await stateOf(desk, '[data-testid="conversation"]');
  check(s?.label === "Needs a model key to run", "with no key the chip says so plainly", s?.label);
  await shot(desk, "no-model-member-light");
  await axeCheck(desk, "run chip, waiting for a key", '[data-testid="run-chip"]');
  const admin = await openAs("admin", 1440, "dark");
  await admin.goto(`${frontend}/chat/${launch.id}`, { waitUntil: "domcontentloaded" });
  await admin.waitForSelector('[data-testid="run-key-how"]', { timeout: 15000 }).catch(() => fail("no-model", "an admin isn't offered the key command"));
  await admin.click('[data-testid="run-key-how"]').catch(() => {});
  await admin.waitForSelector('[data-testid="run-key-command"]', { timeout: 3000 }).catch(() => fail("no-model", "How to add one shows no command"));
  const command = await admin.$eval('[data-testid="run-key-command"]', (n) => n.textContent).catch(() => "");
  check(/env set (ANTHROPIC|GEMINI)_API_KEY/.test(command), "an admin gets the exact command", command);
  await shot(admin, "no-model-admin-dark");
  await axeCheck(admin, "run chip with the key command, dark", '[data-testid="run-chip"]');
  await admin.goto(`${frontend}/team`, { waitUntil: "domcontentloaded" });
  await admin.waitForSelector('[data-testid="agent-no-model"]', { timeout: 15000 }).catch(() => fail("no-model", "Team doesn't say the agent is waiting"));
  await shot(admin, "team-no-model-dark");
  const phone = await openAs("member", 390, "dark");
  await phone.goto(`${frontend}/chat/${launch.id}`, { waitUntil: "domcontentloaded" });
  await phone.waitForSelector('[data-testid="run-chip"]', { timeout: 15000 });
  await shot(phone, "no-model-phone-dark");
  await axeCheck(phone, "run chip at 390 px, dark", '[data-testid="run-chip"]');
} else {
  const chat = await watch(desk, '[data-testid="conversation"]');
  report.runs.push({ where: "chat", ...chat });
  check(chat.final?.state === "done", "the mention ran to done", JSON.stringify(chat));
  check(chat.seen.includes("Working"), "the chip showed Working on the way", chat.seen.join(" → "));
  await shot(desk, "chat-done-light");
  const listed = (await runsOf(morgan, `?conversation_id=${launch.id}`)).items[0];
  const thread = await http("GET", pathOf("GET", "conversations/{id}/messages", { id: listed.thread_id }), morgan);
  check(thread.items.length >= 2 && thread.items.every((m) => m.author_id === scout.id), "every note is Scout's own", `${thread.items.length} messages`);
  check(thread.items.some((m) => m.run_note), "progress notes are in the thread");
  await desk.evaluate(() => document.querySelectorAll('[data-testid="message-replies"]')[document.querySelectorAll('[data-testid="message-replies"]').length - 1]?.click());
  await desk.waitForSelector('[data-testid="thread-panel"]', { timeout: 8000 }).catch(() => fail("thread", "the thread didn't open"));
  await shot(desk, "chat-thread-light");

  // Tasks: assign Scout from the menu a person uses, and watch Queued, Working, Done.
  const setup = await http("GET", pathOf("GET", "task-setup"), morgan);
  const project = setup.projects.find((p) => p.name === "Website relaunch");
  const made = await http("POST", pathOf("POST", "tasks"), morgan, { project_id: project.id, client_id: crypto.randomUUID(), title: `Draft the launch-day customer note ${Date.now() % 1000}`, description: "Two sentences for existing Marlow customers. Post the draft in this thread.", status: "todo", priority: "medium" });
  const taskPage = await openAs("member", 1440, "dark");
  await taskPage.goto(`${frontend}/tasks/${made.id}`, { waitUntil: "domcontentloaded" });
  await taskPage.waitForSelector('[data-field="assignee"]', { timeout: 15000 });
  await taskPage.click('[data-field="assignee"]');
  await sleep(300);
  await taskPage.keyboard.type("Scout");
  // The menu opens before the project's people have loaded on a slow backend: Enter then picks nothing.
  await taskPage.waitForFunction(() => [...document.querySelectorAll('[role="option"], [role="menuitemradio"]')].some((n) => /Scout/.test(n.textContent ?? "")), { timeout: 15000 }).catch(() => fail("assign", "Scout never appeared in the assignee menu"));
  await sleep(250);
  await taskPage.keyboard.press("Enter");
  const onTask = await watch(taskPage, '[data-testid="task-detail"]');
  report.runs.push({ where: "task", ...onTask });
  check(onTask.final?.state === "done", "the assigned task ran to done", JSON.stringify(onTask));
  check(onTask.seen.some((l) => /Queued|Starting/.test(l)) && onTask.seen.includes("Working"), "it showed Queued, then Working, then Done", onTask.seen.join(" → "));
  await taskPage.waitForSelector('[data-testid="task-thread"] [data-testid="message-list"]', { timeout: 8000 }).catch(() => fail("task thread", "Scout's notes aren't on the task"));
  await shot(taskPage, "task-done-dark");
  await axeCheck(taskPage, "run chip on a task, dark", '[data-testid="run-chip"]');

  // Stop: a person ends a run, and it says who did.
  const stopping = await send(morgan, launch.id, `<@${scout.id}> look through the whole launch plan, every task one at a time, and write up each risk in the thread.`);
  await desk.bringToFront();
  await desk.goto(`${frontend}/chat/${launch.id}`, { waitUntil: "domcontentloaded" });
  const stopButton = await desk.waitForSelector('[data-testid="run-stop"]', { timeout: 20000 }).catch(() => null);
  if (stopButton) {
    await stopButton.click();
    await desk.waitForFunction(() => [...document.querySelectorAll('[data-testid="run-chip"]')].some((c) => c.dataset.reason === "canceled"), { timeout: 10000 }).catch(() => fail("stop", "the chip never said Stopped"));
    await shot(desk, "chat-stopped-light");
    await axeCheck(desk, "run chip, stopped", '[data-testid="run-chip"]');
    const stopped = (await runsOf(morgan, `?conversation_id=${launch.id}`)).items.find((r) => r.source_id === stopping.message.id);
    check(stopped?.reason === "canceled", "Stop ends the run", stopped?.reason);
    // Retry: the same run goes again and finishes.
    const retryButton = await desk.waitForSelector('[data-reason="canceled"] [data-testid="run-retry"]', { timeout: 5000 }).catch(() => null);
    if (retryButton) {
      await retryButton.click();
      let after = stopped;
      for (let i = 0; i < 150; i++) {
        await sleep(1000);
        after = (await runsOf(morgan, `?conversation_id=${launch.id}`)).items.find((r) => r.id === stopped.id);
        if (after.attempt === 2 && ["done", "failed"].includes(after.status)) break;
      }
      report.runs.push({ where: "retry", status: after.status, reason: after.reason, attempt: after.attempt, steps: after.steps, took: Number(after.finished_at) - Number(after.started_at) });
      check(after.attempt === 2 && after.status === "done", "Retry goes again on the same run, and finishes", `attempt ${after.attempt}, ${after.status} ${after.reason} ${after.detail}`);
    } else fail("retry", "a stopped run offers no Retry");
  } else fail("stop", "no Stop button on a live run");

  // The phone, both themes: one pane at a time, with the chip and its notes readable.
  for (const theme of ["light", "dark"]) {
    const phone = await openAs("member", 390, theme);
    await phone.goto(`${frontend}/chat/${launch.id}`, { waitUntil: "domcontentloaded" });
    await phone.waitForSelector('[data-testid="run-chip"]', { timeout: 15000 });
    await shot(phone, `chat-phone-${theme}`);
    await axeCheck(phone, `run chip at 390 px, ${theme}`, '[data-testid="run-chip"]');
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(!overflow, `no sideways scroll on a phone in ${theme}`);
    await phone.goto(`${frontend}/tasks/${made.id}`, { waitUntil: "domcontentloaded" });
    await phone.waitForSelector('[data-testid="run-chip"]', { timeout: 15000 });
    await shot(phone, `task-phone-${theme}`);
    await phone.browserContext().close();
  }
  const team = await openAs("admin", 1440, "light");
  await team.goto(`${frontend}/team`, { waitUntil: "domcontentloaded" });
  await team.waitForSelector('[data-testid="agent-brief"]', { timeout: 15000 }).catch(() => fail("brief", "Team doesn't show Scout's brief"));
  await shot(team, "team-brief-light");
  const inbox = await http("GET", pathOf("GET", "app/notifications"), morgan);
  check(JSON.stringify(inbox).includes("Scout finished"), "the requester has the result in their inbox");
}

// ── U21: the agent experience. A real admin (invited by the demo admin, so not a demo session) adds a connected agent and a hosted one
// on screen, makes a key, connects with only what the key panel shows, and hands the agent to a new sponsor. Run states come from
// real rows: a pause holds a run, Stop and Retry spend its three attempts, and leaving its space ends one. Every screen is taken in
// light, dark and at 390 px.
const openWith = async (token, width, theme, path) => {
  const height = width < 500 ? 844 : 900;
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height, hasTouch: width < 500, isMobile: width < 500, deviceScaleFactor: width < 500 ? 2 : 1 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.goto(`${frontend}/sign-in`, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => { localStorage.setItem("app.token", t); }, token);
  await page.goto(`${frontend}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-kit="user-menu"], [data-kit="user-menu-compact"]', { timeout: 15000 });
  return page;
};
const noSideways = async (page, what) => check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), `${what}: no sideways scroll`);
const waitRun = async (token, agentId, runId, done, seconds = 150) => {
  for (let i = 0; i < seconds; i++) {
    const r = (await http("GET", pathOf("GET", "team-agents/{agent_id}/runs", { agent_id: agentId }), token)).items.find((x) => x.id === runId);
    if (r && done(r)) return r;
    await sleep(1000);
  }
  return null;
};
const mcpCall = async (server, token, method, params) => {
  const res = await fetch(server, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) });
  const text = await res.text();
  const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).at(-1) ?? (text.startsWith("{") ? JSON.parse(text) : null);
  return { status: res.status, data };
};
const toolText = (r) => r.data?.result?.content?.[0]?.text ?? JSON.stringify(r.data?.error ?? r.data);

const stamp = Date.now() % 100000;
const invite = await http("POST", pathOf("POST", "auth/invites"), avery, { email: `jordan.${stamp}@check.example`, name: "Jordan Lee", role: "admin" });
const jordan = (await http("POST", pathOf("POST", "auth/link/accept"), null, { token: invite.token, name: "Jordan Lee", password: "Check-pass-1" })).authToken;
const riley = await signIn("guest");
const launchSpace = launch.space_id;
const morganMe = await http("GET", pathOf("GET", "auth/me"), morgan);

// The demo admin and a member can't add an agent; the real admin can.
const demoTry = await raw("POST", pathOf("POST", "team-agents"), avery, { name: "Nope", mode: "hosted", brief: "x", sponsor_id: morganMe.id, space_ids: [] });
check(demoTry.status === 403 && /demo session/.test(JSON.stringify(demoTry.json)), "a demo admin can't add an agent", String(demoTry.status));
const memberTry = await raw("POST", pathOf("POST", "team-agents"), morgan, { name: "Nope", mode: "hosted", brief: "x", sponsor_id: morganMe.id, space_ids: [] });
check(memberTry.status === 403, "a member can't add an agent", String(memberTry.status));

// Add Agent, on screen, as the real admin: connected, with a sponsor and a space. It lands on the new agent's page.
const courierName = `Courier ${stamp}`;
const admin = await openWith(jordan, 1440, "light", "/team");
await admin.waitForSelector('[data-testid="add-agent-button"]', { timeout: 15000 });
await admin.click('[data-testid="add-agent-button"]');
await admin.waitForSelector('[data-testid="add-agent-dialog"]', { timeout: 5000 });
await shot(admin, "add-agent-light");
await axeCheck(admin, "Add Agent dialog", '[data-testid="add-agent-dialog"]');
check(await admin.$eval('[data-testid="add-agent-reads"]', (n) => /only in the spaces you pick/.test(n.textContent)), "Add Agent says what it can read");
await admin.click('[data-testid="add-agent-connected"]');
await admin.type('[data-testid="add-agent-name"]', courierName);
await admin.type('[data-testid="add-agent-brief"]', "Carries the launch notes between Morgan's machine and the team.");
await admin.evaluate((spaceName) => [...document.querySelectorAll('[data-testid="add-agent-dialog"] label')].find((l) => l.textContent?.trim() === spaceName)?.querySelector("button")?.click(), (await http("GET", pathOf("GET", "spaces"), jordan)).spaces.find((s) => s.id === launchSpace).name);
await shot(admin, "add-agent-filled-light");
await admin.click('[data-testid="add-agent-submit"]');
await admin.waitForSelector('[data-testid="agent-page"] [data-testid="agent-name"]', { timeout: 15000 }).catch(() => fail("add agent", "didn't land on the new agent's page"));
const courierId = Number(admin.url().match(/\/team\/agents\/(\d+)/)?.[1]);
check(courierId > 0 && (await admin.$eval('[data-testid="agent-name"]', (n) => n.textContent)) === courierName, "Add Agent lands on its page", admin.url());
await shot(admin, "agent-connected-new-light");

// The key: made on screen, shown once with the server and the Claude Code command.
await admin.click('[data-testid="key-new"]');
await admin.waitForSelector('[data-testid="key-dialog"]', { timeout: 5000 });
await admin.type('[data-testid="key-name"]', "Morgan's laptop");
await admin.click('[data-testid="key-make"]');
await admin.waitForSelector('[data-testid="key-once"] [data-testid="key-token"]', { timeout: 10000 });
await admin.waitForFunction(() => document.querySelector('[data-testid="key-server"]')?.textContent?.startsWith("http"), { timeout: 10000 }).catch(() => fail("key panel", "no MCP server address"));
await shot(admin, "key-panel-light");
await axeCheck(admin, "key panel", '[data-testid="agent-keys"]');
const shown = await admin.evaluate(() => ({ token: document.querySelector('[data-testid="key-token"]').textContent, server: document.querySelector('[data-testid="key-server"]').textContent, command: document.querySelector('[data-testid="key-command"]').textContent }));
check(shown.command.includes("claude mcp add") && shown.command.includes(shown.server) && shown.command.includes(shown.token), "the key panel gives a Claude Code command with the server and the key");
const listed = await http("GET", pathOf("GET", "agents/{agent_id}/keys", { agent_id: courierId }), jordan);
check(!JSON.stringify(listed).includes(shown.token), "the key's secret isn't readable again");

// Connect with only what the panel showed, and last seen moves.
const init = await mcpCall(shown.server, shown.token, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "agent-check", version: "1" } });
check(init.status === 200 && !!init.data?.result, "the agent connects with only the shown server and key", String(init.status));
// Work for it first, so the record shows it waiting, then picked up.
const forCourier = await send(morgan, launch.id, `<@${courierId}> please collect the open questions for the launch.`);
const pickBefore = await http("GET", pathOf("GET", "agent-pickups") + `?type=conversation&id=${launch.id}`, morgan);
check(pickBefore.items.some((i) => i.user_id === courierId && i.seq === forCourier.message.seq && !i.read_at), "a mention of a connected agent waits for it to pick up");
const chatPick = await openAs("member", 1440, "light");
await chatPick.goto(`${frontend}/chat/${launch.id}`, { waitUntil: "domcontentloaded" });
await chatPick.waitForSelector(`[data-seq="${forCourier.message.seq}"] [data-testid="pickup-chip"][data-state="waiting"]`, { timeout: 15000 }).catch(() => fail("pickup", "no waiting chip on the message"));
await shot(chatPick, "pickup-waiting-light");
const inbox = await mcpCall(shown.server, shown.token, "tools/call", { name: "my_inbox", arguments: {} });
check(toolText(inbox).includes('"ok":true'), "my_inbox answers over the key", toolText(inbox).slice(0, 120));
const pickAfter = await http("GET", pathOf("GET", "agent-pickups") + `?type=conversation&id=${launch.id}`, morgan);
check(pickAfter.items.some((i) => i.user_id === courierId && i.seq === forCourier.message.seq && i.read_at), "my_inbox marks the work picked up");
await chatPick.reload({ waitUntil: "domcontentloaded" });
await chatPick.waitForSelector(`[data-seq="${forCourier.message.seq}"] [data-testid="pickup-chip"][data-state="picked"]`, { timeout: 15000 }).catch(() => fail("pickup", "the chip didn't say it was picked up"));
await shot(chatPick, "pickup-picked-light");
await chatPick.browserContext().close();
const seen = await http("GET", pathOf("GET", "team-agents/{agent_id}", { agent_id: courierId }), jordan);
check(!!seen.last_seen, "last seen updates once it connects", String(seen.last_seen));
await admin.click('[data-testid="key-saved"]');
await admin.reload({ waitUntil: "domcontentloaded" });
await admin.waitForSelector('[data-testid="agent-state"][data-state="Connected"]', { timeout: 15000 }).catch(() => fail("last seen", "the page doesn't say it's connected"));
await shot(admin, "agent-connected-light");
await axeCheck(admin, "agent page (connected)");

// A hosted agent with a brief, added from the same dialog.
const pilotName = `Pilot ${stamp}`;
await admin.goto(`${frontend}/team`, { waitUntil: "domcontentloaded" });
await admin.waitForSelector('[data-testid="add-agent-button"]', { timeout: 15000 });
await admin.click('[data-testid="add-agent-button"]');
await admin.waitForSelector('[data-testid="add-agent-dialog"]');
await admin.type('[data-testid="add-agent-name"]', pilotName);
await admin.type('[data-testid="add-agent-brief"]', "You keep the launch moving. Answer in two plain lines. If a choice is a person's to make, ask them with report_progress state waiting, then stop.");
await admin.evaluate((spaceName) => [...document.querySelectorAll('[data-testid="add-agent-dialog"] label')].find((l) => l.textContent?.trim() === spaceName)?.querySelector("button")?.click(), (await http("GET", pathOf("GET", "spaces"), jordan)).spaces.find((s) => s.id === launchSpace).name);
await admin.click('[data-testid="add-agent-submit"]');
await admin.waitForFunction(() => /\/team\/agents\/\d+/.test(location.pathname), { timeout: 15000 });
const pilotId = Number(admin.url().match(/\/team\/agents\/(\d+)/)?.[1]);
const pilotPage = await http("GET", pathOf("GET", "team-agents/{agent_id}", { agent_id: pilotId }), morgan);
check(pilotPage.brief.startsWith("You keep the launch moving"), "the hosted agent's page shows its brief");

// Run states from real rows: paused agents hold a run, then Stop and Retry spend its three tries.
await http("POST", pathOf("POST", "agents/pause"), jordan, { paused: true });
const held = await send(morgan, launch.id, `<@${pilotId}> what's still open for Friday?`);
let runs = (await http("GET", pathOf("GET", "team-agents/{agent_id}/runs", { agent_id: pilotId }), morgan)).items;
const heldRun = runs.find((r) => r.source_id === held.message.id);
check(heldRun?.status === "queued", "a paused workspace holds a run in the queue", heldRun?.status);
for (let i = 1; i <= 3; i++) {
  await http("POST", pathOf("POST", "agent-runs/{id}/stop", { id: heldRun.id }), morgan);
  if (i < 3) await http("POST", pathOf("POST", "agent-runs/{id}/retry", { id: heldRun.id }), morgan);
}
const spent = await raw("POST", pathOf("POST", "agent-runs/{id}/retry", { id: heldRun.id }), morgan);
check(spent.status === 400, "a fourth try is refused", String(spent.status));
// A run whose agent leaves the space before it starts ends with that reason.
const leaving = await send(morgan, launch.id, `<@${pilotId}> and the press list?`);
await http("PUT", pathOf("PUT", "team-agents/{agent_id}/spaces", { agent_id: pilotId }), jordan, { space_ids: [] });
await http("POST", pathOf("POST", "agents/pause"), jordan, { paused: false });
const leftRun = (await http("GET", pathOf("GET", "team-agents/{agent_id}/runs", { agent_id: pilotId }), morgan)).items.find((r) => r.source_id === leaving.message.id);
const gone = leftRun && await waitRun(morgan, pilotId, leftRun.id, (r) => r.status === "failed", 60);
check(gone?.reason === "removed_from_space", "a run whose agent left its space ends with that reason", gone?.reason ?? "still going");
await http("PUT", pathOf("PUT", "team-agents/{agent_id}/spaces", { agent_id: pilotId }), jordan, { space_ids: [launchSpace] });

if (!noModel) {
  // A real run: it should ask, wait, take the answer and finish.
  const asking = await send(morgan, launch.id, `<@${pilotId}> before anything else, ask me whether Tuesday or Wednesday suits for the press call, and wait for my answer.`);
  const askRun = await waitRun(morgan, pilotId, ((await http("GET", pathOf("GET", "team-agents/{agent_id}/runs", { agent_id: pilotId }), morgan)).items.find((r) => r.source_id === asking.message.id) ?? { id: 0 }).id, (r) => ["waiting", "done", "failed"].includes(r.status), 150);
  check(askRun?.status === "waiting", "a hosted run waits for the person it asked", `${askRun?.status} ${askRun?.reason ?? ""}`);
  const waitView = await openWith(jordan, 1440, "light", `/team/agents/${pilotId}`);
  await waitView.waitForSelector('[data-testid="agent-run"][data-state="waiting"]', { timeout: 15000 }).catch(() => fail("waiting", "the page doesn't show the waiting run"));
  await shot(waitView, "agent-waiting-light");
  if (askRun?.status === "waiting") {
    await send(morgan, askRun.thread_id, "Wednesday, thanks.");
    const finished = await waitRun(morgan, pilotId, askRun.id, (r) => ["done", "failed"].includes(r.status), 150);
    check(finished?.status === "done", "the reply picks the run up and it finishes", `${finished?.status} ${finished?.reason ?? ""}`);
    check((finished?.step_log?.length ?? 0) > 0, "the run kept its steps", String(finished?.step_log?.length));
    check(!JSON.stringify(finished?.step_log ?? []).includes("Wednesday"), "a step keeps no words");
  }
  await waitView.browserContext().close();
}

// The agent page with every run state on it, in light, dark and at 390 px.
for (const [width, theme] of [[1440, "light"], [1440, "dark"], [390, "light"], [390, "dark"]]) {
  const p = await openWith(jordan, width, theme, `/team/agents/${pilotId}`);
  await p.waitForSelector('[data-testid="agent-run"]', { timeout: 15000 }).catch(() => fail("agent page", `no runs at ${width} ${theme}`));
  const labels = await p.$$eval('[data-testid="agent-run-label"]', (ns) => ns.map((n) => n.textContent));
  if (width === 1440 && theme === "light") {
    check(labels.includes("Tried 3 times"), "after three tries the run says so, with no Retry", labels.join(", "));
    check(labels.includes("Couldn't finish"), "a run that ended short says so plainly", labels.join(", "));
    check(!labels.join(" ").match(/fail|error/i), "no run on the page says failed or error", labels.join(", "));
    const tried = await p.evaluate(() => [...document.querySelectorAll('[data-testid="agent-run"]')].find((n) => n.textContent.includes("Tried 3 times"))?.querySelector("button:not([data-testid='run-worked'])")?.textContent ?? "");
    check(!/Retry/.test(tried), "Tried 3 times offers no Retry", tried);
    const opener = await p.$('[data-testid="agent-run"] [data-testid="run-worked"][aria-expanded]');
    if (opener) {
      await opener.click();
      await p.waitForSelector('[data-testid="run-step"]', { timeout: 10000 }).catch(() => fail("steps", "the steps didn't open"));
    } else if (!noModel) fail("steps", "no run to open");
    await axeCheck(p, "agent page (hosted)");
  }
  await shot(p, `agent-hosted-${width === 390 ? "phone" : "desk"}-${theme}`);
  await noSideways(p, `agent page ${width} ${theme}`);
  await p.browserContext().close();
}
// Scout, the seeded agent, as the member who sponsors it.
const scoutView = await openAs("member", 1440, "dark");
await scoutView.goto(`${frontend}/team/agents/${scout.id}`, { waitUntil: "domcontentloaded" });
await scoutView.waitForSelector('[data-testid="agent-runs"]', { timeout: 15000 });
await shot(scoutView, "agent-scout-dark");
check(!(await scoutView.$('[data-testid="brief-edit"]')), "a member can't edit a brief on screen");
await scoutView.browserContext().close();

// Add Agent and the key panel, dark and at 390 px.
for (const [width, theme] of [[1440, "dark"], [390, "light"], [390, "dark"]]) {
  const p = await openWith(jordan, width, theme, "/team");
  await p.waitForSelector('[data-testid="add-agent-button"]', { timeout: 15000 });
  await p.click('[data-testid="add-agent-button"]');
  await p.waitForSelector('[data-testid="add-agent-dialog"]');
  await shot(p, `add-agent-${width === 390 ? "phone" : "desk"}-${theme}`);
  await p.keyboard.press("Escape");
  await p.goto(`${frontend}/team/agents/${courierId}`, { waitUntil: "domcontentloaded" });
  await p.waitForSelector('[data-testid="key-new"]', { timeout: 15000 });
  await p.click('[data-testid="key-new"]');
  await p.waitForSelector('[data-testid="key-dialog"]');
  await p.type('[data-testid="key-name"]', `Server ${theme} ${width}`);
  await p.click('[data-testid="key-make"]');
  await p.waitForSelector('[data-testid="key-once"]', { timeout: 10000 });
  await p.evaluate(() => document.querySelector('[data-testid="key-once"]')?.scrollIntoView({ block: "start" }));
  await shot(p, `key-panel-${width === 390 ? "phone" : "desk"}-${theme}`);
  await noSideways(p, `key panel ${width} ${theme}`);
  await p.click('[data-testid="key-saved"]');
  await p.browserContext().close();
}

// A sponsor hand-over, on screen: the keys end at once and the old one is refused.
await admin.goto(`${frontend}/team/agents/${courierId}`, { waitUntil: "domcontentloaded" });
await admin.waitForSelector('[data-testid="sponsor-change"]', { timeout: 15000 });
await admin.click('[data-testid="sponsor-change"]');
await admin.waitForSelector('[data-testid="sponsor-dialog"]');
await admin.waitForSelector('[data-testid="sponsor-pick"]:not([disabled])', { timeout: 20000 }).catch(() => fail("sponsor", "the sponsor list didn't load"));
await admin.click('[data-testid="sponsor-pick"]');
await admin.waitForSelector('[role="option"]', { timeout: 5000 });
await admin.evaluate(() => [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes("Morgan"))?.click());
await shot(admin, "sponsor-dialog-light");
await admin.click('[data-testid="sponsor-confirm"]');
await admin.waitForFunction(() => document.querySelector('[data-testid="agent-sponsor"]')?.textContent?.includes("Morgan"), { timeout: 10000 }).catch(() => fail("sponsor", "the page didn't show the new sponsor"));
const refused = await mcpCall(shown.server, shown.token, "tools/call", { name: "my_inbox", arguments: {} });
check(refused.status >= 400 || !toolText(refused).includes('"ok":true'), "a key ends at once when the sponsor changes", `${refused.status} ${toolText(refused).slice(0, 80)}`);

// Add it?: naming an agent outside the space holds the message, keeps the draft when you leave, and sends without the agent.
const spacesForMorgan = (await http("GET", pathOf("GET", "spaces"), morgan)).spaces;
const otherChannel = conversations.find((c) => c.kind === "channel" && c.space_id && c.space_id !== launchSpace && spacesForMorgan.some((s) => s.id === c.space_id));
if (otherChannel) {
  const ask = await openAs("member", 1440, "light");
  await ask.goto(`${frontend}/chat/${otherChannel.id}`, { waitUntil: "domcontentloaded" });
  await ask.waitForSelector('[data-testid="composer-input"]', { timeout: 15000 });
  await ask.click('[data-testid="composer-input"]');
  await ask.keyboard.type(`@${pilotName.slice(0, 5)}`);
  await ask.waitForSelector('[role="listbox"] [role="option"]', { timeout: 5000 });
  check(await ask.evaluate(() => document.querySelector('[role="listbox"]')?.textContent?.includes("Not in this space")), "@ offers an agent outside the space, marked as such");
  await ask.keyboard.press("Enter");
  await sleep(150);
  await ask.keyboard.type("can you list the open press questions?");
  await ask.keyboard.press("Enter");
  await ask.waitForSelector('[data-testid="agent-mention-warning"]', { timeout: 8000 }).catch(() => fail("Add it?", "no warning for an agent outside the space"));
  await shot(ask, "add-it-member-light");
  await axeCheck(ask, "Add it? warning", '[data-testid="agent-mention-warning"]');
  const draftBefore = await ask.$eval('[data-testid="composer-input"]', (n) => n.value);
  check(draftBefore.includes(pilotName), "the message stays in the composer under the warning", draftBefore);
  // Leave the conversation and come back: the draft is still there, and so is the question.
  await ask.goto(`${frontend}/chat/${launch.id}`, { waitUntil: "domcontentloaded" });
  await ask.waitForSelector('[data-testid="composer-input"]', { timeout: 15000 });
  await ask.goto(`${frontend}/chat/${otherChannel.id}`, { waitUntil: "domcontentloaded" });
  await ask.waitForSelector('[data-testid="composer-input"]', { timeout: 15000 });
  await ask.waitForFunction((n) => document.querySelector('[data-testid="composer-input"]')?.value.includes(n), { timeout: 8000 }, pilotName).catch(() => fail("Add it?", "the draft was lost on leaving"));
  await ask.waitForSelector('[data-testid="agent-mention-warning"]', { timeout: 8000 }).catch(() => fail("Add it?", "the warning didn't come back with the draft"));
  const runsBefore = (await http("GET", pathOf("GET", "team-agents/{agent_id}/runs", { agent_id: pilotId }), jordan)).items.length;
  await ask.click('[data-testid="agent-send-without"]');
  await sleep(2500);
  const sentPage = await http("GET", pathOf("GET", "conversations/{id}/messages", { id: otherChannel.id }), morgan);
  const sentBody = sentPage.items.at(-1)?.body ?? "";
  check(sentBody.includes(pilotName) && !sentBody.includes(`<@${pilotId}>`), "Send without agent sends it with the plain name", sentBody);
  const runsAfter = (await http("GET", pathOf("GET", "team-agents/{agent_id}/runs", { agent_id: pilotId }), jordan)).items.length;
  check(runsAfter === runsBefore, "Send without agent starts no run", `${runsBefore} → ${runsAfter}`);
  await ask.browserContext().close();
  // An admin manages every space, so they're offered Add and send.
  const askAdmin = await openWith(jordan, 390, "dark", `/chat/${otherChannel.id}`);
  await askAdmin.waitForSelector('[data-testid="composer-input"]', { timeout: 15000 });
  await askAdmin.click('[data-testid="composer-input"]');
  await askAdmin.keyboard.type(`@${courierName.slice(0, 6)}`);
  await askAdmin.waitForSelector('[role="listbox"] [role="option"]', { timeout: 5000 });
  await askAdmin.keyboard.press("Enter");
  await sleep(150);
  await askAdmin.keyboard.type("take a look");
  await askAdmin.click('[data-testid="composer-send"]');
  await askAdmin.waitForSelector('[data-testid="agent-add-send"]', { timeout: 8000 }).catch(() => fail("Add it?", "a manager isn't offered Add and send"));
  await shot(askAdmin, "add-it-admin-phone-dark");
  await askAdmin.browserContext().close();
} else fail("Add it?", "no channel outside the launch space to try it in");

// A guest never reaches an agent's page, by route or on screen.
const guestTry = await raw("GET", pathOf("GET", "team-agents/{agent_id}", { agent_id: pilotId }), riley);
check(guestTry.status === 403, "a guest is refused an agent's page by route", String(guestTry.status));
const guestHosted = await http("GET", pathOf("GET", "agents/hosted"), riley);
check(guestHosted.items.every((a) => !a.brief), "a guest gets no brief from the agent list");
const guestPage = await openAs("guest", 1440, "light");
await guestPage.goto(`${frontend}/team/agents/${pilotId}`, { waitUntil: "domcontentloaded" });
await sleep(1500);
check(!(await guestPage.$('[data-testid="agent-page"]')), "a guest is sent away from an agent's page", guestPage.url());
await guestPage.browserContext().close();

// Removing an agent leaves its page, with its history, saying so.
await http("POST", pathOf("POST", "members/{id}/remove", { id: courierId }), jordan, {});
await admin.goto(`${frontend}/team/agents/${courierId}`, { waitUntil: "domcontentloaded" });
await admin.waitForSelector('[data-testid="agent-stopped"]', { timeout: 15000 }).catch(() => fail("removed", "no removed banner"));
await shot(admin, "agent-removed-light");
await admin.browserContext().close();

check(!consoleErrors.length, "no errors in the console", consoleErrors.slice(0, 3).join(" | "));
await browser.close();
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(report.errors.length ? `✗ ${report.errors.length} failed` : "✓ all passed");
process.exit(report.errors.length ? 1 : 0);

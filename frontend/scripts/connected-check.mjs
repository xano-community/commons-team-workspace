#!/usr/bin/env node
// A connected agent from the outside, against a deployed backend: a real key over MCP doing real work, an approval a person decides
// in a real browser, and what a workflow test can't see, which is the transport, the trigger and the screens. Relay asks, Morgan
// decides, Riley the guest reads the result, and every card state is shot at desktop and phone width, in both themes.
//
//   node frontend/scripts/connected-check.mjs --backend <url> --frontend <url> [--out qa/connected]
//
// Exit 0 = pass, 1 = a check failed, 2 = usage.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { launchBrowser } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const backend = opt("backend")?.replace(/\/$/, "");
const frontend = opt("frontend")?.replace(/\/$/, "");
const out = resolve(opt("out", "qa/connected"));
if (!backend || !frontend) { console.error("usage: connected-check.mjs --backend <url> --frontend <url> [--out <dir>]"); process.exit(2); }
mkdirSync(out, { recursive: true });

const report = { backend, frontend, errors: [], timings: {} };
const fail = (what, detail) => { report.errors.push({ what, detail }); console.log(`✗ ${what}: ${detail}`); };
const check = (good, what, detail = "") => (good ? console.log(`✓ ${what}${detail ? `: ${detail}` : ""}`) : fail(what, detail || "no"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
/** axe at WCAG 2.1 AA, on the page or on what `include` picks out. */
const axeCheck = async (page, name, include) => {
  await page.evaluate(axeSource);
  const axe = await page.evaluate((sel) => window.axe.run(sel ? { include: [[sel]] } : document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }), include ?? null);
  const bad = axe.violations.map((v) => `${v.id} (${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(", ")})`);
  check(!bad.length, `${name}: axe`, bad.join("; "));
};
const until = async (read, seconds = 30) => { const end = Date.now() + seconds * 1000; for (;;) { const v = await read(); if (v || Date.now() > end) return v; await sleep(400); } };

const routes = JSON.parse(execFileSync("npx", ["xanosdk", "routes", "./xano/index.ts", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).routes;
const pathOf = (verb, name, params = {}) => Object.entries(params).reduce((p, [k, v]) => p.replace(`{${k}}`, v), routes.find((r) => r.verb === verb && r.ref.split("/").slice(1).join("/") === name).path);
/** A dev instance drops the odd read. A read is safe to ask again, and a write isn't. */
const raw = async (verb, path, token, body) => {
  for (let tries = 1; ; tries++) {
    const res = await fetch(backend + path, { method: verb, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }).catch((e) => { if (verb !== "GET" || tries >= 5) throw e; return null; });
    if (res && (verb !== "GET" || res.status < 500 || tries >= 5)) return { status: res.status, json: await res.json().catch(() => null) };
    await sleep(2000);
  }
};
const http = async (verb, path, token, body) => { const r = await raw(verb, path, token, body); if (r.status >= 400) throw new Error(`${verb} ${path}: ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
const signIn = async (persona) => (await http("POST", pathOf("POST", "auth/demo"), null, { persona })).authToken;

// The client: the session transport a real MCP client uses, one session per key.
const urlOf = (canonical) => execFileSync("node", ["--input-type=module", "-e", "import { mcpServer } from '@xano/sdk'; console.log(mcpServer({ name: 'qa', canonical: process.argv[1] }).getUrl(process.argv[2]))", canonical, backend], { encoding: "utf8" }).trim();
const rpc = async (url, token, session, body) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify(body) });
  const text = await res.text();
  const line = text.split("\n").map((l) => l.replace(/^data:\s*/, "")).find((l) => l.trim().startsWith("{")) ?? text;
  let json = null; try { json = JSON.parse(line); } catch { /* an empty answer to a notification */ }
  return { status: res.status, json, session: res.headers.get("mcp-session-id") };
};
async function connect(url, token) {
  const init = await rpc(url, token, null, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "connected-check", version: "1" } } });
  await rpc(url, token, init.session, { jsonrpc: "2.0", method: "notifications/initialized" });
  let id = 1;
  const call = async (method, params) => rpc(url, token, init.session, { jsonrpc: "2.0", id: id++, method, params });
  return {
    instructions: init.json?.result?.instructions ?? "",
    tools: async () => (await call("tools/list", {})).json?.result?.tools ?? [],
    /** A tool's answer, or `{ refused }` with its words. */
    tool: async (name, args = {}) => {
      const r = await call("tools/call", { name, arguments: args });
      const res = r.json?.result;
      const words = res?.content?.[0]?.text ?? r.json?.error?.message ?? JSON.stringify(r.json);
      if (r.json?.error || res?.isError) return { refused: words };
      try { return JSON.parse(words); } catch { return { said: words }; }
    },
  };
}

const morgan = await signIn("member");
const avery = await signIn("admin");
const riley = await signIn("guest");

// The key.
const connected = await http("GET", pathOf("GET", "agents/connected"), morgan);
const relay = connected.items.find((a) => a.name === "Relay");
check(!!relay, "Relay is a connected agent", relay ? `id ${relay.id}` : "");
const keysPath = pathOf("POST", "agents/{agent_id}/keys", { agent_id: relay.id });
const byGuest = await raw("POST", keysPath, riley, { name: "Mine", scope: "read_write", days: 1 });
check(byGuest.status >= 400, "a guest can't mint an agent key", String(byGuest.status));
const hosted = (await http("GET", pathOf("GET", "agents/hosted"), morgan)).items[0];
const forHosted = await raw("POST", pathOf("POST", "agents/{agent_id}/keys", { agent_id: hosted.id }), avery, { name: "Mine", scope: "read_write", days: 1 });
check(forHosted.status >= 400, "a hosted agent has no key to hand out", forHosted.json?.message ?? "");
const minted = await http("POST", keysPath, morgan, { name: "Check key", scope: "read_write", days: 7 });
check(minted.token?.length > 20 && minted.key.user_id === relay.id, "the sponsor mints a key on the agent's own row");
const listed = await http("GET", keysPath, morgan);
check(listed.items.length >= 1 && !JSON.stringify(listed).includes(minted.token), "the key list shows no token");

const url = urlOf("team-workspace-mcp");
const client = await connect(url, minted.token);
const tools = await client.tools();
check(tools.length === 11, "tools/list shows 11 tools", tools.map((t) => t.name).sort().join(", "));
check(!tools.some((t) => ["whats_new", "my_notifications", "request_role_change"].includes(t.name)), "the base app's three tools are gone");
check(/my_inbox/.test(client.instructions) && !/person who connected you, within/.test(client.instructions), "the server says how an agent works here");
const asPerson = await connect(url, morgan).catch(() => null);
check(!asPerson || !!(await asPerson.tool("my_inbox")).refused, "a person's session token isn't a key");

// Work a person gave it.
const conversations = await http("GET", pathOf("GET", "conversations"), morgan);
const launch = conversations.find((c) => c.name === "marlow-launch");
const room = (await http("GET", pathOf("GET", "conversations"), riley)).find((c) => c.name === "marlow-oakline");
check(!!launch && !!room, "the seeded channel and the client's room are there", room?.name);
const asked = await http("POST", pathOf("POST", "conversations/{id}/messages", { id: launch.id }), morgan, { client_msg_id: crypto.randomUUID(), body: `<@${relay.id}> can you add a task for the redirect list?` });
const inbox = await client.tool("my_inbox");
check(inbox.ok === true && inbox.items?.some((i) => i.kind === "mention" && i.seq === asked.message.seq), "my_inbox finds the mention", JSON.stringify(inbox.items?.at(-1)?.title ?? inbox));
const found = await client.tool("search", { q: "checkout" });
check(found.ok === true, "search runs", `${found.total ?? 0} results`);
const tasksPage = await http("GET", pathOf("GET", "tasks") + `?space_id=${launch.space_id}`, morgan).catch(() => null);
const task = (tasksPage?.items ?? [])[0];
const read = await client.tool("read_record", { type: "task", id: task?.id ?? 1 });
check(read.ok === true && !!read.record?.title, "read_record reads a task, with what's happened to it", read.record?.title ?? read.refused);
const made = await client.tool("save_task", { project_id: task?.project_id ?? 1, title: "Check the redirect list", status: "todo" });
check(made.task_id > 0 && !made.approval, "a write the team alone reads goes straight in", String(made.task_id ?? made.refused));
const saved = (await http("GET", pathOf("GET", "tasks/{id}", { id: made.task_id }), morgan)).task;
check(saved?.created_by === relay.id, "the agent is the task's author");
const seen = (await http("GET", pathOf("GET", "agents/connected"), morgan)).items.find((a) => a.id === relay.id);
check(!!seen.last_seen, "the app knows when the agent was last seen");

// Asking first, from the outside.
const words = `The staging link is ready for review. ${Date.now()}`;
const post = await client.tool("post_message", { conversation_id: room.id, body: words });
check(post.ok === true && post.approval?.status === "pending" && !post.message_id, "a post guests would read waits", post.approval?.message ?? post.refused);
const roomBefore = await http("GET", pathOf("GET", "conversations/{id}/messages", { id: room.id }), riley);
check(!JSON.stringify(roomBefore).includes(words), "the guest reads nothing of it yet");
const pending = await client.tool("check_approval", { approval_id: post.approval.approval_id });
check(pending.status === "pending", "check_approval says pending", pending.status);
const items = await http("GET", pathOf("GET", "app/notifications"), morgan);
check(items.items.some((n) => n.entity === "approval" && n.entity_id === post.approval.approval_id), "it's in the sponsor's inbox");
check(!(await http("GET", pathOf("GET", "app/notifications"), riley)).items.some((n) => n.entity === "approval"), "and not in the guest's");

// A person decides, in the app.
const browser = await launchBrowser();
const consoleErrors = [];
const openAs = async (who, width, theme) => {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height: width < 500 ? 844 : 900, hasTouch: width < 500, isMobile: width < 500, deviceScaleFactor: width < 500 ? 2 : 1 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.goto(`${frontend}/sign-in`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="demo-login"]', { timeout: 15000 });
  await page.evaluate((name) => [...document.querySelectorAll('[data-testid="demo-login"]')].find((b) => b.textContent?.includes(name))?.click(), who);
  await page.waitForSelector('[data-kit="user-menu"], [data-kit="user-menu-compact"]', { timeout: 15000 });
  return page;
};
const shot = async (page, name) => { await sleep(200); await page.screenshot({ path: join(out, `${name}.png`) }); };
const textOf = (page, sel) => page.$eval(sel, (n) => n.textContent ?? "").catch(() => "");
const openCard = async (page, id) => {
  await page.goto(`${frontend}/inbox?view=needs`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-item]", { timeout: 15000 });
  await page.evaluate(() => document.querySelector("[data-item]")?.click());
  await page.waitForSelector('[data-testid="approval-card"]', { timeout: 15000 });
  return id;
};

const desk = await openAs("Morgan", 1280, "light");
await openCard(desk, post.approval.approval_id);
const card = await textOf(desk, '[data-testid="approval-card"]');
check(/Relay/.test(card) && /wants to post in/.test(card) && card.includes(words), "the card says who, what and the exact words", card.slice(0, 120));
check(/Riley Park will see this/.test(await textOf(desk, '[data-testid="approval-audience"]')), "it names who outside the team will read it");
check(/Expires in 7 days/.test(card), "it says how long there is");
await shot(desk, "card-desktop-light");
await axeCheck(desk, "approval card, waiting", '[data-testid="approval-card"]');

await desk.click('[data-testid="approval-edit"]');
await desk.waitForSelector('[data-testid="approval-text"]');
check(await desk.evaluate(() => document.activeElement?.getAttribute("data-testid") === "approval-text"), "Edit puts the cursor in the words");
await desk.keyboard.press("Escape");
await sleep(100);
check(await desk.evaluate(() => document.activeElement?.getAttribute("data-testid") === "approval-edit"), "Escape keeps the original and goes back to Edit");
await desk.click('[data-testid="approval-edit"]');
await desk.waitForSelector('[data-testid="approval-text"]');
await desk.keyboard.type(" Thanks, Riley.");
await shot(desk, "card-editing-light");
await axeCheck(desk, "approval card, editing", '[data-testid="approval-card"]');
const edited = `${words} Thanks, Riley.`;
// Two quick presses make one decision.
await desk.evaluate(() => { const b = document.querySelector('[data-testid="approval-approve"]'); b?.click(); b?.click(); });
await desk.waitForSelector('[data-testid="approval-outcome"]', { timeout: 15000 }).catch(() => {});
await shot(desk, "card-approved-light");
await axeCheck(desk, "approval card, approved", '[data-testid="approval-card"]');
const line = await textOf(desk, '[data-testid="approval-outcome"]');
check(/Posted\. Relay · approved by Morgan Reyes/.test(line), "the card ends in plain words", line);

const after = await http("GET", pathOf("GET", "conversations/{id}/messages", { id: room.id }), riley);
const posted = after.items.filter((m) => m.body === edited);
check(posted.length === 1 && posted[0].author_id === relay.id && posted[0].approver_name === "Morgan Reyes", "the edited words posted once, as the agent, with the approver", JSON.stringify(posted.map((m) => [m.author_name, m.approver_name])));
const done = await client.tool("check_approval", { approval_id: post.approval.approval_id });
check(done.status === "approved", "check_approval says approved", done.status);
const started = Date.now();
const told = await until(async () => (await client.tool("my_inbox", { after: inbox.next_after })).items?.find((i) => i.kind === "approval_decided"), 60);
report.timings.triggerToInboxMs = Date.now() - started;
check(/Approved by Morgan Reyes/.test(told?.title ?? ""), "the decision reaches the agent's inbox", `${told?.title ?? "nothing"} after ${report.timings.triggerToInboxMs} ms`);
const stale = await raw("POST", pathOf("POST", "approvals/{id}/approve", { id: post.approval.approval_id }), morgan, {});
check(stale.status >= 400, "a second decision is refused", stale.json?.message);

await desk.goto(`${frontend}/chat/${room.id}`, { waitUntil: "domcontentloaded" });
await desk.waitForSelector('[data-testid="message-approved-by"]', { timeout: 15000 }).catch(() => {});
check(/approved by Morgan Reyes/.test(await textOf(desk, '[data-testid="message-approved-by"]')), "the message shows the agent and the approver");
await shot(desk, "message-approved-by-light");

// A decline comes back through the trigger.
const second = await client.tool("post_message", { conversation_id: room.id, body: "Shall I send the invoice too?" });
const noted = await client.tool("my_inbox", { after: inbox.next_after });
await openCard(desk, second.approval.approval_id);
await desk.click('[data-testid="approval-decline"]');
await desk.waitForSelector('[data-testid="approval-outcome"]', { timeout: 15000 }).catch(() => {});
await shot(desk, "card-declined-light");
await axeCheck(desk, "approval card, declined", '[data-testid="approval-card"]');
check(/Declined by Morgan Reyes\. Nothing happened/.test(await textOf(desk, '[data-testid="approval-outcome"]')), "a decline says nothing happened");
const heard = await until(async () => (await client.tool("my_inbox", { after: noted.next_after })).items?.find((i) => /Declined/.test(i.title)), 60);
check(!!heard, "the decline trigger tells the agent", heard?.title ?? "nothing in a minute");

// A refusal stays on the card: the agent lost the space between asking and the yes.
const third = await client.tool("post_message", { conversation_id: room.id, body: "One for after I've gone." });
await http("POST", pathOf("POST", "spaces/{id}/members/{user_id}/remove", { id: room.space_id, user_id: relay.id }), morgan, {});
await openCard(desk, third.approval.approval_id);
await desk.click('[data-testid="approval-approve"]');
await desk.waitForSelector('[data-testid="approval-problem"]', { timeout: 15000 }).catch(() => {});
const problem = await textOf(desk, '[data-testid="approval-problem"]');
check(/can't reach this any more/.test(problem), "a refusal stays on the card, in plain words", problem);
check(!!(await desk.$('[data-testid="approval-decline"]')), "and Decline is still there");
await shot(desk, "card-refused-light");
await axeCheck(desk, "approval card, refused", '[data-testid="approval-card"]');
await http("POST", pathOf("POST", "spaces/{id}/members", { id: room.space_id }), morgan, { user_id: relay.id, history_ok: true });
await desk.click('[data-testid="approval-decline"]');
await desk.waitForSelector('[data-testid="approval-outcome"]', { timeout: 15000 }).catch(() => {});

// On a record: the card for whoever decides, a line for the rest, nothing for a guest.
const onTask = await client.tool("post_message", { conversation_id: room.id, body: "On the record." });
await desk.goto(`${frontend}/chat/${room.id}`, { waitUntil: "domcontentloaded" });
await desk.waitForSelector('[data-testid="record-approvals"] [data-testid="approval-card"]', { timeout: 15000 }).catch(() => {});
check(!!(await desk.$('[data-testid="record-approvals"] [data-testid="approval-card"]')), "the record shows the card to whoever decides");
await shot(desk, "card-on-record-light");
await axeCheck(desk, "approvals on a record", '[data-testid="record-approvals"]');
const admin = await openAs("Avery", 1280, "dark");
await admin.goto(`${frontend}/chat/${room.id}`, { waitUntil: "domcontentloaded" });
await admin.waitForSelector('[data-testid="approval-waiting-line"]', { timeout: 15000 }).catch(() => {});
const quiet = await textOf(admin, '[data-testid="approval-waiting-line"]');
check(/Relay is waiting for Morgan Reyes/.test(quiet) && !quiet.includes("On the record"), "someone else reads that it's waiting, and not what it says", quiet);
await shot(admin, "waiting-line-dark");
await axeCheck(admin, "waiting line, dark", '[data-testid="approval-waiting-line"]');
const guest = await openAs("Riley", 1280, "light");
await guest.goto(`${frontend}/chat/${room.id}`, { waitUntil: "domcontentloaded" });
await guest.waitForSelector('[data-testid="message-list"]', { timeout: 15000 });
await sleep(800);
check(!(await guest.$('[data-testid="record-approvals"]')), "a guest sees no approval at all");
check(!(await textOf(guest, "body")).includes("On the record"), "and none of its words");
await shot(guest, "guest-room-light");

// Every look.
const phone = await openAs("Morgan", 390, "light");
await openCard(phone, onTask.approval.approval_id);
await shot(phone, "card-phone-light");
const roomy = await phone.evaluate(() => [...document.querySelectorAll('[data-testid="approval-card"] button')].filter((b) => b.offsetParent).every((b) => b.getBoundingClientRect().height >= 44));
check(roomy, "every button is a 44 px target on a phone");
check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scroll on a phone");
const phoneDark = await openAs("Morgan", 390, "dark");
await openCard(phoneDark, onTask.approval.approval_id);
await shot(phoneDark, "card-phone-dark");
await axeCheck(phoneDark, "approval card at 390 px, dark", '[data-testid="approval-card"]');
const deskDark = await openAs("Morgan", 1280, "dark");
await openCard(deskDark, onTask.approval.approval_id);
await shot(deskDark, "card-desktop-dark");
await deskDark.goto(`${frontend}/team`, { waitUntil: "domcontentloaded" });
await deskDark.waitForSelector('[data-testid="connected-agents"]', { timeout: 15000 }).catch(() => {});
check(/Last seen/.test(await textOf(deskDark, '[data-testid="agent-last-seen"]')) && /picks up work when it next runs/.test(await textOf(deskDark, '[data-testid="agent-last-seen"]')), "the Team page says when it was last seen, and when work gets picked up");
await shot(deskDark, "team-connected-dark");
await axeCheck(deskDark, "connected agents on Team, dark", '[data-testid="connected-agents"]');

// Rotation.
const rotated = await http("POST", pathOf("POST", "agents/{agent_id}/keys/{key_id}/rotate", { agent_id: relay.id, key_id: minted.key.id }), morgan, { days: 7 });
const oldKey = await client.tool("my_inbox");
check(!!oldKey.refused, "the old key stops at once", oldKey.refused);
const fresh = await connect(url, rotated.token);
const still = await fresh.tool("check_approval", { approval_id: onTask.approval.approval_id });
check(still.status === "pending", "check_approval still answers after rotation", still.status ?? still.refused);

// A task given to it says so.
await http("POST", pathOf("POST", "tasks/{id}/assign", { id: made.task_id }), morgan, { assignee_id: relay.id });
await deskDark.goto(`${frontend}/tasks/${made.task_id}`, { waitUntil: "domcontentloaded" });
await deskDark.waitForSelector('[data-testid="connected-note"]', { timeout: 15000 }).catch(() => {});
// Once the assignment is in its inbox, the waiting chip says it (U21), and the note keeps to when it was last seen.
const waitingChip = await deskDark.$('[data-testid="pickup-chip"][data-state="waiting"]');
check(/picks this up when it next runs/.test(await textOf(deskDark, '[data-testid="connected-note"]')) || (!!waitingChip && /pick this up/.test(await textOf(deskDark, '[data-testid="pickup-chip"]'))),
  "a task given to it says when it'll be picked up", await textOf(deskDark, '[data-testid="pickup-chip"]'));
const assigned = await fresh.tool("my_inbox", { after: inbox.next_after });
check(assigned.items?.some((i) => i.kind === "assigned"), "and the assignment reaches its inbox");

// A hosted agent asks too, with a real model, where the platform has one.
await hostedCheck();

// A person's sign-in, where the platform has one.
await signInCheck();

check(!consoleErrors.length, "no errors in the console", consoleErrors.slice(0, 3).join(" | "));
await browser.close();
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
if (report.errors.length) { console.log(`✗ ${report.errors.length} failed`); process.exit(1); }
console.log("✓ all passed");

/** A run in a guest space stops for a person, keeps its notes from the guest, and finishes on the answer. */
async function hostedCheck() {
  const list = await http("GET", pathOf("GET", "agents/hosted"), morgan);
  if (!list.model_ready) return console.log("! a hosted run in a guest space not checked: this target has no model key");
  await http("POST", pathOf("POST", "spaces/{id}/members", { id: room.space_id }), morgan, { user_id: hosted.id, history_ok: true });
  await http("POST", pathOf("POST", "conversations/{id}/messages", { id: room.id }), morgan, { client_msg_id: crypto.randomUUID(), body: `<@${hosted.id}> please tell Riley in one line, with post_message, that the review link is ready.` });
  const runsPath = pathOf("GET", "agent-runs") + `?conversation_id=${room.id}`;
  const waiting = await until(async () => (await http("GET", runsPath, morgan)).items.find((r) => r.status === "waiting" && r.approval_id > 0), 120);
  check(!!waiting, "a hosted run in a guest space waits for an approval", waiting ? `on ${waiting.approval_id}` : JSON.stringify((await http("GET", runsPath, morgan)).items[0]));
  if (!waiting) return;
  const asGuest = (await http("GET", runsPath, riley)).items.find((r) => r.id === waiting.id);
  check(!asGuest?.last_note, "the guest doesn't read what the run is saying");
  const thread = await http("GET", pathOf("GET", "conversations/{id}/messages", { id: waiting.thread_id }), riley);
  check(!thread.items.some((m) => m.run_note), "or its notes");
  await http("POST", pathOf("POST", "approvals/{id}/approve", { id: waiting.approval_id }), morgan, {});
  const finished = await until(async () => { const r = (await http("GET", runsPath, morgan)).items.find((x) => x.id === waiting.id); return r && (r.status === "done" || r.status === "failed") ? r : null; }, 120);
  check(finished?.status === "done", "the decision starts the run again, and it finishes", finished ? `${finished.status} ${finished.reason} ${finished.detail}` : "still going");
  const after = await http("GET", pathOf("GET", "conversations/{id}/messages", { id: waiting.thread_id }), riley);
  check(after.items.some((m) => m.author_id === hosted.id && m.approver_name === "Morgan Reyes"), "the guest reads what was approved, from the agent, with the approver");
  check(after.items.some((m) => m.run_note), "and its notes, now the result is approved");
}

/** ChatGPT and Claude on the web sign in as a person. They act as that person, through the app, and reach only what they joined. */
async function signInCheck() {
  const signUrl = urlOf("team-workspace-mcp-signin");
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "connected-check", version: "1" } } };
  const r0 = await fetch(signUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(init) });
  const meta = (r0.headers.get("www-authenticate") ?? "").match(/resource_metadata="([^"]+)"/)?.[1];
  if (r0.status !== 401 || !meta) return console.log("! sign-in not checked: this target has no hosted sign-in");
  const prm = await fetch(meta).then((r) => r.json());
  const asUrl = new URL(prm.authorization_servers[0]);
  const as = await fetch(`${asUrl.origin}/.well-known/oauth-authorization-server${asUrl.pathname}`).then((r) => r.json());
  const cb = await new Promise((res) => { const srv = createServer(); srv.listen(0, "127.0.0.1", () => res(srv)); });
  const redirect = `http://127.0.0.1:${cb.address().port}/callback`;
  const reg = await fetch(as.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [redirect], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }) }).then((r) => r.json());
  const verifier = randomBytes(32).toString("base64url"), state = randomBytes(12).toString("base64url");
  const authorize = new URL(as.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, state, resource: prm.resource, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" })) authorize.searchParams.set(k, v);
  const email = `connected-${Date.now()}@example.com`, password = `Qa-${randomBytes(8).toString("hex")}-7Zz!`;
  const made = await http("POST", pathOf("POST", "auth/signup"), null, { name: "Sam Sign-in", email, password });
  const open = (await http("GET", pathOf("GET", "spaces"), made.authToken)).spaces.find((s) => s.visibility === "open");
  await http("POST", pathOf("POST", "spaces/{id}/join", { id: open.id }), made.authToken, {});
  const got = new Promise((res) => cb.on("request", (req, resp) => { resp.end("done"); const u = new URL(req.url, redirect); if (u.pathname === "/callback") res(Object.fromEntries(u.searchParams)); }));
  const page = await browser.newPage();
  await page.goto(authorize.href, { waitUntil: "networkidle0" });
  await page.waitForSelector("#email", { visible: true, timeout: 15000 });
  await page.type("#email", email);
  await page.type("#password", password);
  await page.click("#signin-submit");
  await page.waitForSelector("#allow", { visible: true, timeout: 15000 });
  await page.click("#allow");
  const back = await Promise.race([got, sleep(30000).then(() => null)]);
  cb.close();
  await page.close();
  if (!back?.code) return fail("sign-in", "Allow didn't come back with a code");
  const tok = await fetch(as.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: back.code, code_verifier: verifier, redirect_uri: redirect, client_id: reg.client_id, resource: prm.resource }) }).then((r) => r.json());
  const signed = await connect(signUrl, tok.access_token);
  const names = (await signed.tools()).map((t) => t.name);
  check(names.length === 11, "the sign-in server's tools/list shows 11 too", names.length ? names.join(", ") : "none");
  const general = (await http("GET", pathOf("GET", "conversations"), made.authToken)).find((c) => c.kind === "channel");
  const posted = await signed.tool("post_message_signin", { conversation_id: general.id, body: "Morning from my assistant." });
  check(posted.message_id > 0, "a signed-in client acts", String(posted.message_id ?? posted.refused));
  const history = await http("GET", pathOf("GET", "conversations/{id}/messages", { id: general.id }), made.authToken);
  const row = history.items.find((m) => m.id === posted.message_id);
  check(row?.author_name === "Sam Sign-in" && row?.via === "ChatGPT", "and shows as the person, via the app", `${row?.author_name} via ${row?.via}`);
  const rooms = await http("GET", pathOf("GET", "conversations"), morgan);
  const hidden = rooms.find((c) => c.name === "marlow-launch");
  const refused = await signed.tool("read_record_signin", { type: "conversation", id: hidden.id });
  check(!!refused.refused, "and reaches only what the person joined", refused.refused);
}

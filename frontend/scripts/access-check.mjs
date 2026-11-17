#!/usr/bin/env node
// Who reaches what, across the whole app, against a deployed demo: what one tool's check can't see. Three gates:
//
//   leaks    Words planted in a private space, a DM and the customer list. Then every GET route, with every planted id in
//            every path, every live channel and the MCP tools are asked as someone who mustn't read them: a member outside
//            the space, the guest, an admin outside the DM, and keys owned by a person and by a connected agent. None of the
//            planted words may come back. An admin's browser session sees the space, and nobody sees the DM.
//   guest    Riley, the guest, walks every screen and every planted record's address in a real browser. Nothing planted
//            shows, members-only screens send her home, Customers isn't in her nav, and nothing on the way errors.
//   removal  A member taken out of a space loses every record in it at once: reads, lists, search, their open screen, the
//            work assigned to them. A person taken out of the workspace loses their session and their keys.
//
// Each screen's own removal notice (chat, tasks, docs, files) is in that tool's check; this one proves the reach behind them.
//
//   node frontend/scripts/access-check.mjs --backend <url> --frontend <url> [--out qa/access] [--only leaks,guest,removal]
//
// Exit 0 = pass, 1 = a check failed, 2 = usage.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchBrowser } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const backend = opt("backend")?.replace(/\/$/, "");
const frontend = opt("frontend")?.replace(/\/$/, "");
const out = resolve(opt("out", "qa/access"));
const only = new Set((opt("only", "leaks,guest,removal")).split(","));
if (!backend || !frontend) { console.error("usage: access-check.mjs --backend <url> --frontend <url> [--out <dir>] [--only leaks,guest,removal]"); process.exit(2); }
mkdirSync(out, { recursive: true });

const report = { backend, frontend, gates: {}, errors: [] };
let gate = "setup";
const fail = (what, detail) => { report.errors.push({ gate, what, detail }); console.log(`✗ ${what}: ${detail}`); };
const check = (good, what, detail = "") => (good ? console.log(`✓ ${what}${detail ? `: ${detail}` : ""}`) : fail(what, detail || "no"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const routes = JSON.parse(execFileSync("npx", ["xanosdk", "routes", "./xano/index.ts", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).routes
  .map((r) => ({ ...r, name: r.ref.split("/").slice(1).join("/") }));
const pathOf = (verb, name, params = {}) => Object.entries(params).reduce((p, [k, v]) => p.replace(`{${k}}`, v), routes.find((r) => r.verb === verb && r.name === name).path);
const raw = async (verb, path, token, body) => {
  const res = await fetch(backend + path, { method: verb, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* bytes, or nothing */ }
  return { status: res.status, json, text };
};
const http = async (verb, path, token, body) => {
  const r = await raw(verb, path, token, body);
  if (r.status >= 400) throw new Error(`${verb} ${path}: ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
};
const signIn = async (persona) => (await http("POST", pathOf("POST", "auth/demo"), null, { persona })).authToken;
const send = (token, id, body) => http("POST", pathOf("POST", "conversations/{id}/messages", { id }), token, { client_msg_id: crypto.randomUUID(), body });
const upload = async (token, name, text, spaceId) => {
  const form = new FormData();
  form.append("file", new File([text], name, { type: "text/plain" }));
  form.append("client_id", crypto.randomUUID());
  form.append("place_type", "space");
  form.append("place_id", String(spaceId));
  const res = await fetch(backend + pathOf("POST", "files"), { method: "POST", body: form, headers: { authorization: `Bearer ${token}` } });
  return res.json();
};
const paragraph = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });

// MCP, as a real client talks to it: one session per key.
const mcpUrl = execFileSync("node", ["--input-type=module", "-e", "import { mcpServer } from '@xano/sdk'; console.log(mcpServer({ name: 'qa', canonical: process.argv[1] }).getUrl(process.argv[2]))", "team-workspace-mcp", backend], { encoding: "utf8" }).trim();
const rpc = async (token, session, body) => {
  const res = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25", authorization: `Bearer ${token}`, ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, session: res.headers.get("mcp-session-id") };
};
async function mcp(token) {
  const init = await rpc(token, null, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "access-check", version: "1" } } });
  await rpc(token, init.session, { jsonrpc: "2.0", method: "notifications/initialized" });
  let id = 1;
  return { status: init.status, tool: async (name, args) => (await rpc(token, init.session, { jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } })).text };
}

// ── The cast ───────────────────────────────────────────────────────────────────────────────────────
const stamp = Date.now() % 1_000_000;
const avery = await signIn("admin");
const morgan = await signIn("member");
const riley = await signIn("guest");
const me = async (token) => http("GET", pathOf("GET", "auth/me"), token);
const [averyMe, morganMe, rileyMe] = [await me(avery), await me(morgan), await me(riley)];
/** A real account, invited by the demo admin: a demo session can't remove people or hold an admin's full rights. */
const invite = async (name, role) => {
  const made = await http("POST", pathOf("POST", "auth/invites"), avery, { email: `${name.toLowerCase().replace(/\s/g, ".")}.${stamp}@access.example`, name, role });
  const token = (await http("POST", pathOf("POST", "auth/link/accept"), null, { token: made.token, name, password: "Access-pass-1" })).authToken;
  return { token, me: await me(token) };
};
const jordan = await invite("Jordan Hale", "admin");
const casey = await invite("Casey Ward", "member");

// Every word planted is unique to this run, so a leak can't be mistaken for seed data.
const word = (kind) => `qz${stamp}${kind}`;
const planted = {};
const mkSpace = async (name, members = []) => {
  const space = await http("POST", pathOf("POST", "spaces"), avery, { name, visibility: "private" });
  for (const m of members) await http("POST", pathOf("POST", "spaces/{id}/members", { id: space.id }), avery, { user_id: m });
  const channel = (await http("GET", pathOf("GET", "conversations"), avery)).find((c) => c.space_id === space.id);
  return { space, channel };
};
/** One of every record a space holds, each carrying `prefix` and its kind in its words. */
async function fill(token, space, channel, prefix) {
  const ids = { space: space.id, conversation: channel.id };
  const msg = await send(token, channel.id, `${prefix}message: the vault combination is 4-8-15`);
  ids.message = msg.message.id;
  const thread = await http("POST", pathOf("POST", "threads"), token, { record_type: "message", record_id: msg.message.id }).catch(() => null);
  if (thread?.id) { ids.thread = thread.id; await send(token, thread.id, `${prefix}reply: and the spare key is under the mat`); }
  const project = await http("POST", pathOf("POST", "projects"), token, { space_id: space.id, name: `${prefix}project` });
  ids.project = project.id;
  const task = await http("POST", pathOf("POST", "tasks"), token, { project_id: project.id, client_id: crypto.randomUUID(), title: `${prefix}task`, description: `${prefix}taskbody`, status: "todo", priority: "medium" });
  ids.task = task.id;
  const doc = await http("POST", pathOf("POST", "doc-create"), token, { space_id: space.id, title: `${prefix}doc`, body: { type: "doc", content: [paragraph(`${prefix}docbody`)] } });
  ids.doc = doc.id ?? doc.doc?.id;
  const file = await upload(token, `${prefix}file.txt`, `${prefix}filebytes`, space.id);
  ids.file = file.id ?? file.file?.id;
  return ids;
}

// ── Leaks ─────────────────────────────────────────────────────────────────────────────────────────
/** Plants the words: once, whichever gate runs first. */
async function plant() {
  if (planted.vault) return;
  // A private space only Avery is in, with a mention of Morgan in it; a DM between Morgan and Casey; a company, which needs crm.read.
  const vault = await mkSpace(`Vault ${stamp}`);
  planted.vault = await fill(avery, vault.space, vault.channel, word("v"));
  await send(avery, vault.channel.id, `<@${morganMe.id}> ${word("v")}mention: are you free for the vault review?`);
  const dm = await http("POST", pathOf("POST", "conversations/dm"), morgan, { user_ids: [casey.me.id] });
  const dmMsg = await send(morgan, dm.id, `${word("d")}message: my salary review is on Friday`);
  planted.dm = { conversation: dm.id, message: dmMsg.message.id };
  const dmThread = await http("POST", pathOf("POST", "threads"), morgan, { record_type: "message", record_id: dmMsg.message.id }).catch(() => null);
  if (dmThread?.id) { planted.dm.thread = dmThread.id; await send(casey.token, dmThread.id, `${word("d")}reply: good luck`); }
  const company = await http("POST", pathOf("POST", "companies"), avery, { client_id: crypto.randomUUID(), name: `${word("c")}company`, about: `${word("c")}about` });
  planted.crm = { company: company.id };
  const stages = (await http("GET", pathOf("GET", "pipeline"), avery)).stages ?? [];
  const deal = await http("POST", pathOf("POST", "deals"), avery, { client_id: crypto.randomUUID(), company_id: company.id, stage_id: stages[0]?.id, title: `${word("c")}deal`, value: 9000 }).catch(() => null);
  if (deal?.id) planted.crm.deal = deal.id;

  report.planted = planted;
  check(!!planted.vault.thread && !!planted.dm.thread && !!planted.crm.deal, "a thread in the space and the DM, and a deal, were planted too", JSON.stringify({ thread: planted.vault.thread, dm: planted.dm.thread, deal: planted.crm.deal }));
}

async function leaks() {
  await plant();
  gate = "leaks";
  console.log("\n── leaks");
  const { dm, company } = { dm: { id: planted.dm.conversation }, company: { id: planted.crm.company } };
  // The control: each owner reads their own words, so a silent sweep below means refused, not missing.
  const owns = async (token, path, w, what) => check((await raw("GET", path, token)).text.includes(w), `control: ${what}`);
  await owns(avery, pathOf("GET", "tasks/{id}", { id: planted.vault.task }), word("v"), "Avery reads the vault's task");
  await owns(casey.token, `${pathOf("GET", "conversations/{id}/messages", { id: dm.id })}`, word("d"), "Casey reads the DM");
  await owns(morgan, `${pathOf("GET", "companies/{id}", { id: company.id })}`, word("c"), "Morgan, with crm.read, reads the company");
  const searched = await raw("GET", `${pathOf("GET", "search")}?q=${word("v")}task`, avery);
  check(searched.text.includes(word("v")), "control: search finds the vault's task for Avery");

  // Who mustn't read what. Avery is an admin in a browser: every space, but never a DM.
  const outsiders = [
    { who: "Morgan, a member outside the space", token: morgan, banned: ["v"] },
    { who: "Riley, the guest", token: riley, banned: ["v", "d", "c"] },
    { who: "Avery, an admin outside the DM", token: avery, banned: ["d"] },
    { who: "Jordan, a real admin outside the DM", token: jordan.token, banned: ["d"] },
  ];
  const ids = [...new Set([...Object.values(planted.vault), ...Object.values(planted.dm), ...Object.values(planted.crm)].filter(Boolean))];
  const queries = ["", `?q=${word("")}`, `?q=${word("v")}`, `?q=${word("d")}`, `?q=${word("c")}`, `?space_id=${planted.vault.space}`, `?conversation_id=${planted.vault.conversation}`,
    `?conversation_id=${planted.dm.conversation}`, `?type=conversation&id=${planted.vault.conversation}`, `?type=conversation&id=${planted.dm.conversation}`, `?type=task&id=${planted.vault.task}`,
    `?type=doc&id=${planted.vault.doc}`, `?type=company&id=${planted.crm.company}`, `?space=${planted.vault.space}`, `?channel=spaces/${planted.vault.space}&after=-1`,
    `?channel=conversations/${planted.dm.conversation}&after=-1`, `?channel=crm&after=-1`];
  const gets = routes.filter((r) => r.verb === "GET" && !/^mcp_oauth\//.test(r.name));
  let asked = 0;
  const found = [];
  for (const o of outsiders) {
    const banned = o.banned.map(word);
    const look = async (path) => {
      asked += 1;
      const r = await raw("GET", path, o.token);
      // An answer may echo the question back: only the words it couldn't have been given count.
      const question = decodeURIComponent(path.match(/[?&]q=([^&]*)/)?.[1] ?? "\u0000");
      const text = r.text.split(question).join("");
      const hit = banned.find((b) => text.includes(b));
      if (hit) found.push(`${o.who}: GET ${path} (${r.status}) holds ${hit}…`);
    };
    for (const r of gets) {
      const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      if (!params.length) { for (const q of queries) await look(r.path + q); continue; }
      for (const id of ids) {
        const path = params.reduce((p, k) => p.replace(`{${k}}`, id), r.path);
        await look(path);
        if (params.length === 1) for (const q of ["?after=-1", `?q=${word("")}`]) await look(path + q);
      }
    }
  }
  report.gates.leaks = { requests: asked };
  check(!found.length, `no planted word reaches anyone who mustn't read it, over ${asked} requests`, found.slice(0, 6).join(" | "));

  // The live server: joining a channel that carries the space's or the DM's ids is refused.
  const live = `${backend.replace(/^http/, "ws")}/ws/live`;
  const join = (token, channel) => new Promise((done) => {
    const socket = new WebSocket(live, token);
    const frames = [];
    const end = (v) => { try { socket.close(); } catch { /* closed */ } done(v); };
    socket.onopen = () => setTimeout(() => socket.send(JSON.stringify({ action: "join", channel })), 200);
    socket.onmessage = (e) => { const f = JSON.parse(String(e.data)); frames.push(f); if (f.channel === channel || f.action === "error" || f.action === "join") setTimeout(() => end(frames), 300); };
    socket.onerror = () => end([{ action: "error", note: "socket" }]);
    setTimeout(() => end(frames), 4000);
  });
  const joined = (frames) => frames.some((f) => f.action === "join" && (f.status ?? "ok") !== "error" && !f.error && f.payload?.ok !== false);
  check(joined(await join(avery, `spaces/${planted.vault.space}`)), "control: Avery joins the vault's live channel");
  for (const [who, token, channel] of [["Morgan", morgan, `spaces/${planted.vault.space}`], ["Morgan", morgan, `rooms/conversation-${planted.vault.conversation}`], ["Riley", riley, `spaces/${planted.vault.space}`],
    ["Avery", avery, `rooms/conversation-${planted.dm.conversation}`], ["Avery", avery, `typing/${planted.dm.conversation}`]]) {
    const frames = await join(token, channel);
    check(!joined(frames), `${who} can't join ${channel}`, JSON.stringify(frames.at(-1) ?? {}).slice(0, 120));
  }

  // MCP: a key reaches only its owner's joined spaces and DMs, even an admin's; a connected agent only its own spaces.
  const jordanKey = (await http("POST", pathOf("POST", "agent/connections"), jordan.token, { name: "Access check", scope: "read", days: 1 })).token;
  const relay = (await http("GET", pathOf("GET", "agents/connected"), morgan)).items.find((a) => a.name === "Relay");
  const relayKey = relay && (await http("POST", pathOf("POST", "agents/{agent_id}/keys", { agent_id: relay.id }), morgan, { name: "Access check", scope: "read", days: 1 })).token;
  const averyKey = (await http("POST", pathOf("POST", "agent/connections"), avery, { name: "Access check", scope: "read", days: 1 })).token;
  const averyMcp = await mcp(averyKey);
  check((await averyMcp.tool("search", { q: `${word("v")}task` })).includes(word("v")), "control: Avery's own key finds the vault's task, a space she joined");
  const reads = [["conversation", planted.vault.conversation], ["task", planted.vault.task], ["project", planted.vault.project], ["doc", planted.vault.doc], ["file", planted.vault.file],
    ["conversation", planted.dm.conversation], ["company", planted.crm.company], ...(planted.crm.deal ? [["deal", planted.crm.deal]] : [])];
  for (const [who, key, banned] of [["Jordan's own key (an admin)", jordanKey, ["v", "d"]], ["Relay's key (Morgan's connected agent)", relayKey, ["v", "d"]]]) {
    if (!key) { fail("mcp", `${who}: no key`); continue; }
    const session = await mcp(key);
    const answers = [];
    for (const q of [word("v"), word("d"), `${word("v")}task`, `${word("d")}message`]) answers.push(await session.tool("search", { q }));
    for (const [type, id] of reads) answers.push(await session.tool("read_record", { type, id }));
    answers.push(await session.tool("my_inbox", {}));
    const echoless = answers.map((a) => [word("v"), word("d"), `${word("v")}task`, `${word("d")}message`].reduce((t, q) => t.split(`"${q}"`).join(""), a));
    const hit = banned.map(word).find((b) => echoless.some((a) => a.includes(b)));
    check(session.status === 200 && !hit, `${who} reads none of it over MCP`, hit ? `holds ${hit}` : `status ${session.status}`);
  }
}

// ── Guest walk ────────────────────────────────────────────────────────────────────────────────────
async function guestWalk(browser) {
  await plant();
  gate = "guest";
  console.log("\n── guest walk");
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|status of 4\d\d/.test(m.text())) errors.push(m.text()); });
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${frontend}/sign-in`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="demo-login"]', { timeout: 15000 });
  await page.evaluate(() => [...document.querySelectorAll('[data-testid="demo-login"]')].find((b) => b.textContent?.includes("Riley"))?.click());
  await page.waitForSelector('[data-kit="user-menu"]', { timeout: 15000 });
  const banned = ["v", "d", "c"].map(word);
  const nav = await page.$$eval("nav a[href]", (as) => as.map((a) => a.getAttribute("href")));
  check(!nav.some((h) => /^\/(crm|customers)/.test(h)), "Customers isn't in a guest's nav", nav.join(" "));
  check(!nav.some((h) => /^\/(team|approvals|agents)$/.test(h)), "nor Team, Approvals or Agents", nav.filter((h) => /team|approvals|agents/.test(h)).join(" "));

  const scout = (await http("GET", pathOf("GET", "agents/hosted"), riley)).items[0];
  const stops = [
    ...["/", "/inbox", "/chat", "/tasks", "/docs", "/files", "/activity", "/settings", "/profile"].map((p) => ({ path: p })),
    ...["/team", "/approvals", "/agents"].map((p) => ({ path: p, home: true })),
    { path: "/crm", blocked: true }, { path: `/crm/companies/${planted.crm.company}`, blocked: true }, ...(planted.crm.deal ? [{ path: `/crm/deals/${planted.crm.deal}`, blocked: true }] : []),
    { path: `/chat/${planted.vault.conversation}`, blocked: true }, { path: `/chat/${planted.dm.conversation}`, blocked: true },
    { path: `/tasks/${planted.vault.task}`, blocked: true }, { path: `/docs/${planted.vault.doc}`, blocked: true }, { path: `/files/${planted.vault.file}`, blocked: true },
    { path: `/tasks?space=${planted.vault.space}`, blocked: true }, { path: `/?space=${planted.vault.space}`, blocked: true },
    ...(scout ? [{ path: `/team/agents/${scout.id}`, home: true }] : []),
  ];
  let walked = 0;
  for (const stop of stops) {
    errors.length = 0;
    await page.goto(`${frontend}${stop.path}`, { waitUntil: "domcontentloaded" });
    await page.waitForNetworkIdle({ idleTime: 400, timeout: 10000 }).catch(() => {});
    await sleep(300);
    const seen = await page.evaluate(() => ({ text: document.body.innerText, main: document.querySelector("main")?.innerText.trim() ?? "", path: location.pathname }));
    const hit = banned.find((b) => seen.text.includes(b));
    const name = `guest ${stop.path}`;
    walked += 1;
    if (hit) fail(name, `shows ${hit}…`);
    else if (stop.home && seen.path !== "/") fail(name, `a members-only screen let the guest stay, at ${seen.path}`);
    else if (!seen.main) fail(name, "the screen is blank");
    else if (/something went wrong/i.test(seen.text)) fail(name, "the screen crashed");
    else if (errors.length) fail(name, `console: ${errors[0].slice(0, 160)}`);
    else console.log(`✓ ${name}${stop.home ? ": sent home" : stop.blocked ? ": nothing of it shows" : ""}`);
    if (stop.blocked && stop.path.startsWith(`/files/${planted.vault.file}`)) await page.screenshot({ path: join(out, "guest-file-refused.png") });
  }
  // ⌘K: the guest's search finds nothing planted.
  await page.goto(`${frontend}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-kit="user-menu"]', { timeout: 15000 });
  await page.keyboard.down("Control"); await page.keyboard.press("k"); await page.keyboard.up("Control");
  await page.waitForSelector("[cmdk-input]", { timeout: 5000 }).catch(() => {});
  await page.keyboard.type(word(""));
  await sleep(1500);
  const palette = await page.evaluate(() => document.body.innerText);
  check(!banned.some((b) => palette.includes(b)), "a guest's ⌘K finds nothing planted");
  report.gates.guest = { stops: walked };
  await page.screenshot({ path: join(out, "guest-palette.png") });
  await ctx.close();
}

// ── Removal ───────────────────────────────────────────────────────────────────────────────────────
async function removal(browser) {
  gate = "removal";
  console.log("\n── removal");
  const room = await mkSpace(`Leaving ${stamp}`, [morganMe.id]);
  const ids = await fill(avery, room.space, room.channel, word("r"));
  // Work assigned to the person who'll leave.
  await http("POST", pathOf("POST", "tasks/{id}/assign", { id: ids.task }), avery, { assignee_id: morganMe.id });
  const reads = [
    ["the channel", pathOf("GET", "conversations/{id}/messages", { id: ids.conversation })],
    ...(ids.thread ? [["the thread", pathOf("GET", "conversations/{id}/messages", { id: ids.thread })]] : []),
    ["the task", pathOf("GET", "tasks/{id}", { id: ids.task })],
    ["the doc", pathOf("GET", "docs/{id}", { id: ids.doc })],
    ["the file", pathOf("GET", "files/{id}", { id: ids.file })],
    ["the file's bytes", pathOf("GET", "files/{id}/raw", { id: ids.file })],
    ["the space", pathOf("GET", "spaces/{id}", { id: room.space.id })],
  ];
  const lists = [["tasks", pathOf("GET", "tasks")], ["docs", pathOf("GET", "doc-list")], ["files", pathOf("GET", "files")], ["search", `${pathOf("GET", "search")}?q=${word("r")}`], ["conversations", pathOf("GET", "conversations")]];
  const w = word("r");
  for (const [what, path] of reads) check((await raw("GET", path, morgan)).text.includes(w) || what === "the space", `before: Morgan reads ${what}`);
  check((await raw("GET", `${pathOf("GET", "search")}?q=${w}task`, morgan)).text.includes(w), "before: Morgan's search finds the task");

  // Morgan has the channel open when it happens.
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 860 });
  await page.goto(`${frontend}/sign-in`, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => localStorage.setItem("app.token", t), morgan);
  await page.goto(`${frontend}/chat/${ids.conversation}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="message-list"]', { timeout: 15000 }).catch(() => fail("removal", "Morgan's channel didn't open"));
  await page.waitForFunction(() => document.documentElement.dataset.live === "live", { timeout: 12000 }).catch(() => {});
  check(await page.evaluate((x) => document.body.innerText.includes(x), w), "before: Morgan's screen shows the channel");

  const started = Date.now();
  await http("POST", pathOf("POST", "spaces/{id}/members/{user_id}/remove", { id: room.space.id, user_id: morganMe.id }), avery, {});
  const told = await page.waitForSelector('[data-testid="chat-removed"]', { timeout: 8000 }).then(() => Date.now() - started, () => null);
  check(told !== null, "Morgan's open screen says so at once", told === null ? "no notice in 8 s" : `${told} ms`);
  await sleep(500);
  const left = await page.evaluate((x) => [...document.querySelectorAll('[data-testid="message-list"]')].some((n) => n.innerText.includes(x)), `${w}message`);
  check(!left, "and the channel's messages are gone from it");
  await page.screenshot({ path: join(out, "removed-open-channel.png") });
  await ctx.close();
  for (const [what, path] of reads) {
    const r = await raw("GET", path, morgan);
    // A file answers 200 with a state saying why it can't be shown, so the words decide.
    check(!r.text.includes(w) && (r.status >= 400 || what === "the file"), `after: ${what} is refused`, `${r.status}${r.text.includes(w) ? ", with its words" : ""}`);
  }
  for (const [what, path] of lists) check(!(await raw("GET", path, morgan)).text.includes(w), `after: ${what} hold nothing of the space`);
  const task = (await http("GET", pathOf("GET", "tasks/{id}", { id: ids.task }), avery)).task ?? {};
  check(!task.assignee_id || task.assignee_id !== morganMe.id, "after: the work assigned to Morgan there is let go", `assignee ${task.assignee_id}`);
  // The managers' notice is proven in xano/test/access.ts; the remover here is the only manager, and isn't told about herself.

  // Out of the workspace: the session and every key end at once.
  const caseyDm = await http("POST", pathOf("POST", "conversations/dm"), casey.token, { user_ids: [morganMe.id] });
  await send(casey.token, caseyDm.id, "before I go");
  check((await raw("GET", pathOf("GET", "conversations/{id}/messages", { id: caseyDm.id }), casey.token)).status === 200, "before: Casey reads a DM");
  const caseyKey = (await http("POST", pathOf("POST", "agent/connections"), casey.token, { name: "Access check", scope: "read", days: 1 })).token;
  const caseyMcp = await mcp(caseyKey);
  check(caseyMcp.status === 200, "before: Casey's key connects");
  const offboard = await http("GET", pathOf("GET", "members/{id}/offboarding", { id: casey.me.id }), jordan.token).catch(() => ({}));
  await http("POST", pathOf("POST", "members/{id}/remove", { id: casey.me.id }), jordan.token, { new_sponsor_id: offboard?.needs_sponsor ? jordan.me.id : undefined });
  const after = await raw("GET", pathOf("GET", "auth/me"), casey.token);
  check(after.status === 401 || after.status === 403, "after: a person out of the workspace is signed out", String(after.status));
  const keyAfter = await mcp(caseyKey);
  const inbox = keyAfter.status === 200 ? await keyAfter.tool("my_inbox", {}) : "";
  const refusedKey = keyAfter.status >= 400 || /"isError":\s*true/.test(inbox) || !/"ok":\s*true|\\"ok\\":true/.test(inbox);
  check(refusedKey, "after: and their key is refused", `${keyAfter.status} ${inbox.replace(/\s+/g, " ").slice(0, 120)}`);
  const dmAfter = await raw("GET", pathOf("GET", "conversations/{id}/messages", { id: caseyDm.id }), casey.token);
  check(dmAfter.status >= 400, "after: their DMs are closed to the old session", String(dmAfter.status));
}

let browser;
try {
  if (only.has("leaks")) await leaks();
  if (only.has("guest") || only.has("removal")) browser = await launchBrowser();
  if (only.has("guest")) await guestWalk(browser);
  if (only.has("removal")) await removal(browser);
} catch (e) {
  fail(`${gate}: stopped`, e.message.split("\n")[0].slice(0, 300));
} finally {
  await browser?.close();
}
for (const g of only) report.gates[g] = { ...report.gates[g], failed: report.errors.filter((e) => e.gate === g).length };
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(report.errors.length ? `\n✗ ${report.errors.length} failed` : "\n✓ all passed");
process.exit(report.errors.length ? 1 : 0);

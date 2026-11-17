#!/usr/bin/env node
// The app by keyboard and screen reader, against a deployed demo: what axe can't see. Three gates:
//
//   walk      With no mouse at all: the inbox's j and k, an approval decided, a message sent and an agent asked in chat, a run
//             chip stopped and retried, a role changed on Team and the workspace renamed in Settings. Every control reached
//             by Tab shows a focus ring.
//   focus     Every dialog, opened from its button or menu by keyboard and closed with Escape, hands focus back to what
//             opened it. The palette and the "?" sheet are in shell-check.
//   announce  A run that changes state says so in a polite live region that was already on the page, so a screen reader
//             reads it out, and so does a new message from someone else.
//
// It needs no model key: runs wait for one, and Stop and Retry change them all the same.
//
//   node frontend/scripts/keyboard-check.mjs --backend <url> --frontend <url> [--out qa/keyboard] [--only walk,focus,announce]
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
const out = resolve(opt("out", "qa/keyboard"));
const only = new Set(opt("only", "walk,focus,announce").split(","));
if (!backend || !frontend) { console.error("usage: keyboard-check.mjs --backend <url> --frontend <url> [--out <dir>] [--only walk,focus,announce]"); process.exit(2); }
mkdirSync(out, { recursive: true });

const report = { backend, frontend, gates: {}, errors: [] };
let gate = "setup";
const fail = (what, detail) => { report.errors.push({ gate, what, detail }); console.log(`✗ ${what}: ${detail}`); };
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
const mcpUrl = execFileSync("node", ["--input-type=module", "-e", "import { mcpServer } from '@xano/sdk'; console.log(mcpServer({ name: 'qa', canonical: process.argv[1] }).getUrl(process.argv[2]))", "team-workspace-mcp", backend], { encoding: "utf8" }).trim();
async function mcpTool(token, name, args) {
  const rpc = async (session, body) => {
    const res = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25", authorization: `Bearer ${token}`, ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify(body) });
    return { text: await res.text(), session: res.headers.get("mcp-session-id") };
  };
  const init = await rpc(null, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "keyboard-check", version: "1" } } });
  await rpc(init.session, { jsonrpc: "2.0", method: "notifications/initialized" });
  const r = await rpc(init.session, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const line = r.text.split("\n").map((l) => l.replace(/^data:\s*/, "")).find((l) => l.trim().startsWith("{")) ?? "{}";
  try { return JSON.parse(JSON.parse(line).result?.content?.[0]?.text ?? "{}"); } catch { return {}; }
}

// ── The cast ───────────────────────────────────────────────────────────────────────────────────────
const stamp = Date.now() % 1_000_000;
const morgan = await signIn("member");
const avery = await signIn("admin");
const morganMe = await http("GET", pathOf("GET", "auth/me"), morgan);
// The announcement checks stop a run before it ends, which a model key makes too quick to catch.
if (only.has("announce") && (await http("GET", pathOf("GET", "agents/hosted"), morgan)).model_ready) {
  console.error("✗ this deploy holds a model key: the announcement checks need runs that stay queued. Deploy without one, or pass --only walk,focus.");
  process.exit(2);
}
const invite = async (name, role) => {
  const made = await http("POST", pathOf("POST", "auth/invites"), avery, { email: `${name.toLowerCase().replace(/\s/g, ".")}.${stamp}@keys.example`, name, role });
  const token = (await http("POST", pathOf("POST", "auth/link/accept"), null, { token: made.token, name, password: "Keys-pass-1" })).authToken;
  return { token, me: await http("GET", pathOf("GET", "auth/me"), token) };
};
const jordan = await invite(`Jordan K${stamp}`, "admin");
const casey = await invite(`Casey K${stamp}`, "member");
const conversations = await http("GET", pathOf("GET", "conversations"), morgan);
const launch = conversations.find((c) => c.name === "marlow-launch");
const relay = (await http("GET", pathOf("GET", "agents/connected"), morgan)).items.find((a) => a.name === "Relay");
const scout = (await http("GET", pathOf("GET", "agents/hosted"), morgan)).items.find((a) => a.name === "Scout");

const browser = await launchBrowser();
const consoleErrors = [];
async function open(token, path, { width = 1440, theme = "light" } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height: 900 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|status of 4\d\d/.test(m.text())) consoleErrors.push(m.text()); });
  await page.goto(`${frontend}/sign-in`, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => localStorage.setItem("app.token", t), token);
  await page.goto(`${frontend}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-kit="user-menu"]', { timeout: 15000 });
  await settle(page);
  return page;
}
const settle = (page, idleTime = 400) => page.waitForNetworkIdle({ idleTime, timeout: 10000 }).catch(() => {});
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });
const at = (page) => page.evaluate(() => location.pathname + location.search);
const blur = (page) => page.evaluate(() => { document.activeElement?.blur?.(); document.body.focus(); });
/** "g" then a pinned letter, as a person types it. */
const go = async (page, letter, path) => {
  await blur(page);
  await page.keyboard.press("g");
  await page.keyboard.press(letter);
  return page.waitForFunction((p) => location.pathname === p, { timeout: 8000 }, path).then(() => true, () => false);
};
/** Tab (or Shift+Tab) until focus lands on `selector`. Answers whether it got there, and whether the stop showed a focus ring. */
async function tabTo(page, selector, { back = false, most = 300 } = {}) {
  for (let i = 0; i < most; i++) {
    if (back) await page.keyboard.down("Shift");
    await page.keyboard.press("Tab");
    if (back) await page.keyboard.up("Shift");
    const hit = await page.evaluate((s) => {
      const el = document.activeElement;
      if (!el?.matches?.(s)) return null;
      const st = getComputedStyle(el);
      const ring = (st.outlineStyle !== "none" && parseFloat(st.outlineWidth) > 0) || (st.boxShadow && st.boxShadow !== "none");
      return { ring };
    }, selector);
    if (hit) return { reached: true, ring: hit.ring, presses: i + 1 };
  }
  return { reached: false, ring: false, presses: most };
}
const reach = async (page, selector, what, opts) => {
  const r = await tabTo(page, selector, opts);
  check(r.reached, `${what}: reached by ${opts?.back ? "Shift+" : ""}Tab`, r.reached ? `${r.presses} presses` : `not in ${r.presses} presses`);
  if (r.reached) check(r.ring, `${what}: shows a focus ring`);
  return r.reached;
};

// ── The walk ──────────────────────────────────────────────────────────────────────────────────────
async function walk() {
  gate = "walk";
  console.log("\n── keyboard walk");
  const page = await open(morgan, "/");

  // Inbox: j and k read down and back up.
  check(await go(page, "i", "/inbox"), "g i opens the inbox", await at(page));
  await settle(page);
  await blur(page);
  const lines = [];
  for (const key of ["j", "j", "k"]) { await page.keyboard.press(key); await sleep(300); lines.push(await at(page)); }
  check(lines[0] !== lines[1] && lines[2] === lines[0], "j and k move through the inbox", lines.join(" → "));
  check(!!(await page.$('[data-testid="inbox-detail"]')), "the selected line opens beside the list");

  // Approvals: Relay asks before posting where the guest reads, and Morgan, its sponsor, decides by keyboard.
  const relayKey = (await http("POST", pathOf("POST", "agents/{agent_id}/keys", { agent_id: relay.id }), morgan, { name: "Keyboard check", scope: "read_write", days: 1 })).token;
  const room = (await http("GET", pathOf("GET", "conversations"), avery)).find((c) => c.name === "marlow-oakline");
  const asked = await mcpTool(relayKey, "post_message", { conversation_id: room.id, body: `Staging is ready for a look. ${stamp}` });
  check(asked.approval?.status === "pending", "an approval is waiting for Morgan", JSON.stringify(asked).slice(0, 100));
  check(await go(page, "a", "/approvals"), "g a opens Approvals");
  await settle(page);
  await page.waitForFunction((w) => [...document.querySelectorAll('[data-testid="approval-card"]')].some((c) => c.textContent.includes(w)), { timeout: 8000 }, String(stamp)).catch(() => {});
  await page.evaluate((w) => [...document.querySelectorAll('[data-testid="approval-card"]')].find((c) => c.textContent.includes(w))?.querySelector('[data-testid="approval-approve"]')?.setAttribute("data-qa-approve", ""), String(stamp));
  if (await reach(page, "[data-qa-approve]", "Relay's Approve")) {
    await page.keyboard.press("Enter");
    let status = "pending";
    for (let i = 0; i < 20 && status === "pending"; i++) { await sleep(300); status = (await http("GET", pathOf("GET", "agent-approvals/{id}", { id: asked.approval.approval_id }), morgan)).status; }
    check(status === "approved", "Enter approves it", status);
  }
  await shot(page, "walk-approvals");

  // Chat: ⌘K to the channel, c to write, Enter to send, then ask Scout.
  await blur(page);
  await page.keyboard.down("Control"); await page.keyboard.press("k"); await page.keyboard.up("Control");
  await page.waitForSelector("[cmdk-input]", { timeout: 5000 }).catch(() => {});
  await page.keyboard.type("marlow-launch");
  await sleep(900);
  await page.keyboard.press("Enter");
  check(await page.waitForFunction((id) => location.pathname === `/chat/${id}`, { timeout: 8000 }, launch.id).then(() => true, () => false), "⌘K reaches a channel", await at(page));
  await settle(page);
  await blur(page);
  await page.keyboard.press("c");
  check(await page.evaluate(() => document.activeElement?.matches('[data-testid="composer-input"]')), "c puts focus in the composer");
  const words = `Sent with no mouse ${stamp}`;
  await page.keyboard.type(words);
  await page.keyboard.press("Enter");
  const sent = await page.waitForFunction((w) => [...document.querySelectorAll('[data-testid="message-list"]')].some((n) => n.innerText.includes(w)), { timeout: 8000 }, words).then(() => true, () => false);
  let stored = false;
  for (let i = 0; i < 20 && !stored; i++) { stored = (await http("GET", pathOf("GET", "conversations/{id}/messages", { id: launch.id }), morgan)).items.some((m) => m.body === words); if (!stored) await sleep(250); }
  check(sent && stored, "Enter sends it", stored ? "stored" : "not stored");
  await page.keyboard.type("@Sco");
  await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 5000 }).catch(() => {});
  await page.keyboard.press("Enter");
  await sleep(80);
  await page.keyboard.type(" what's left on checkout?");
  await page.keyboard.press("Enter");
  check(await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="run-chip"]')].some((c) => c.dataset.state === "queued"), { timeout: 8000 }).then(() => true, () => false), "asking Scout shows its run");

  // Run chips: Stop and Retry, reached by Shift+Tab back from the composer.
  if (await reach(page, '[data-testid="run-chip"][data-state="queued"] [data-testid="run-stop"]', "a run chip's Stop", { back: true })) {
    await page.keyboard.press("Enter");
    const stopped = await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="run-chip"]')].some((c) => c.dataset.reason === "canceled"), { timeout: 8000 }).then(() => true, () => false);
    check(stopped, "Enter stops the run");
    await page.focus('[data-testid="composer-input"]');
    if (await reach(page, '[data-testid="run-chip"][data-reason="canceled"] [data-testid="run-retry"]', "its Retry", { back: true })) {
      await page.keyboard.press("Enter");
      check(await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="run-chip"]')].some((c) => c.dataset.state === "queued"), { timeout: 8000 }).then(() => true, () => false), "Enter retries it");
    }
  }
  await shot(page, "walk-chat");
  // Leave nothing queued for later checks.
  for (const r of (await http("GET", pathOf("GET", "agent-runs") + `?conversation_id=${launch.id}`, morgan)).items.filter((x) => x.status === "queued" && x.agent_id === scout.id)) await raw("POST", pathOf("POST", "agent-runs/{id}/stop", { id: r.id }), morgan);
  await page.browserContext().close();

  // Team, as a real admin: Casey's role changes from the keyboard, then back.
  const admin = await open(jordan.token, "/");
  check(await go(admin, "m", "/team"), "g m opens Team");
  await settle(admin);
  const roleSelect = `select[aria-label="Role for ${casey.me.name}"]`;
  if (await reach(admin, roleSelect, "Casey's role")) {
    // A closed select takes a letter: g picks Guest.
    await admin.keyboard.type("g");
    await sleep(300);
    // It asks first: Tab from Cancel to the change, and Enter.
    const confirm = await admin.waitForSelector('dialog[open], [role="alertdialog"], [role="dialog"]', { timeout: 2500 }).catch(() => null);
    if (confirm) {
      await admin.evaluate(() => [...document.querySelectorAll('dialog[open] button, [role="alertdialog"] button, [role="dialog"] button')].find((b) => /^Make /.test(b.textContent.trim()))?.setAttribute("data-qa-confirm", ""));
      if (await reach(admin, "[data-qa-confirm]", "the role change's confirm")) await admin.keyboard.press("Enter");
    }
    let role = null;
    for (let i = 0; i < 20 && role !== "guest"; i++) {
      await sleep(300);
      const members = await http("GET", pathOf("GET", "rbac/members"), jordan.token);
      role = (Array.isArray(members) ? members : members.items ?? members.members ?? []).find((m) => (m.id ?? m.user_id) === casey.me.id)?.role;
    }
    check(role === "guest", "the keyboard changes Casey's role", role);
    if (role && role !== "member") await http("POST", pathOf("POST", "rbac/members/{id}/role", { id: casey.me.id }), jordan.token, { role: "member" }).catch((e) => fail("restore role", e.message));
  }
  await shot(admin, "walk-team");

  // Settings: rename the workspace and save, with Enter.
  check(await go(admin, "s", "/settings"), "g s opens Settings");
  await settle(admin);
  const before = await http("GET", pathOf("GET", "app/settings"), jordan.token);
  if (await reach(admin, '[data-testid="settings-workspace"] input[type="text"], [data-testid="settings-workspace"] input:not([type])', "the workspace name")) {
    await admin.keyboard.down("Meta"); await admin.keyboard.press("a"); await admin.keyboard.up("Meta");
    await admin.keyboard.down("Control"); await admin.keyboard.press("a"); await admin.keyboard.up("Control");
    await admin.keyboard.type(`Keyboard ${stamp}`);
    await admin.keyboard.press("Enter");
    await sleep(1200);
    const after = await http("GET", pathOf("GET", "app/settings"), jordan.token);
    check(after.name === `Keyboard ${stamp}`, "Enter saves the new name", after.name);
    await http("PATCH", pathOf("PATCH", "app/settings"), jordan.token, { name: before.name, timezone: before.timezone || "UTC", week_start: before.week_start || "monday" });
  }
  await shot(admin, "walk-settings");
  await admin.browserContext().close();
}

// ── Focus return ──────────────────────────────────────────────────────────────────────────────────
const DIALOG = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';
/**
 * Opens a dialog from the keyboard and closes it with Escape. `opener` is focused and pressed with Enter; with `item`, it opens
 * a menu and the item is chosen with the arrow keys. Focus must come back to the opener.
 */
async function returns(page, name, opener, { item, ready } = {}) {
  await settle(page);
  const target = await page.waitForSelector(opener, { timeout: 8000 }).catch(() => null);
  if (!target) { await shot(page, `focus-missing-${name.replace(/\W+/g, "-")}`); return fail(`focus return: ${name}`, `no ${opener} on ${await at(page)}`); }
  await page.evaluate((s) => { document.querySelectorAll("[data-qa-opener]").forEach((n) => n.removeAttribute("data-qa-opener")); document.querySelector(s).setAttribute("data-qa-opener", ""); }, opener);
  await target.focus();
  await page.keyboard.press("Enter");
  if (item) {
    await page.waitForSelector('[role="menu"]', { timeout: 3000 }).catch(() => {});
    for (let i = 0; i < 8; i++) {
      if (await page.evaluate((t) => document.activeElement?.getAttribute("role") === "menuitem" && document.activeElement.textContent.includes(t), item)) break;
      await page.keyboard.press("ArrowDown");
    }
    await page.keyboard.press("Enter");
  }
  const opened = await page.waitForSelector(ready ?? DIALOG, { timeout: 6000 }).then(() => true, () => false);
  if (!opened) return fail(`focus return: ${name}`, "the dialog didn't open from the keyboard");
  await sleep(250);
  const inside = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"], [role="alertdialog"]'));
  await page.keyboard.press("Escape");
  await page.waitForFunction((d) => !document.querySelector(d), { timeout: 4000 }, DIALOG).catch(() => {});
  await sleep(300);
  const back = await page.evaluate(() => {
    const el = document.activeElement;
    return { ok: !!el?.hasAttribute?.("data-qa-opener"), what: el === document.body ? "the page body" : `${el?.tagName.toLowerCase()} ${el?.getAttribute("aria-label") ?? el?.textContent?.trim().slice(0, 30)}` };
  });
  report.gates.focus.dialogs.push({ name, inside, back: back.ok });
  check(inside, `focus return: ${name} takes focus when it opens`);
  check(back.ok, `focus return: ${name} hands focus back to what opened it`, back.ok ? "" : `focus is on ${back.what}`);
}

async function focus() {
  gate = "focus";
  report.gates.focus = { dialogs: [] };
  console.log("\n── focus return");
  // What Morgan, a member, opens.
  const page = await open(morgan, `/chat/${launch.id}`);
  await returns(page, "inbox bell", 'header [data-kit="notification-bell"], header button[aria-label^="Inbox"]', { ready: '[data-kit="notifications-popover"], [role="dialog"]' });
  await returns(page, "space members", 'button[aria-label^="Members of"]');
  const mine = await send(morgan, launch.id, `To be deleted ${stamp}`);
  await page.waitForSelector(`[data-seq="${mine.message.seq}"]`, { timeout: 8000 }).catch(() => {});
  await page.hover(`[data-seq="${mine.message.seq}"]`).catch(() => {});
  await returns(page, "delete message", `[data-seq="${mine.message.seq}"] button[aria-label="Delete"]`);
  await returns(page, "new message", 'button[aria-label="New message"]');
  await page.goto(`${frontend}/tasks`, { waitUntil: "domcontentloaded" });
  await returns(page, "new task", '[data-testid="new-task-button"]');
  await page.goto(`${frontend}/tasks?status=todo`, { waitUntil: "domcontentloaded" });
  await returns(page, "save view", '[data-testid="save-view-button"]');
  const bare = await http("POST", pathOf("POST", "spaces"), morgan, { name: `Keys ${stamp}`, visibility: "private" });
  await page.goto(`${frontend}/tasks?space=${bare.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => [...document.querySelectorAll("main button")].some((b) => b.textContent.trim() === "New project"), { timeout: 10000 }).catch(() => {});
  await page.evaluate(() => [...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === "New project")?.setAttribute("data-qa-new-project", ""));
  await returns(page, "new project", "[data-qa-new-project]");
  await page.goto(`${frontend}/crm`, { waitUntil: "domcontentloaded" });
  await returns(page, "new deal", '[data-testid="new-deal-button"]');
  await page.goto(`${frontend}/crm/companies`, { waitUntil: "domcontentloaded" });
  await returns(page, "new company", '[data-testid="new-company-button"]');
  const company = (await http("GET", pathOf("GET", "companies"), morgan)).items.find((c) => c.name === "Marlow Cycles");
  await page.goto(`${frontend}/crm/companies/${company.id}`, { waitUntil: "domcontentloaded" });
  await returns(page, "add contact", '[data-testid="company-new-contact"]');
  await returns(page, "edit contact", '[data-testid="company-contact"]');
  await returns(page, "new deal for a company", '[data-testid="company-new-deal"]');
  await returns(page, "add a link", '[data-testid="add-link"]', { ready: '[role="dialog"]' });
  await returns(page, "edit company (from its menu)", '[data-testid="company-more-menu"]', { item: "Edit" });
  const deal = (await http("GET", pathOf("GET", "companies/{id}/panels", { id: company.id }), morgan).catch(() => null))?.deals?.[0]
    ?? { id: await page.$eval('[data-testid="company-deal"]', (a) => a.getAttribute("href").split("/").pop()) };
  await page.goto(`${frontend}/crm/deals/${deal.id}`, { waitUntil: "domcontentloaded" });
  await returns(page, "edit deal (from its menu)", '[data-testid="deal-more-menu"]', { item: "Edit" });
  await page.browserContext().close();

  // What a real admin opens.
  const admin = await open(jordan.token, "/crm");
  await returns(admin, "stages", '[data-testid="stages-button"]');
  await admin.goto(`${frontend}/team`, { waitUntil: "domcontentloaded" });
  await returns(admin, "invite", '[data-testid="invite-button"]');
  await returns(admin, "add agent", '[data-testid="add-agent-button"]');
  await returns(admin, "password reset link (from a member's menu)", `button[aria-label="More for ${casey.me.name}"]`, { item: "Password reset link" });
  await returns(admin, "remove from workspace (from a member's menu)", `button[aria-label="More for ${casey.me.name}"]`, { item: "Remove from workspace" });
  await http("POST", pathOf("POST", "auth/invites"), jordan.token, { email: `pending.${stamp}@keys.example`, name: "Pending Person", role: "member" });
  await admin.reload({ waitUntil: "domcontentloaded" });
  await returns(admin, "withdraw an invite", '[data-testid="pending-invites"] button');
  await admin.goto(`${frontend}/settings`, { waitUntil: "domcontentloaded" });
  await returns(admin, "clear demo data", '[data-testid="clear-demo"]');
  await returns(admin, "end demo mode", '[data-testid="end-demo"]');
  // The seeded agents are demo rows, which keep their sponsor: a real one has the sponsor control.
  const courier = await http("POST", pathOf("POST", "team-agents"), jordan.token, { name: `Courier ${stamp}`, mode: "connected", brief: "Carries notes.", sponsor_id: morganMe.id, space_ids: [launch.space_id] });
  await admin.goto(`${frontend}/team/agents/${courier.id ?? courier.agent?.id}`, { waitUntil: "domcontentloaded" });
  await returns(admin, "change sponsor", '[data-testid="sponsor-change"]');
  await returns(admin, "agent spaces", '[data-testid="spaces-edit"]');
  await returns(admin, "new key", '[data-testid="key-new"]');
  await admin.browserContext().close();
  const dialogs = report.gates.focus.dialogs;
  console.log(`  ${dialogs.filter((d) => d.back).length} of ${dialogs.length} dialogs hand focus back`);
}

// ── Announcements ────────────────────────────────────────────────────────────────────────────────
/** Watches a page for text that changes inside a polite or assertive live region which was there before the change. */
const listen = (page) => page.evaluate(() => {
  const liveOf = (node) => {
    for (let el = node.nodeType === 1 ? node : node.parentElement; el; el = el.parentElement) {
      const live = el.getAttribute("aria-live");
      if (live === "off") return null;
      if (live === "polite" || live === "assertive" || ["status", "log", "alert"].includes(el.getAttribute("role"))) return el;
    }
    return null;
  };
  // What each region said last: a screen reader speaks a region that was already there when its words change.
  const said = new WeakMap();
  const learn = () => document.querySelectorAll("[aria-live], [role=status], [role=log], [role=alert]").forEach((n) => { if (!said.has(n)) said.set(n, n.textContent.trim()); });
  learn();
  window.__qaHeard = [];
  new MutationObserver((records) => {
    for (const r of records) {
      const region = liveOf(r.target);
      if (!region || !said.has(region)) continue;
      const text = region.textContent.trim();
      if (text && text !== said.get(region)) window.__qaHeard.push(text);
      said.set(region, text);
    }
    learn();
  }).observe(document.body, { subtree: true, childList: true, characterData: true });
});
const heard = (page, pattern) => page.waitForFunction((p) => window.__qaHeard.some((t) => new RegExp(p, "i").test(t)), { timeout: 8000 }, pattern).then(() => true, () => false);

async function announce() {
  gate = "announce";
  console.log("\n── announcements");
  const page = await open(morgan, `/chat/${launch.id}`);
  await page.waitForFunction(() => document.documentElement.dataset.live === "live", { timeout: 12000 }).catch(() => {});
  await listen(page);
  // A run is asked for by someone else, and appears.
  const asked = await send(avery, launch.id, `<@${scout.id}> a quick list of what's open, please`);
  check(await heard(page, "New message from Avery"), "a message from someone else is announced");
  const run = await (async () => { for (let i = 0; i < 20; i++) { const r = (await http("GET", pathOf("GET", "agent-runs") + `?conversation_id=${launch.id}`, morgan)).items.find((x) => x.source_id === asked.message.id); if (r) return r; await sleep(300); } return null; })();
  check(!!run, "the mention made a run");
  if (!run) return;
  await page.waitForFunction((id) => !!document.querySelector('[data-testid="run-chip"]'), { timeout: 8000 }, run.id).catch(() => {});
  await sleep(600);
  await page.evaluate(() => { window.__qaHeard = []; });
  // Its state changes: Stop, by Avery from her own session, then Retry.
  await http("POST", pathOf("POST", "agent-runs/{id}/stop", { id: run.id }), avery);
  check(await heard(page, "Scout.*(Stopped|stopped)"), "a run that stops is announced", JSON.stringify(await page.evaluate(() => window.__qaHeard.slice(-2))));
  await page.evaluate(() => { window.__qaHeard = []; });
  await http("POST", pathOf("POST", "agent-runs/{id}/retry", { id: run.id }), avery);
  check(await heard(page, "Scout.*(Queued|Waiting|Starting|Needs a model key)"), "a run that goes again is announced", JSON.stringify(await page.evaluate(() => window.__qaHeard.slice(-2))));
  await raw("POST", pathOf("POST", "agent-runs/{id}/stop", { id: run.id }), avery);
  await shot(page, "announce-chat");
  // The agent's own page says its runs live too.
  const agentPage = await open(morgan, `/team/agents/${scout.id}`);
  await listen(agentPage);
  const third = await send(avery, launch.id, `<@${scout.id}> one more thing`);
  const r3 = await (async () => { for (let i = 0; i < 20; i++) { const r = (await http("GET", pathOf("GET", "agent-runs") + `?conversation_id=${launch.id}`, morgan)).items.find((x) => x.source_id === third.message.id); if (r) return r; await sleep(300); } return null; })();
  await sleep(1500);
  await agentPage.evaluate(() => { window.__qaHeard = []; });
  if (r3) await http("POST", pathOf("POST", "agent-runs/{id}/stop", { id: r3.id }), avery);
  check(await heard(agentPage, "Stopped|stopped|Scout"), "the agent's page announces a run that stops", JSON.stringify(await agentPage.evaluate(() => window.__qaHeard.slice(-2))));
  await page.browserContext().close();
  await agentPage.browserContext().close();
}

try {
  if (only.has("walk")) await walk();
  if (only.has("focus")) await focus();
  if (only.has("announce")) await announce();
} catch (e) {
  fail(`${gate}: stopped`, e.message.split("\n")[0].slice(0, 300));
} finally {
  await browser.close();
}
check(!consoleErrors.length, "no errors in the console", consoleErrors.slice(0, 3).join(" | "));
for (const g of only) report.gates[g] = { ...report.gates[g], failed: report.errors.filter((e) => e.gate === g).length };
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(report.errors.length ? `\n✗ ${report.errors.length} failed` : "\n✓ all passed");
process.exit(report.errors.length ? 1 : 0);

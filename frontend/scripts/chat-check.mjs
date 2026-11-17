#!/usr/bin/env node
// Chat in real windows, against a deployed backend: what a workflow test can't see. Concurrent senders, two people in two
// browsers, a lost frame, scrolling with no jump, a blocked send, typing, the phone layout, and the speed budgets at 4x CPU
// throttle. Screenshots land in --out, to be looked at. With --webkit <playwright-core dir> the scroll check also runs on
// WebKit, Safari's engine.
//
//   node frontend/scripts/chat-check.mjs --backend <url> --frontend <url> [--out qa/chat] [--webkit <dir>] [--concurrent-only]
//
// --concurrent-only stops after the concurrent senders.
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
const out = resolve(opt("out", "qa/chat"));
const webkitDir = opt("webkit");
if (!backend || !frontend) { console.error("usage: chat-check.mjs --backend <url> --frontend <url> [--out <dir>] [--webkit <dir>]"); process.exit(2); }
mkdirSync(out, { recursive: true });

const CPU_THROTTLE = 4;
const BUDGETS = { send: { p75: 50, p95: 100 }, keystroke: { p75: 16, p95: 50 }, secondWindow: { p75: 250, p95: 500 } };
const report = { backend, frontend, cpuThrottle: CPU_THROTTLE, timings: {}, scroll: {}, errors: [] };
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
const send = (token, id, body, key = crypto.randomUUID()) => http("POST", pathOf("POST", "conversations/{id}/messages", { id }), token, { client_msg_id: key, body });
const history = (token, id, q = "") => http("GET", pathOf("GET", "conversations/{id}/messages", { id }) + q, token);

const avery = await signIn("admin");
const morgan = await signIn("member");
const morganMe = await http("GET", pathOf("GET", "auth/me"), morgan);
const stamp = Date.now();
const makeSpace = async (name) => {
  const space = await http("POST", pathOf("POST", "spaces"), avery, { name, visibility: "private" });
  await http("POST", pathOf("POST", "spaces/{id}/members", { id: space.id }), avery, { user_id: morganMe.id });
  const list = await http("GET", pathOf("GET", "conversations"), avery);
  return { space, channel: list.find((c) => c.space_id === space.id) };
};

// ── Concurrent senders ────────────────────────────────────────────────────────────────────────────
{
  const { channel } = await makeSpace(`Race ${stamp}`);
  const N = 60;
  const results = await Promise.allSettled(Array.from({ length: N }, (_, i) => send(i % 2 ? avery : morgan, channel.id, `race ${i}`)));
  const landed = results.filter((r) => r.status === "fulfilled").length;
  check(landed === N, "concurrent senders all land", `${landed} of ${N}`);
  const seqs = (await history(avery, channel.id)).items.map((m) => m.seq);
  const older = (await history(avery, channel.id, `?before_seq=${seqs[0]}`)).items.map((m) => m.seq);
  const all = [...older, ...seqs];
  check(JSON.stringify(all) === JSON.stringify(Array.from({ length: N }, (_, i) => i + 1)), "concurrent senders leave no seq gap", `${all.length} messages, 1..${all.at(-1)}`);
  const key = crypto.randomUUID();
  const copies = await Promise.all(Array.from({ length: 10 }, () => send(avery, channel.id, "one send, many tries", key)));
  check(new Set(copies.map((c) => c.message.id)).size === 1 && copies.filter((c) => !c.repeat).length === 1, "ten racing retries make one message");
}
if (argv.includes("--concurrent-only")) {
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(report.errors.length ? `✗ ${report.errors.length} failed` : "✓ concurrent senders passed");
  process.exit(report.errors.length ? 1 : 0);
}

const browser = await launchBrowser();
async function open(index, { width = 1280, height = 800, theme = "light" } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height, hasTouch: width < 500, isMobile: width < 500, deviceScaleFactor: width < 500 ? 2 : 1 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
  page.on("pageerror", (e) => fail("page error", e.message.slice(0, 240)));
  // A way to lose frames on purpose, as a dropped socket message would.
  await page.evaluateOnNewDocument(() => {
    const Real = window.WebSocket;
    window.WebSocket = class extends Real {
      set onmessage(fn) { super.onmessage = (e) => { if (window.__dropFrames && /"type":"changed"/.test(String(e.data))) return; fn(e); }; }
      get onmessage() { return super.onmessage; }
    };
  });
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
const shows = (page, text, timeout = 4000) => page.waitForFunction((t) => [...document.querySelectorAll('[data-kit="message"]')].some((m) => m.textContent.includes(t)), { timeout }, text).then(() => true).catch(() => false);
const count = (page, text) => page.evaluate((t) => [...document.querySelectorAll('[data-kit="message"]')].filter((m) => m.textContent.includes(t)).length, text);
const type = async (page, text) => { await page.click('[data-testid="composer-input"]'); await page.keyboard.type(text); };
const typeAndSend = async (page, text) => { await type(page, text); await page.keyboard.press("Enter"); };

/** Scrolls up to the older page frame by frame, and reports how far any row on screen moved in the frame it arrived. */
const JUMP_PROBE = `(async () => {
  const list = document.querySelector('[data-testid="message-list"]');
  const seen = () => { const box = list.getBoundingClientRect(); const m = new Map(); for (const el of document.querySelectorAll('[data-kit="message"][data-seq]')) { const r = el.getBoundingClientRect(); if (r.bottom > box.top && r.top < box.bottom) m.set(el.dataset.seq, r.top); } return m; };
  const oldest = () => Math.min(...[...document.querySelectorAll('[data-kit="message"][data-seq]')].map((e) => Number(e.dataset.seq)));
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  list.scrollTop = 900;
  for (let i = 0; i < 6; i++) await frame();
  const start = list.scrollHeight;
  list.scrollTop = 200;
  await frame(); await frame();
  let before = seen(), worst = 0, frames = 0, grew = false;
  const giveUp = performance.now() + 6000;
  while (performance.now() < giveUp) {
    await frame();
    const now = seen();
    for (const [k, top] of now) if (before.has(k)) worst = Math.max(worst, Math.abs(top - before.get(k)));
    before = now;
    if (list.scrollHeight > start + 200) { grew = true; if (++frames > 20) break; }
  }
  return { grew, worst: Math.round(worst * 10) / 10 };
})()`;

try {
  const { space, channel } = await makeSpace(`Launch ${stamp}`);
  const room = `/chat/${channel.id}`;
  const a = await open(0);
  const b = await open(1);
  await go(a, room); await go(b, room);
  await a.waitForSelector('[data-testid="conversation-beginning"]', { timeout: 8000 }).catch(() => {});
  check(!!(await a.$('[data-testid="conversation-beginning"]')), "an empty channel says it's the start");

  // Two windows.
  await a.bringToFront();
  await typeAndSend(a, "hello from Avery");
  check(await shows(a, "hello from Avery", 1000), "a message shows in the sender's window");
  await b.bringToFront();
  check(await shows(b, "hello from Avery"), "the second window gets it with no reload");
  await typeAndSend(b, "and back from Morgan");
  await a.bringToFront();
  check(await shows(a, "and back from Morgan"), "the reply reaches the first window");
  check(await a.waitForFunction(() => document.querySelector('[data-testid="chat-announcer"]')?.textContent === "New message from Morgan Reyes", { timeout: 2000 }).then(() => true).catch(() => false), "a screen reader hears someone else's message");
  await sleep(600);
  check(await count(a, "hello from Avery") === 1 && await count(a, "and back from Morgan") === 1, "nothing shows twice after its hint and its answer both land");

  // Typing, on its own channel.
  await b.bringToFront();
  await b.click('[data-testid="composer-input"]');
  await b.keyboard.type("x");
  await a.bringToFront();
  const heard = await a.waitForFunction(() => /is typing/.test(document.querySelector('[data-testid="typing-line"]')?.textContent ?? ""), { timeout: 4000 }).then(() => true).catch(() => false);
  check(heard, "typing reaches the other window");
  const own = await b.evaluate(() => document.querySelector('[data-testid="typing-line"]')?.textContent ?? "");
  check(!own, "nobody sees themselves typing");
  await b.bringToFront();
  await b.keyboard.press("Backspace");
  await b.keyboard.type("done typing");
  await b.keyboard.press("Enter");
  await a.bringToFront();
  const cleared = await a.waitForFunction(() => !(document.querySelector('[data-testid="typing-line"]')?.textContent), { timeout: 7000 }).then(() => true).catch(() => false);
  check(cleared, "the name clears when they send");

  // Edits and deletes in the second window.
  const target = await send(avery, channel.id, "will change");
  await b.bringToFront();
  await shows(b, "will change");
  await http("PATCH", pathOf("PATCH", "messages/{id}", { id: target.message.id }), avery, { body: "has changed" });
  check(await shows(b, "has changed"), "an edit shows in the second window");
  check(await b.evaluate(() => [...document.querySelectorAll('[data-kit="message"]')].some((m) => m.textContent.includes("(edited)"))), "an edit says so");
  await http("DELETE", pathOf("DELETE", "messages/{id}", { id: target.message.id }), avery);
  const stone = await b.waitForSelector('[data-testid="message-tombstone"]', { timeout: 4000 }).then(() => true).catch(() => false);
  check(stone && await count(b, "has changed") === 0, "a delete shows a tombstone in the second window, and its text is gone");

  // A lost last frame is repaired on focus.
  await b.evaluate(() => { window.__dropFrames = true; });
  await send(avery, channel.id, "the frame for this was lost");
  await sleep(900);
  check(await count(b, "the frame for this was lost") === 0, "with its frame lost, a message hasn't arrived");
  await b.evaluate(() => { window.__dropFrames = false; window.dispatchEvent(new Event("focus")); });
  check(await shows(b, "the frame for this was lost"), "coming back to the window repairs it");

  // Offline, then Retry: one message.
  await a.bringToFront();
  await a.setOfflineMode(true);
  await typeAndSend(a, "sent with no connection");
  check(await shows(a, "sent with no connection", 1000), "a send with no connection still shows at once");
  const failed = await a.waitForSelector('[data-testid="message-failed"]', { timeout: 12000 }).then(() => true).catch(() => false);
  check(failed, "it ends failed, offering Retry, with the text kept");
  await a.screenshot({ path: join(out, "failed-send-desktop-light.png") });
  await a.setOfflineMode(false);
  await (await a.$('[data-testid="message-failed"] button')).click();
  await a.waitForFunction(() => !document.querySelector('[data-testid="message-failed"]'), { timeout: 6000 }).catch(() => {});
  await sleep(500);
  const afterRetry = (await history(avery, channel.id)).items.filter((m) => m.body === "sent with no connection").length;
  check(afterRetry === 1 && await count(a, "sent with no connection") === 1, "Retry makes exactly one message");

  // A reload keeps what's unsent.
  await a.setOfflineMode(true);
  await typeAndSend(a, "survives a reload");
  await sleep(150);
  await a.setOfflineMode(false);
  await a.reload({ waitUntil: "domcontentloaded" });
  check(await shows(a, "survives a reload", 8000), "a send in flight survives a reload");
  await sleep(800);
  check((await history(avery, channel.id)).items.filter((m) => m.body === "survives a reload").length === 1, "and lands once");

  // Unread, per person.
  const other = await http("POST", pathOf("POST", "spaces/{id}/channels", { id: space.id }), avery, { name: `side-${stamp}` });
  await b.bringToFront();
  await go(b, `/chat/${other.id}`);
  await send(avery, channel.id, `<@${morganMe.id}> are you there?`);
  const bold = await b.waitForFunction((href) => document.querySelector(`[data-nav="${href}"]`)?.dataset.unread === "true", { timeout: 4000 }, room).then(() => true).catch(() => false);
  check(bold, "another channel's message shows as unread in the sidebar");
  const badge = await b.waitForFunction((href) => document.querySelector(`[data-nav-badge="${href}"]`)?.textContent === "1", { timeout: 4000 }, room).then(() => true).catch(() => false);
  check(badge, "a mention shows as a count there");
  await go(b, room);
  const line = await b.waitForSelector('[data-testid="unread-line"]', { timeout: 4000 }).then(() => true).catch(() => false);
  check(line, "opening it shows the unread line");
  await b.screenshot({ path: join(out, "unread-desktop-light.png") });
  const read = await b.waitForFunction((href) => !document.querySelector(`[data-nav="${href}"]`)?.dataset.unread, { timeout: 6000 }, room).then(() => true).catch(() => false);
  check(read, "reading clears it");
  check(!!(await b.$('[data-testid="unread-line"]')), "the unread line stays for the visit");

  // Threads.
  await a.bringToFront();
  await shows(a, "are you there?");
  await a.evaluate(() => { const rows = [...document.querySelectorAll('[data-kit="message"]')]; rows.at(-1).click(); });
  await a.keyboard.press("Escape").catch(() => {});
  await a.evaluate(() => document.activeElement?.blur());
  await a.keyboard.press("k");
  await a.keyboard.press("r");
  const panel = await a.waitForSelector('[data-testid="thread-panel"]', { timeout: 5000 }).then(() => true).catch(() => false);
  check(panel, "r opens the selected message's thread, by keyboard");
  await a.waitForSelector('[data-testid="thread-panel"] [data-testid="composer-input"]', { timeout: 5000 }).catch(() => {});
  await a.click('[data-testid="thread-panel"] [data-testid="composer-input"]');
  await a.keyboard.type("a threaded reply");
  await a.keyboard.press("Enter");
  check(await shows(a, "a threaded reply"), "a reply shows in the thread");
  const counted = await a.waitForSelector('[data-testid="message-replies"]', { timeout: 5000 }).then(() => true).catch(() => false);
  check(counted, "the channel shows the reply count");
  await a.screenshot({ path: join(out, "thread-desktop-light.png") });
  await a.click('[data-testid="thread-close"]');

  // The mention warning, in the composer.
  const hiddenSpace = await http("POST", pathOf("POST", "spaces"), avery, { name: `Board ${stamp}`, visibility: "private" });
  const hidden = (await http("GET", pathOf("GET", "conversations"), avery)).find((c) => c.space_id === hiddenSpace.id);
  await a.click('[data-testid="conversation"] [data-testid="composer-input"]');
  await a.keyboard.type(`see #gen`);
  await a.waitForSelector('[role="listbox"] [role="option"]', { timeout: 4000 }).catch(() => {});
  const opts = await a.$$eval('[role="listbox"] [role="option"]', (o) => o.length);
  check(opts > 0, "# opens the channel menu");
  await a.keyboard.press("Escape");
  await a.evaluate(() => { const t = document.querySelector('[data-testid="conversation"] [data-testid="composer-input"]'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; set.call(t, ""); t.dispatchEvent(new Event("input", { bubbles: true })); });
  await a.type('[data-testid="conversation"] [data-testid="composer-input"]', `<#conversation:${hidden.id}>`);
  await a.keyboard.press("Enter");
  const warned = await a.waitForSelector('[data-kit="mention-warning"]', { timeout: 5000 }).then(() => true).catch(() => false);
  check(warned, "a mention someone can't open warns, and Enter doesn't send");
  await a.screenshot({ path: join(out, "mention-warning-desktop-light.png") });
  await (await a.$$('[data-kit="mention-warning"] button')).at(0).click();

  // Scrolling up, with no jump. One author throughout is the hard case: the row that was first loses its header when the
  // page before it arrives, so a row above the screen changes height just as new ones land.
  const { channel: long } = await makeSpace(`History ${stamp}`);
  for (let i = 0; i < 140; i += 10) await Promise.all(Array.from({ length: 10 }, (_, n) => send(avery, long.id, `line ${i + n}${n % 4 ? "" : " with a longer body that wraps onto a second line in a narrow window, so rows differ in height ".repeat(2)}`)));
  await http("POST", pathOf("POST", "conversations/{id}/read", { id: long.id }), avery, { seq: 999999 });
  await a.bringToFront();
  await go(a, `/chat/${long.id}`);
  await a.waitForSelector('[data-kit="message"]', { timeout: 6000 });
  await sleep(500);
  const atEnd = await a.evaluate(() => { const l = document.querySelector('[data-testid="message-list"]'); return l.scrollHeight - l.scrollTop - l.clientHeight; });
  check(atEnd < 90, "a conversation opens at its end", `${Math.round(atEnd)} px from it`);
  const chrome = await a.evaluate(JUMP_PROBE);
  report.scroll.chrome = chrome;
  check(chrome.grew && chrome.worst <= 1, "Chrome: older messages load with no jump", `largest move ${chrome.worst} px`);

  // A long unread stretch opens at where reading stopped, not at the end.
  const { channel: behind } = await makeSpace(`Behind ${stamp}`);
  await send(avery, behind.id, "the last thing Avery read");
  for (let i = 0; i < 40; i += 10) await Promise.all(Array.from({ length: 10 }, (_, n) => send(morgan, behind.id, `unread ${i + n}`)));
  await go(a, `/chat/${behind.id}`);
  const marker = await a.waitForSelector('[data-testid="unread-line"]', { timeout: 5000 }).catch(() => null);
  await sleep(400);
  const place = marker && await a.evaluate(() => { const l = document.querySelector('[data-testid="message-list"]').getBoundingClientRect(); const r = document.querySelector('[data-testid="unread-line"]').getBoundingClientRect(); return { inView: r.top >= l.top - 1 && r.bottom <= l.bottom + 1, fromTop: Math.round(r.top - l.top) }; });
  check(!!place?.inView, "a long unread stretch opens at the unread line", JSON.stringify(place));
  await a.screenshot({ path: join(out, "opens-at-unread-desktop-light.png") });

  // Budgets, at 4x throttle.
  await a.emulateCPUThrottling(CPU_THROTTLE); await b.emulateCPUThrottling(CPU_THROTTLE);
  await go(a, room);
  await a.waitForSelector('[data-testid="composer-input"]');
  await a.bringToFront();
  await a.click('[data-testid="composer-input"]');
  const sendSamples = [], keySamples = [];
  for (let i = 0; i < 20; i++) {
    const text = `budget ${i} ${stamp}`;
    await a.keyboard.type(text.slice(0, -1));
    await a.evaluate((t) => {
      window.__qa = new Promise((done) => {
        addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          const start = e.timeStamp;
          const look = () => {
            if ([...document.querySelectorAll('[data-kit="message"]')].some((m) => m.textContent.includes(t))) {
              requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => done(performance.now() - start); c.port2.postMessage(0); });
            } else requestAnimationFrame(look);
          };
          requestAnimationFrame(look);
        }, { capture: true, once: true });
      });
      window.__key = new Promise((done) => {
        addEventListener("keydown", (e) => {
          const start = e.timeStamp;
          requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => done(performance.now() - start); c.port2.postMessage(0); });
        }, { capture: true, once: true });
      });
    }, text);
    await a.keyboard.type(text.slice(-1));
    keySamples.push(await a.evaluate(() => window.__key));
    await a.evaluate((t) => {
      window.__qa = new Promise((done) => {
        addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          const start = e.timeStamp;
          const look = () => {
            if ([...document.querySelectorAll('[data-kit="message"]')].some((m) => m.textContent.includes(t))) {
              requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => done(performance.now() - start); c.port2.postMessage(0); });
            } else requestAnimationFrame(look);
          };
          requestAnimationFrame(look);
        }, { capture: true, once: true });
      });
    }, text);
    await a.keyboard.press("Enter");
    sendSamples.push(await Promise.race([a.evaluate(() => window.__qa), sleep(3000).then(() => null)]));
    await sleep(120);
  }
  judge("send", BUDGETS.send, sendSamples);
  judge("keystroke", BUDGETS.keystroke, keySamples);
  // What a key press costs in a bare textarea here, so a figure near one frame can be read: a paint can't beat the next frame.
  await a.evaluate(() => { const t = document.createElement("textarea"); t.id = "qa-bare"; t.style.cssText = "position:fixed;top:0;left:0;z-index:9999"; document.body.append(t); t.focus(); });
  const bare = [];
  for (let i = 0; i < 20; i++) {
    await a.evaluate(() => { window.__key = new Promise((done) => addEventListener("keydown", (e) => { const start = e.timeStamp; requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => done(performance.now() - start); c.port2.postMessage(0); }); }, { capture: true, once: true })); });
    await a.keyboard.type("x");
    bare.push(await a.evaluate(() => window.__key));
    await sleep(30);
  }
  await a.evaluate(() => document.getElementById("qa-bare").remove());
  const bareSorted = [...bare].sort((x, y) => x - y);
  report.timings.keystrokeBareTextarea = { samples: bare.length, p75: Math.round(percentile(bareSorted, 75)), p95: Math.round(percentile(bareSorted, 95)) };
  console.log(`  a bare textarea here: p75 ${report.timings.keystrokeBareTextarea.p75} ms, p95 ${report.timings.keystrokeBareTextarea.p95} ms`);

  await b.bringToFront();
  await go(b, room);
  const remote = [];
  for (let i = 0; i < 20; i++) {
    const text = `remote ${i} ${stamp}`;
    await b.evaluate((t) => {
      window.__seen = new Promise((done) => {
        const giveUp = Date.now() + 5000;
        const look = () => {
          if ([...document.querySelectorAll('[data-kit="message"]')].some((m) => m.textContent.includes(t))) {
            requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => done(Date.now()); c.port2.postMessage(0); });
          } else if (Date.now() > giveUp) done(null);
          else requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      });
    }, text);
    const sent = Date.now();
    await send(avery, channel.id, text);
    const seen = await b.evaluate(() => window.__seen);
    remote.push(seen === null ? null : seen - sent);
    await sleep(100);
  }
  judge("second window (local Engine)", BUDGETS.secondWindow, remote);
  await a.emulateCPUThrottling(1); await b.emulateCPUThrottling(1);

  // Send after removal: blocked, with the text kept.
  await b.bringToFront();
  await type(b, "written as I was removed");
  await http("POST", pathOf("POST", "spaces/{id}/members/{user_id}/remove", { id: space.id, user_id: morganMe.id }), avery, {});
  const removed = await b.waitForSelector('[data-testid="chat-removed"]', { timeout: 6000 }).then(() => true).catch(() => false);
  check(removed, "a person removed mid-sentence is told so");
  const kept = await b.evaluate(() => document.querySelector('[data-testid="held-text"]')?.textContent ?? "");
  check(kept.includes("written as I was removed"), "their unsent text stays, with Copy", kept.slice(0, 40));
  await b.screenshot({ path: join(out, "removed-desktop-light.png") });
  const gone = await http("POST", pathOf("POST", "conversations/{id}/messages", { id: channel.id }), morgan, { client_msg_id: crypto.randomUUID(), body: "too late" }).then(() => null, (e) => e.status);
  check(gone === 404, "and a send now answers not found");
  await a.browserContext().close(); await b.browserContext().close();

  // How it looks: every layout, both themes, with a real conversation in it.
  const { channel: shown } = await makeSpace(`Northwind ${stamp}`);
  const script = [[avery, "Pushed the pricing page to staging. Can someone take a look before standup?"], [avery, "Numbers come from the sheet Morgan shared."], [morgan, "On it. The annual toggle looks off on mobile, I'll send a fix."], [morgan, `<@${(await http("GET", pathOf("GET", "auth/me"), avery)).id} > thanks`.replace(" >", ">")], [avery, "Also https://example.com/pricing has the final copy."]];
  for (const [who, body] of script) await send(who, shown.id, body);
  // An agent posts through the same rule a person does, so its row is real.
  const people = await http("GET", pathOf("GET", "app/people"), avery);
  const scout = people.find((p) => p.name === "Scout");
  if (scout) {
    await http("POST", pathOf("POST", "spaces/{id}/members", { id: shown.space_id }), avery, { user_id: scout.id });
    const meta = JSON.parse(execFileSync("npx", ["xanosdk", "local", "token", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    const answer = await (await fetch(`${backend}/_engine/mcp`, { method: "POST", headers: { authorization: `Bearer ${meta.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "xano_run_function", arguments: { name: "messages/post", input: { actor_id: scout.id, browser: false, conversation_id: shown.id, client_msg_id: crypto.randomUUID(), body: "I checked the toggle on three phone sizes. It breaks below 400 px, and I've drafted the fix." } } } }) })).json();
    check(!answer.error && !answer.result?.isError, "an agent posts through the same function", JSON.stringify(answer.error ?? "").slice(0, 160));
  }
  for (const [name, size, theme] of [["desktop-light", [1280, 800], "light"], ["desktop-dark", [1280, 800], "dark"], ["phone-light", [390, 844], "light"], ["phone-dark", [390, 844], "dark"]]) {
    const page = await open(0, { width: size[0], height: size[1], theme });
    await go(page, `/chat/${shown.id}`);
    await page.waitForSelector('[data-kit="message"]', { timeout: 8000 });
    await sleep(300);
    await page.screenshot({ path: join(out, `conversation-${name}.png`) });
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(over <= 0, `${name}: nothing overflows`, `${over} px`);
    if (name.startsWith("phone")) {
      const small = await page.evaluate(() => [...document.querySelectorAll('[data-testid="conversation"] button, [data-testid="conversation"] a, [data-testid="conversation"] textarea')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.height && (r.width < 44 || r.height < 44) && !e.closest("p"); }).map((e) => e.getAttribute("aria-label") || e.textContent.slice(0, 20)));
      check(!small.length, `${name}: touch targets are 44 px`, small.join(", "));
      const barShows = () => page.evaluate(() => { const b = document.querySelector('[data-kit="bottom-nav"]'); return !!b && getComputedStyle(b).display !== "none"; });
      check(await barShows(), `${name}: a conversation keeps the bottom bar`);
      await page.focus('[data-testid="composer-input"]');
      check(!(await barShows()), `${name}: typing gives the bar's height to the keyboard`);
      await page.evaluate(() => document.activeElement?.blur());
      await page.tap?.('[data-kit="message"]').catch(() => {});
      await sleep(200);
      await page.screenshot({ path: join(out, `selected-${name}.png`) });
      await go(page, "/chat");
      await page.waitForSelector('[data-testid="chat-list"]', { timeout: 6000 }).catch(() => {});
      await page.screenshot({ path: join(out, `list-${name}.png`) });
      check(!!(await page.$('[data-testid="chat-list"]')), `${name}: /chat is the list`);
      check(!!(await page.$('[data-kit="bottom-nav"] a[href="/chat"]')), `${name}: the bottom bar has Chat`);
    } else {
      await page.evaluate(axeSource);
      const axe = await page.evaluate(() => window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }));
      const bad = axe.violations.map((v) => `${v.id} (${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(", ")})`);
      check(!bad.length, `${name}: axe`, bad.join("; "));
    }
    await page.browserContext().close();
  }

  // The same scroll on Safari's engine.
  if (webkitDir) {
    const { webkit } = createRequire(join(webkitDir, "x.js"))("playwright-core");
    const wk = await webkit.launch();
    const ctx = await wk.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(frontend);
    await page.locator('[data-testid="demo-login"]', { hasText: "Avery" }).click();
    await page.waitForFunction(() => document.documentElement.dataset.live === "live", null, { timeout: 15000 }).catch(() => {});
    await page.evaluate((p) => { history.pushState({}, "", p); dispatchEvent(new PopStateEvent("popstate")); }, `/chat/${long.id}`);
    await page.waitForSelector('[data-kit="message"]', { timeout: 10000 });
    await page.waitForTimeout(600);
    const safari = await page.evaluate(JUMP_PROBE);
    report.scroll.webkit = safari;
    check(safari.grew && safari.worst <= 1, "WebKit: older messages load with no jump", `largest move ${safari.worst} px`);
    await wk.close();
  }
} catch (e) {
  fail("run", e.stack?.split("\n").slice(0, 3).join(" ") ?? String(e));
} finally {
  await browser.close();
}
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(report.errors.length ? `✗ chat-check: ${report.errors.length} failed` : "✓ chat-check: passed");
process.exit(report.errors.length ? 1 : 0);

#!/usr/bin/env node
// Files in real windows, against a deployed backend, on whichever path that target takes: what a workflow test can't see. Real bytes in
// and out, progress, cancel, a dropped connection, drag and paste, every preview, an SVG that must not run, two people in two browsers,
// a refusal that stays out of the console, every designed state, and the phone. Screenshots land in --out, to be looked at.
//
//   node frontend/scripts/files-check.mjs --backend <url> --frontend <url> [--out qa/files]
//
// Exit 0 = pass, 1 = a check failed, 2 = usage.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchBrowser } from "./browser.mjs";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const backend = opt("backend")?.replace(/\/$/, "");
const frontend = opt("frontend")?.replace(/\/$/, "");
const out = resolve(opt("out", "qa/files"));
if (!backend || !frontend) { console.error("usage: files-check.mjs --backend <url> --frontend <url> [--out <dir>]"); process.exit(2); }
mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "files-check-"));
const saved = join(scratch, "saved");
mkdirSync(saved);

const BUDGET = { p75: 250, p95: 500 };
const report = { backend, frontend, errors: [], timings: {} };
const fail = (what, detail) => { report.errors.push({ check: what, detail }); console.log(`✗ ${what}: ${detail}`); };
let step = "start";
const check = (ok, what, detail = "") => (step = what, ok ? console.log(`✓ ${what}${detail ? `: ${detail}` : ""}`) : fail(what, detail || "no"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash("sha256").update(b).digest("hex");

const routes = JSON.parse(execFileSync("npx", ["xanosdk", "routes", "./xano/index.ts", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).routes;
const pathOf = (verb, name, params = {}) => Object.entries(params).reduce((p, [k, v]) => p.replace(`{${k}}`, v), routes.find((r) => r.verb === verb && r.ref.split("/").slice(1).join("/") === name).path);
const raw = (verb, path, token, body) => fetch(backend + path, { method: verb, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
const http = async (verb, path, token, body) => {
  const res = await raw(verb, path, token, body);
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
const upload = async (token, name, type, body, place) => {
  const form = new FormData();
  form.append("file", new File([body], name, { type }));
  form.append("client_id", `check-${stamp}-${++made}`);
  form.append("place_type", place.type);
  form.append("place_id", String(place.id));
  const res = await fetch(backend + pathOf("POST", "files"), { method: "POST", body: form, headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, ...(await res.json()) };
};
/** Bytes the way the app gets them: ask first, then the signed link or the authed route. */
const bytesOf = async (token, id) => {
  const link = await http("GET", pathOf("GET", "files/{id}/link", { id }), token);
  if (link.how === "refused") return { how: "refused" };
  const res = link.how === "signed" ? await fetch(link.url) : await raw("GET", pathOf("GET", "files/{id}/raw", { id }), token);
  return { how: link.how, status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
};

const browser = await launchBrowser();
const problems = [];
/** A connection cut on purpose logs its own line, and that's the browser's, not the app's. */
const expected = (text) => /ERR_INTERNET_DISCONNECTED|ERR_ABORTED/.test(text);
async function open(index, { width = 1440, height = 900, theme = "light", mobile = false } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
  page.on("pageerror", (e) => problems.push(`page error: ${e.message.slice(0, 200)}`));
  page.on("console", (m) => { if (m.type() === "error" && !expected(m.text())) problems.push(`[${step}] ${m.text().slice(0, 90)} ${m.location()?.url ?? ""}`); });
  page.on("response", (r) => { if (r.status() >= 500) problems.push(`${r.status()} from ${r.url()}`); });
  page.cdp = await page.createCDPSession();
  await (await browser.target().createCDPSession()).send("Browser.setDownloadBehavior", { behavior: "allow", browserContextId: context.id, downloadPath: saved, eventsEnabled: true });
  await page.goto(frontend, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="demo-login"]', { timeout: 30000 });
  // By name: sign-in lists Morgan first, and these indexes are the seed's order (Avery, Morgan, Riley).
  await page.evaluate((name) => [...document.querySelectorAll('[data-testid="demo-login"]')].find((b) => b.textContent?.includes(name))?.click(), ["Avery", "Morgan", "Riley"][index]);
  await page.waitForFunction(() => !document.querySelector('[data-testid="demo-login"]'), { timeout: 30000 });
  await page.waitForFunction(() => document.documentElement.dataset.live === "live", { timeout: 20000 }).catch(() => {});
  return page;
}
const go = async (page, path) => {
  await page.evaluate((p) => { history.pushState({}, "", p); dispatchEvent(new PopStateEvent("popstate")); }, path);
  await page.waitForNetworkIdle({ idleTime: 250, timeout: 8000 }).catch(() => {});
};
const see = (page, selector, timeout = 6000) => page.waitForSelector(selector, { timeout }).then(() => true).catch(() => false);
const seeText = (page, text, timeout = 6000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text).then(() => true).catch(() => false);
const press = async (page, ...keys) => { for (const k of keys) { await page.keyboard.press(k); await sleep(40); } };
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });
const axe = async (page, name) => {
  await page.evaluate(axeSource);
  const result = await page.evaluate(() => window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }));
  const bad = result.violations.map((v) => `${v.id} (${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(", ")})`);
  check(!bad.length, `${name}: axe`, bad.join("; "));
};
const phoneChecks = async (page, name) => {
  const { wide, small } = await page.evaluate(() => {
    const seen = [...document.querySelectorAll('main a, main button, main [role="combobox"], main input, main textarea')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden" && !e.closest("[hidden]"); });
    return { wide: document.documentElement.scrollWidth > innerWidth + 1, small: seen.filter((e) => { const r = e.getBoundingClientRect(); return (r.height < 43.5 && r.width < 43.5) || r.height < 30; }).map((e) => `${e.tagName}:${(e.getAttribute("aria-label") ?? e.textContent ?? "").slice(0, 24)}`) };
  });
  check(!wide, `${name}: nothing runs off a 390 px screen`);
  check(!small.length, `${name}: touch targets are 44 px`, small.join(", "));
};
const pick = async (page, path, within = "") => { const input = await page.$(`${within} [data-testid="file-input"]`); await input.uploadFile(path); };
const temp = (name, bytes) => { const path = join(scratch, name); writeFileSync(path, bytes); return path; };
const rowState = (page, name) => page.evaluate((n) => [...document.querySelectorAll('[data-testid="upload-row"]')].find((r) => r.textContent.includes(n))?.dataset.state ?? null, name);
const waitState = (page, name, state, timeout = 30000) => page.waitForFunction((n, s) => [...document.querySelectorAll('[data-testid="upload-row"]')].find((r) => r.textContent.includes(n))?.dataset.state === s, { timeout }, name, state).then(() => true).catch(() => false);
const inRow = (page, name, testId) => page.evaluate((n, t) => { [...document.querySelectorAll('[data-testid="upload-row"]')].find((r) => r.textContent.includes(n))?.querySelector(`[data-testid="${t}"]`)?.click(); }, name, testId);
const slow = (page, kbps) => page.cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: kbps * 1024 });
const fast = (page) => page.cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
const offline = (page) => page.cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
const waitSaved = async (name, timeout = 20000) => { const end = Date.now() + timeout; while (Date.now() < end) { const hit = readdirSync(saved).find((f) => f === name); if (hit && statSync(join(saved, hit)).size > 0) return join(saved, hit); await sleep(100); } return null; };

/** The row shows a name from the moment it starts, so whether a file is in is the server's to say. */
const lookFor = async (name, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const hit = (await http("GET", pathOf("GET", "files") + `?q=${encodeURIComponent(name)}`, morgan)).items[0];
    if (hit) return hit;
    await sleep(300);
  }
  return null;
};

try {
  const storage = await http("GET", pathOf("GET", "file-storage"), morgan);
  const signed = storage.mode === "signed";
  console.log(`  target: ${storage.mode}, limit ${storage.max_upload_bytes} bytes`);
  const spaces = (await http("GET", pathOf("GET", "spaces"), avery)).spaces;
  const relaunch = spaces.find((s) => s.name === "Marlow relaunch");
  const studio = spaces.find((s) => s.name === "Studio");
  const room = spaces.find((s) => s.name === "Marlow client room");
  const SEEDS = ["Marlow hero option B.png", "Marlow bike specs.csv", "Unmatched redirects.txt", "Marlow size guide.pdf", "Oakline logo pack.zip"];
  const seeded = (await http("GET", pathOf("GET", "files"), avery)).items.filter((f) => SEEDS.includes(f.name));
  const named = (part) => seeded.find((f) => f.name.includes(part));
  check(seeded.length === SEEDS.length, "the seeded world has real files", seeded.map((f) => f.name).join(", "));

  // ── Real bytes, on this target's own path ────────────────────────────────────────────────────────
  const noise = randomBytes(300_000);
  const stored = await upload(morgan, "board pack é.bin", "application/octet-stream", noise, { type: "space", id: relaunch.id });
  check(stored.ok, "a binary file goes in", stored.message);
  const back = await bytesOf(morgan, stored.file.id);
  check(back.how === storage.mode, "it comes back on this target's path", back.how);
  check(sha(back.bytes) === sha(noise), "every byte comes back", `${back.bytes.length} bytes`);
  for (const f of seeded) {
    const file = await bytesOf(avery, f.id);
    check(file.status === 200 && file.how === "table" && file.bytes.length === f.size, `seeded ${f.name} reads back from its table row`, `${file.how} ${file.bytes?.length}`);
  }
  const limit = storage.max_upload_bytes;
  const over = await upload(morgan, "too big.bin", "application/octet-stream", Buffer.alloc(limit + 1), { type: "space", id: relaunch.id });
  check(over.status === 200 && !over.ok && over.code === "too_big", "over the limit is refused by the server too, as a 200 with a reason", JSON.stringify({ s: over.status, c: over.code }));
  const edge = await upload(morgan, "at the limit.bin", "application/octet-stream", Buffer.alloc(limit, 7), { type: "space", id: relaunch.id });
  check(edge.ok, "a file exactly at the limit goes in", edge.message);
  const edgeBack = await bytesOf(morgan, edge.file.id);
  check(edgeBack.bytes?.length === limit, "and comes back whole");
  await http("DELETE", pathOf("DELETE", "files/{id}", { id: edge.file.id }), morgan);
  const blank = await upload(morgan, "blank.txt", "text/plain", Buffer.alloc(0), { type: "space", id: relaunch.id });
  check(!blank.ok && blank.code === "empty", "an empty file is refused", JSON.stringify({ s: blank.status, c: blank.code, m: blank.message }));
  const bad = await upload(morgan, "setup.exe", "application/octet-stream", Buffer.from("MZ"), { type: "space", id: relaunch.id });
  check(!bad.ok && bad.code === "wrong_type", "a program is refused", bad.code);
  const fromGuest = await upload(riley, "note.txt", "text/plain", Buffer.from("hi"), { type: "space", id: relaunch.id });
  check(fromGuest.status === 200 && !fromGuest.ok && fromGuest.code === "refused", "someone with no access is refused by name", fromGuest.message);

  // ── An SVG and an HTML file can't run in anyone's session ────────────────────────────────────────
  const mark = "document.title='ran';window.__ran=1";
  const svg = await upload(morgan, `evil ${stamp}.svg`, "image/svg+xml", Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>${mark}</script></svg>`), { type: "space", id: relaunch.id });
  const html = await upload(morgan, `evil ${stamp}.html`, "text/html", Buffer.from(`<html><script>${mark}</script></html>`), { type: "space", id: relaunch.id });
  const liar = await upload(morgan, `liar ${stamp}.png`, "text/html", Buffer.from(`<html><script>${mark}</script></html>`), { type: "space", id: relaunch.id });
  check(svg.file.kind === "other" && html.file.kind === "other" && liar.file.kind === "other", "HTML, SVG and a lying PNG are never a kind a page shows");
  for (const [label, f] of [["SVG", svg], ["HTML", html], ["lying PNG", liar]]) {
    const got = await bytesOf(morgan, f.file.id);
    if (got.how === "table") {
      check(got.headers.get("content-type").startsWith("application/octet-stream"), `${label} goes out as plain bytes`, got.headers.get("content-type"));
      check(/^attachment/.test(got.headers.get("content-disposition") ?? ""), `${label} is forced to download`);
      check(got.headers.get("x-content-type-options") === "nosniff" && /sandbox/.test(got.headers.get("content-security-policy") ?? ""), `${label} carries nosniff and a sandbox`);
    } else check(got.status === 200, `${label} reads through a signed link, which the app fetches and never opens`);
  }
  check((await raw("GET", pathOf("GET", "files/{id}/raw", { id: stored.file.id }))).status === 401, "the bytes route needs a signed-in person");
  const rileyLink = await raw("GET", pathOf("GET", "files/{id}/link", { id: stored.file.id }), riley);
  check(rileyLink.status === 200 && (await rileyLink.json()).how === "refused", "a refused person's link answers 200, so nothing lands in the console");

  // ── Reading, by keyboard ─────────────────────────────────────────────────────────────────────────
  const a = await open(0);
  const b = await open(1);
  await go(a, "/files"); await go(b, `/files?space=${relaunch.id}`);
  check(await see(a, '[data-testid="files-page"]'), "Files opens");
  check(await seeText(a, "Marlow hero option B.png"), "it lists the seeded files");
  await sleep(600);
  check(await a.evaluate(() => !!document.querySelector('[data-testid="file-thumb"] img')), "an image shows a thumbnail from its own bytes");
  check(await see(a, '[data-testid="file-tile"][data-kind="archive"]'), "a zip shows its type tile");
  await shot(a, "list-light");
  await axe(a, "file list");
  await go(a, "/files?kind=pdf");
  check(await seeText(a, "Marlow size guide.pdf") && !(await a.evaluate(() => document.body.innerText.includes("Marlow hero"))), "the type filter narrows the list");
  await go(a, "/files?date=week&q=size");
  check(await seeText(a, "Marlow size guide.pdf"), "date and name filters work together");
  await go(a, "/files?q=nothing-like-this");
  check(await see(a, '[data-testid="files-no-match"]'), "nothing matching says so, with a way out");
  await shot(a, "state-no-match");
  await a.click('[data-testid="files-clear"]');
  check(await seeText(a, "Marlow hero option B.png"), "clearing brings them back");
  await go(a, "/files?view=trash&space=" + studio.id);
  check(await see(a, '[data-testid="files-trash-empty"]'), "an empty trash says what it's for");
  await go(a, "/files?space=99999");
  check(await see(a, '[data-testid="files-no-access"]'), "a space out of reach is a state, and no error");
  await shot(a, "state-no-access");
  await go(a, "/files");
  await a.mouse.click(1300, 860);
  await press(a, "/");
  check(await a.evaluate(() => document.activeElement?.tagName === "INPUT"), "/ goes to search");
  await press(a, "Escape");
  await a.evaluate(() => document.activeElement?.blur());
  await press(a, "j", "j", "Enter");
  check(await see(a, '[data-testid="file-page"]', 4000), "j and Enter open a file");
  await press(a, "Escape");
  check(await see(a, '[data-testid="files-page"]', 4000), "Escape comes back to the list");

  // ── Every preview ────────────────────────────────────────────────────────────────────────────────
  await go(a, `/files/${named("hero").id}`);
  check(await a.waitForFunction(() => document.querySelector('[data-testid="preview-image"]')?.naturalWidth > 0, { timeout: 8000 }).then(() => true).catch(() => false), "an image previews");
  await shot(a, "preview-image-light");
  await axe(a, "file page");
  await go(a, `/files/${named("specs").id}`);
  check(await see(a, '[data-testid="preview-text"]') && await seeText(a, "Ridgeway Carbon"), "text previews");
  await shot(a, "preview-text-light");
  await go(a, `/files/${named("size guide").id}`);
  check(await see(a, '[data-testid="preview-pdf"], [data-testid="no-preview"]', 8000), "a PDF previews, or says this browser can't");
  await sleep(800);
  await shot(a, "preview-pdf-light");
  await go(a, `/files/${named("logo").id}`);
  check(await see(a, '[data-testid="no-preview"]') && await seeText(a, "Download it to open it"), "a zip has a tile and a way to get it");
  await shot(a, "no-preview");
  await go(a, `/files/${svg.file.id}`);
  check(await seeText(a, "can run code"), "an SVG says why it only downloads");
  await sleep(300);
  check(await a.evaluate(() => !window.__ran && document.title !== "ran"), "the SVG ran nothing here");
  await shot(a, "svg-download-only");
  await go(a, `/files/${html.file.id}`);
  check(await seeText(a, "can run code"), "HTML the same");
  check(await a.evaluate(() => !document.querySelector("iframe, embed, object") && !window.__ran), "and it reaches no frame");

  // ── Saving is a real file on disk ────────────────────────────────────────────────────────────────
  await a.click('[data-testid="file-save"]');
  const htmlSaved = await waitSaved(`evil ${stamp}.html`);
  check(!!htmlSaved && readFileSync(htmlSaved, "utf8").includes("<script>"), "HTML saves, whole, and nothing ran");
  await go(a, `/files/${named("logo").id}`);
  await a.mouse.click(700, 500);
  await press(a, "d");
  const zip = await waitSaved(named("logo").name);
  check(!!zip && sha(readFileSync(zip)) === sha((await bytesOf(avery, named("logo").id)).bytes), "d downloads, byte for byte");
  await go(a, `/files/${stored.file.id}`);
  await a.click('[data-testid="file-save"]');
  const binary = await waitSaved(stored.file.name);
  check(!!binary && sha(readFileSync(binary)) === sha(noise), `a file on the ${storage.mode} path saves through a blob, byte for byte`);

  // ── Uploading: progress, cancel, Retry, a dropped connection ─────────────────────────────────────
  await go(a, `/files?space=${relaunch.id}`);
  await see(a, '[data-testid="upload-button"]');
  const big = temp(`slow ${stamp}.bin`, randomBytes(Math.min(limit - 1024, 1_500_000)));
  await slow(a, 150);
  await pick(a, big);
  check(await waitState(a, `slow ${stamp}`, "uploading", 5000), "an upload shows as uploading");
  await sleep(1200);
  const percent = await a.evaluate(() => Number(document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")));
  check(percent > 0 && percent < 100, "it shows real progress", `${percent}%`);
  await shot(a, "uploading");
  await inRow(a, `slow ${stamp}`, "upload-cancel");
  check(await waitState(a, `slow ${stamp}`, "cancelled", 5000), "Cancel stops it, and says so");
  await shot(a, "cancelled");
  await offline(a);
  await inRow(a, `slow ${stamp}`, "upload-retry");
  check(await waitState(a, `slow ${stamp}`, "failed", 8000), "a dropped connection fails with its own words");
  check(await seeText(a, "connection dropped"), "and says what to do");
  await shot(a, "failed");
  await fast(a);
  await inRow(a, `slow ${stamp}`, "upload-retry");
  await a.waitForFunction((n) => ![...document.querySelectorAll('[data-testid="upload-row"]')].some((r) => r.textContent.includes(n)), { timeout: 60000 }, `slow ${stamp}`).catch(() => {});
  check(await seeText(a, `slow ${stamp}.bin`, 15000), "Retry finishes it, and the row becomes the file");
  const copies = (await http("GET", pathOf("GET", "files") + `?q=${encodeURIComponent(`slow ${stamp}`)}`, morgan)).items.length;
  check(copies === 1, "however it went, there's one of it", `${copies}`);
  const tooBig = temp(`huge ${stamp}.bin`, Buffer.alloc(limit + 1));
  await pick(a, tooBig);
  check(await waitState(a, `huge ${stamp}`, "too_big", 4000), "an oversize file stops before a byte moves");
  check(await seeText(a, "over the limit here"), "and names the limit");
  await shot(a, "oversize");
  await pick(a, temp(`run ${stamp}.exe`, Buffer.from("MZ")));
  check(await waitState(a, `run ${stamp}`, "wrong_type", 4000), "a program is refused here too");
  await shot(a, "wrong-type");
  await a.evaluate(() => [...document.querySelectorAll('[data-testid="upload-dismiss"]')].forEach((b2) => b2.click()));
  await sleep(100);

  // ── Drag and paste ───────────────────────────────────────────────────────────────────────────────
  await a.evaluate((n) => {
    const data = new DataTransfer();
    data.items.add(new File(["dropped"], n, { type: "text/plain" }));
    const area = document.querySelector('[data-testid="drop-area"]');
    for (const type of ["dragenter", "dragover"]) area.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
  }, `dropped ${stamp}.txt`);
  check(await see(a, '[data-testid="drop-hint"]', 2000), "a file over the screen says it'll land");
  await shot(a, "drop-hint");
  await a.evaluate((n) => {
    const data = new DataTransfer();
    data.items.add(new File(["dropped"], n, { type: "text/plain" }));
    document.querySelector('[data-testid="drop-area"]').dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  }, `dropped ${stamp}.txt`);
  check(!!(await lookFor(`dropped ${stamp}`)), "a drop uploads");
  const started = Date.now();
  const heard = await seeText(b, `dropped ${stamp}.txt`, 8000);
  check(heard, "it reaches a second window with no reload", `${Date.now() - started} ms after the first`);
  await a.evaluate((n) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([137, 80, 78, 71])], n, { type: "image/png" }));
    document.body.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  }, `pasted ${stamp}.png`);
  check(await seeText(a, `pasted ${stamp}.png`, 15000), "a paste uploads");
  const landed = await lookFor(`pasted ${stamp}`);
  check(!!landed, "the pasted file is really in");
  await http("DELETE", pathOf("DELETE", "files/{id}", { id: landed.id }), morgan);

  // ── Live delivery, sampled ───────────────────────────────────────────────────────────────────────
  const samples = [];
  for (let i = 0; i < 12; i++) {
    const name = `live ${stamp} ${i}.txt`;
    await b.evaluate(() => { window.__seen = null; });
    await b.evaluate((n) => { const watch = new MutationObserver(() => { if (document.body.innerText.includes(n)) { window.__seen = performance.now() + performance.timeOrigin; watch.disconnect(); } }); watch.observe(document.body, { subtree: true, childList: true, characterData: true }); }, name);
    const answered = await upload(morgan, name, "text/plain", Buffer.from("x"), { type: "space", id: relaunch.id });
    const end = Date.now();
    await b.waitForFunction(() => window.__seen, { timeout: 4000 }).catch(() => {});
    const seen = await b.evaluate(() => window.__seen);
    samples.push(seen && answered.ok ? Math.max(0, seen - end) : null);
  }
  const good = samples.filter((s) => s !== null).sort((x, y) => x - y);
  const p = (n) => Math.round(good[Math.ceil((n / 100) * good.length) - 1]);
  report.timings.secondWindow = { samples: samples.length, missed: samples.length - good.length, p75: p(75), p95: p(95), budget: BUDGET };
  check(good.length === samples.length && p(75) <= BUDGET.p75 && p(95) <= BUDGET.p95, "a new file reaches a second window in budget", `p75 ${p(75)} ms, p95 ${p(95)} ms over ${samples.length} samples after the upload's answer (${BUDGET.p75}/${BUDGET.p95})`);

  // ── A message waits for its files, or warns ──────────────────────────────────────────────────────
  const channels = await http("GET", pathOf("GET", "conversations"), morgan);
  const design = channels.find((c) => c.name === "design");
  await go(a, `/chat/${design.id}`); await go(b, `/chat/${design.id}`);
  check(await see(a, '[data-testid="message-image"]', 8000), "a seeded message shows its picture");
  await sleep(500);
  await shot(a, "message-image-light");
  await slow(a, 100);
  await pick(a, temp(`attached ${stamp}.bin`, randomBytes(400_000)));
  await a.type('[data-testid="composer-input"]', `Here it is ${stamp}`);
  await press(a, "Enter");
  check(await see(a, '[data-testid="composer-waiting"]', 3000), "a message sent mid-upload says it's waiting");
  await shot(a, "message-waiting");
  check(await a.evaluate((t) => !document.querySelector('[data-testid="message-list"]').innerText.includes(t), `Here it is ${stamp}`), "and it hasn't gone");
  await fast(a);
  check(await seeText(a, `Here it is ${stamp}`, 30000) && await see(a, '[data-testid="message-files"]', 5000), "it leaves when the file is in, with the file");
  check(await seeText(b, `attached ${stamp}.bin`, 8000), "the other window gets the message and the file");
  await offline(a);
  await pick(a, temp(`lost ${stamp}.txt`, Buffer.from("lost")));
  await waitState(a, `lost ${stamp}`, "failed", 8000);
  await fast(a);
  await a.type('[data-testid="composer-input"]', `No file ${stamp}`);
  await press(a, "Enter");
  check(await see(a, '[data-testid="composer-file-warning"]', 3000), "a message with a failed file warns, and holds");
  await shot(a, "message-warning");
  await a.click('[data-testid="composer-send-without"]');
  check(await seeText(a, `No file ${stamp}`, 8000), "leaving it out sends the words");
  await sleep(100);
  await pick(a, temp(`only ${stamp}.txt`, Buffer.from("alone")));
  await see(a, '[data-testid="composer-files"] [data-testid="file-card"]', 15000);
  await a.click('[data-testid="composer-input"]');
  await press(a, "Enter");
  check(await a.waitForFunction((n) => document.querySelector('[data-testid="message-list"]').innerText.includes(n), { timeout: 8000 }, `only ${stamp}.txt`).then(() => true).catch(() => false), "a file with no words sends");

  // ── On a task, a doc, a deal and a company ───────────────────────────────────────────────────────
  const tasks = await http("GET", pathOf("GET", "tasks") + `?q=${encodeURIComponent("Import final bike specs")}`, morgan);
  const task = (tasks.items ?? tasks)[0];
  await go(a, `/tasks/${task.id}`);
  check(await see(a, '[data-testid="attached-files"]') && await seeText(a, "Marlow bike specs.csv"), "a task shows the file on it");
  await pick(a, temp(`on task ${stamp}.txt`, Buffer.from("task")), '[data-testid="attachments"]');
  check(await seeText(a, `on task ${stamp}.txt`, 15000), "a file attaches to a task");
  await shot(a, "task-files");
  const companies = (await http("GET", pathOf("GET", "companies"), avery)).items;
  const marlow = companies.find((c) => c.name === "Marlow Cycles");
  await go(a, `/crm/companies/${marlow.id}`);
  check(await see(a, '[data-testid="panel-files"]') && await seeText(a, "Marlow size guide.pdf"), "the customer's Files panel is filled");
  const before = await a.evaluate(() => Number(document.querySelector('[data-testid="panel-files"] [data-testid="panel-count"]')?.textContent));
  await shot(a, "company-files");
  await pick(a, temp(`contract ${stamp}.txt`, Buffer.from("signed")), '[data-testid="panel-files"]');
  check(await seeText(a, `contract ${stamp}.txt`, 15000), "a file attaches to a company");
  check(await a.waitForFunction((n) => Number(document.querySelector('[data-testid="panel-files"] [data-testid="panel-count"]')?.textContent) > n, { timeout: 5000 }, before).then(() => true).catch(() => false), "and the panel counts it");

  // ── Settings says which mode applies ─────────────────────────────────────────────────────────────
  await go(a, "/settings");
  check(await see(a, `[data-testid="settings-storage"][data-mode="${storage.mode}"]`), "Settings shows the mode this target uses", storage.mode);
  await sleep(200);
  await a.evaluate(() => document.querySelector('[data-testid="settings-storage"]').scrollIntoView({ block: "center" }));
  await shot(a, "settings-storage");

  // ── A guest, and someone taken out ───────────────────────────────────────────────────────────────
  const c = await open(2);
  await go(c, "/files");
  check(await seeText(c, "Marlow size guide.pdf"), "a guest sees their room's files");
  check(await c.evaluate(() => !document.body.innerText.includes("Marlow hero")), "and nothing from a space they're not in");
  await shot(c, "guest-list");
  await go(c, `/files/${named("hero").id}`);
  check(await see(c, '[data-testid="file-no-access"]'), "a file out of reach is a state");
  await shot(c, "state-no-permission");
  const me = (await http("GET", pathOf("GET", "auth/me"), riley));
  await http("POST", pathOf("POST", "spaces/{id}/members", { id: relaunch.id }), morgan, { user_id: me.id, history_ok: true });
  await go(c, `/files/${named("specs").id}`);
  check(await see(c, '[data-testid="preview-text"]', 8000), "once added, it opens");
  const gone = await http("POST", pathOf("POST", "spaces/{id}/members/{user_id}/remove", { id: relaunch.id, user_id: me.id }), morgan, {});
  check(gone.removed && !gone.kick_failed, "a real removal takes the person off their channels");
  await sleep(300);
  await c.evaluate(() => document.querySelector('[data-testid="file-save"]')?.click());
  check(await seeText(c, "You don't have access to this file", 6000) || await see(c, '[data-testid="file-no-access"]', 6000), "the next download after removal is refused, in words");
  await shot(c, "removed-download-refused");

  // ── Trash ────────────────────────────────────────────────────────────────────────────────────────
  const trashed = (await upload(morgan, `bin ${stamp}.txt`, "text/plain", Buffer.from("bin"), { type: "space", id: relaunch.id })).file;
  await go(a, `/files/${trashed.id}`);
  await a.click('[data-testid="file-more"]');
  await see(a, '[data-testid="file-delete"]', 2000);
  await a.click('[data-testid="file-delete"]');
  check(await see(a, '[data-testid="file-trashed"]'), "a deleted file says it's in the trash");
  await shot(a, "trashed");
  await a.click('[data-testid="file-page-restore"]');
  check(await see(a, '[data-testid="preview-text"]', 6000), "and Restore brings it back");

  // ── An empty space, a failed load ────────────────────────────────────────────────────────────────
  const empty = await http("POST", pathOf("POST", "spaces"), morgan, { name: `Empty ${stamp}`, visibility: "private" }).catch((e) => { fail("a new space", e.message); return null; });
  if (empty) {
    await go(a, `/files?space=${empty.id ?? empty.space?.id}`);
    check(await see(a, '[data-testid="files-never"]', 8000), "a space with no files says what to do");
    await shot(a, "state-never-light");
  }
  await a.setRequestInterception(true);
  const stop = (req) => { if (req.url().includes(`/file-views`) || /\/files(\?|$)/.test(req.url())) req.abort(); else req.continue(); };
  a.on("request", stop);
  const seen = problems.length;
  await go(a, "/inbox");
  await a.evaluate(() => {});
  await go(a, `/files?space=${studio.id}&q=${stamp}`);
  check(await see(a, '[data-testid="files-failed"]', 15000), "a failed load says so, with Try again");
  await shot(a, "state-failed");
  a.off("request", stop);
  await a.setRequestInterception(false);
  problems.splice(seen);
  await go(a, "/files");

  // ── Dark, and the phone ──────────────────────────────────────────────────────────────────────────
  const dark = await open(1, { theme: "dark" });
  await go(dark, "/files"); await sleep(600); await shot(dark, "list-dark");
  await go(dark, `/files/${named("specs").id}`); await sleep(300); await shot(dark, "preview-text-dark");
  await axe(dark, "file page, dark");
  await go(dark, `/files/${named("logo").id}`); await sleep(200); await shot(dark, "no-preview-dark");
  const phone = await open(1, { width: 390, height: 844, mobile: true });
  await go(phone, "/files"); await sleep(600);
  await shot(phone, "phone-list-light");
  await phoneChecks(phone, "list");
  await go(phone, `/files?space=${relaunch.id}`);
  await pick(phone, temp(`huge2 ${stamp}.bin`, Buffer.alloc(limit + 1)));
  await waitState(phone, `huge2 ${stamp}`, "too_big", 4000);
  await sleep(150);
  await shot(phone, "phone-oversize");
  await phoneChecks(phone, "an upload row");
  await go(phone, `/files/${named("hero").id}`); await sleep(500);
  await shot(phone, "phone-preview");
  await phoneChecks(phone, "file page");
  const phoneDark = await open(1, { width: 390, height: 844, mobile: true, theme: "dark" });
  await go(phoneDark, "/files"); await sleep(600); await shot(phoneDark, "phone-list-dark");
  await go(phoneDark, `/files/${named("logo").id}`); await sleep(300); await shot(phoneDark, "phone-no-preview-dark");

  check(!problems.length, "no console errors, page errors or 500s anywhere", [...new Set(problems)].slice(0, 10).join(" | "));
} catch (e) {
  fail("the run stopped", `${e.message}\n${e.stack?.split("\n").slice(1, 4).join("\n")}`);
} finally {
  await browser.close().catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
}
if (report.errors.length) { console.log(`✗ files: ${report.errors.length} failed`); process.exit(1); }
console.log(`✓ files: every check passed: ${join(out, "report.json")}`);

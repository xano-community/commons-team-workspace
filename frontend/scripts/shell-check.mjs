#!/usr/bin/env node
// The signed-in shell in a real browser: what vitest can't see. Fails on an axe violation, a focus that doesn't come
// back, movement under reduced motion, a slow optimistic change at 4x CPU throttle, a 401 that loses the screen, or a
// phone layout that overflows or has a touch target under 44 px. Screenshots land beside the report, to be looked at.
//
//   npm run qa:shell -- --frontend <deploy .static.url> [--out qa/shell]
//
// Exit 0 = pass, 1 = a check failed, 2 = usage.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { launchBrowser } from "./browser.mjs";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const frontend = opt("frontend")?.replace(/\/$/, "");
const out = resolve(opt("out", "qa/shell"));
if (!frontend) { console.error("usage: shell-check.mjs --frontend <url> [--out <dir>]"); process.exit(2); }
mkdirSync(out, { recursive: true });

const CPU_THROTTLE = 4;
const OPTIMISTIC_BUDGET = { p75: 50, p95: 100 };
const OPTIMISTIC_SAMPLES = 20;
const report = { frontend, axe: [], optimistic: null, errors: [] };
const fail = (check, detail) => { report.errors.push({ check, detail }); console.log(`✗ ${check}: ${detail}`); };
const pass = (check, detail = "") => console.log(`✓ ${check}${detail ? `: ${detail}` : ""}`);
const settle = (page) => page.waitForNetworkIdle({ idleTime: 300, timeout: 8000 }).catch(() => {});
const percentile = (sorted, p) => sorted[Math.ceil((p / 100) * sorted.length) - 1];

const browser = await launchBrowser();

async function signedIn({ width, height, theme, reducedMotion = false }) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height, hasTouch: width < 500, isMobile: width < 500 });
  await page.emulateMediaFeatures([
    { name: "prefers-color-scheme", value: theme },
    { name: "prefers-reduced-motion", value: reducedMotion ? "reduce" : "no-preference" },
  ]);
  await page.goto(frontend, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="demo-login"]', { timeout: 15000 });
  // Avery, by name: sign-in lists Morgan first.
  await page.evaluate(() => [...document.querySelectorAll('[data-testid="demo-login"]')].find((b) => b.textContent?.includes("Avery"))?.click());
  await page.waitForSelector('[data-kit="scroll-pane"]', { timeout: 15000 });
  // A demo opens on the inbox, so the shell's checks start from the overview on purpose.
  await page.goto(frontend, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="overview"]', { timeout: 15000 });
  await settle(page);
  return page;
}

async function axe(page, name) {
  await page.evaluate(axeSource);
  const results = await page.evaluate(() => window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }));
  const violations = results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")) }));
  report.axe.push({ name, passes: results.passes.length, violations });
  if (violations.length) fail(`axe ${name}`, violations.map((v) => `${v.id} (${v.nodes.slice(0, 3).join(", ")})`).join("; "));
  else pass(`axe ${name}`, `${results.passes.length} rules`);
}

const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });
const paletteOpen = (page) => page.evaluate(() => !!document.querySelector("dialog[open]"));
const focusIs = (page, selector) => page.evaluate((s) => document.activeElement === document.querySelector(s), selector);
const pressMod = async (page, key) => { await page.keyboard.down("Control"); await page.keyboard.press(key); await page.keyboard.up("Control"); };

async function desktop(theme) {
  const page = await signedIn({ width: 1280, height: 800, theme });
  await shot(page, `overview-${theme}`);
  await axe(page, `shell ${theme}`);
  if (!(await page.$('[data-kit="demo-banner"]'))) fail("demo banner", "not shown on a local engine");

  // ⌘K: open, instant, and focus returns to where it was.
  await page.focus('[data-testid="ask-assistant"]');
  await pressMod(page, "k");
  if (!(await paletteOpen(page)) || !(await focusIs(page, "[cmdk-input]"))) fail("palette", "⌘K didn't open with the input focused");
  await shot(page, `palette-${theme}`);
  await axe(page, `palette ${theme}`);
  await page.keyboard.press("Escape");
  if (await paletteOpen(page)) fail("palette", "Escape didn't close it");
  if (!(await focusIs(page, '[data-testid="ask-assistant"]'))) fail("focus return", "focus didn't come back after the palette");
  else pass(`focus return ${theme}`, "palette");

  // The "?" sheet comes from the registry, and hands focus back too.
  await page.focus('[data-kit="palette-button"]');
  await page.keyboard.press("?");
  await page.waitForSelector('[data-kit="shortcuts"]', { timeout: 3000 });
  await new Promise((r) => setTimeout(r, 300));   // its fade: contrast is read at full opacity
  await shot(page, `shortcuts-${theme}`);
  await axe(page, `shortcuts ${theme}`);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[data-kit="shortcuts"]'), { timeout: 3000 });
  if (!(await focusIs(page, '[data-kit="palette-button"]'))) fail("focus return", "focus didn't come back after the shortcuts sheet");
  else pass(`focus return ${theme}`, "shortcuts");

  // g then a pinned letter.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("g");
  await page.keyboard.press("a");
  await page.waitForFunction(() => location.pathname === "/approvals", { timeout: 3000 }).catch(() => fail("nav keys", "g a didn't reach Approvals"));

  await session401(page, theme);
  await page.browserContext().close();
}

/** A 401 mid-session: the screen stays, the dialog opens, and signing back in carries on from the same place. */
async function session401(page, theme) {
  await page.evaluate(() => { history.pushState({}, "", "/activity"); dispatchEvent(new PopStateEvent("popstate")); });
  await page.waitForSelector('[data-testid="activity-page"]', { timeout: 8000 });
  await settle(page);
  await page.focus('[data-kit="palette-button"]');
  const before = await page.evaluate(() => document.querySelector("main").innerText);
  await page.setRequestInterception(true);
  const refuse = (r) => (r.url().includes("/app/") && r.method() === "GET" ? r.respond({ status: 401, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: '{"message":"Token expired"}' }) : r.continue());
  page.on("request", refuse);
  await page.evaluate(() => document.querySelector('[data-kit="notification-bell"]').click());
  const dialog = await page.waitForSelector('[data-kit="session-dialog"]', { timeout: 8000 }).catch(() => null);
  page.off("request", refuse);
  await page.setRequestInterception(false);
  if (!dialog) return fail("401", "the sign-in dialog never opened");
  if (new URL(page.url()).pathname !== "/activity") fail("401", `left the screen for ${page.url()}`);
  const after = await page.evaluate(() => document.querySelector("main").innerText);
  if (!after.includes(before.split("\n")[0])) fail("401", "the screen behind the dialog changed");
  await settle(page);
  await shot(page, `session-dialog-${theme}`);
  await axe(page, `session dialog ${theme}`);
  const resume = await page.waitForSelector('[data-testid="session-demo"]', { timeout: 5000 }).catch(() => null);
  if (!resume) return fail("401", "no way back in for a demo person");
  await resume.click();
  const closed = await page.waitForFunction(() => !document.querySelector('[data-kit="session-dialog"]'), { timeout: 8000 }).then(() => true, () => false);
  if (!closed) return fail("401", "signing in didn't close the dialog");
  if (new URL(page.url()).pathname !== "/activity") fail("401", "signing back in moved the screen");
  else pass(`401 ${theme}`, "screen kept, dialog answered, same place");
  const live = await page.waitForFunction(() => document.documentElement.dataset.live === "live", { timeout: 8000 }).then(() => true, () => false);
  if (!live) fail("401", "the socket didn't come back after signing in");
}

/** Under reduced motion a dialog fades, and nothing about it moves. */
async function reducedMotion() {
  const page = await signedIn({ width: 1280, height: 800, theme: "light", reducedMotion: true });
  await page.keyboard.press("?");
  const motion = await page.evaluate(() => new Promise((done) => {
    const seen = new Set();
    const started = performance.now();
    const frame = () => {
      const el = document.querySelector('[data-kit="shortcuts"]');
      if (el) {
        const s = getComputedStyle(el);
        const transform = s.transform === "matrix(1, 0, 0, 1, 0, 0)" ? "none" : s.transform;
        seen.add(`${s.scale}|${s.translate}|${transform}|${s.getPropertyValue("--tw-enter-scale")}`);
      }
      if (performance.now() - started > 400) done([...seen]);
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
  if (motion.length !== 1) fail("reduced motion", `a dialog moved through ${motion.length} states: ${motion.join(" / ")}`);
  else if (!motion[0].endsWith("|1")) fail("reduced motion", `the enter scale is ${motion[0]}`);
  else pass("reduced motion", "a dialog holds still while it fades");
  await page.browserContext().close();
}

/** Optimistic change at 4x throttle, with the write held 1.5 s so only the optimistic path can show it. */
async function optimistic() {
  const page = await signedIn({ width: 1280, height: 800, theme: "light" });
  const rows = Array.from({ length: OPTIMISTIC_SAMPLES + 1 }, (_, i) => ({ id: 9000 + i, title: `Notification ${i + 1}`, body: "", link: "", kind: "note", read_at: null, created_at: Date.now() - i * 60000 }));
  await page.setRequestInterception(true);
  let failNext = false;
  page.on("request", (r) => {
    const url = r.url();
    if (r.method() === "OPTIONS") return r.continue();
    if (url.includes("/app/notifications/unread")) return r.respond({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ count: rows.filter((n) => !n.read_at).length }) });
    if (/\/app\/notifications\/\d+\/read/.test(url)) {
      const refuse = failNext;
      failNext = false;
      const id = Number(url.match(/notifications\/(\d+)\/read/)[1]);
      return void setTimeout(() => {
        if (!refuse) rows.find((n) => n.id === id).read_at = Date.now();
        r.respond(refuse
        ? { status: 400, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: '{"message":"That notification is gone."}' }
        : { status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "{}" });
      }, 1500);
    }
    if (url.includes("/app/notifications")) return r.respond({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ items: rows, curPage: 1, pageTotal: 1, itemsTotal: rows.length, perPage: 50 }) });
    return r.continue();
  });
  await page.evaluate(() => { history.pushState({}, "", "/notifications"); dispatchEvent(new PopStateEvent("popstate")); });
  await page.waitForSelector('[data-kit="notification"][data-unread]', { timeout: 8000 });
  await settle(page);
  await page.emulateCPUThrottling(CPU_THROTTLE);
  const samples = [];
  for (let i = 0; i < OPTIMISTIC_SAMPLES; i++) {
    const sample = await page.evaluate(() => new Promise((done) => {
      const row = document.querySelector('[data-kit="notification"][data-unread]');
      const listener = (event) => {
        removeEventListener("click", listener, true);
        const start = event.timeStamp;
        const frame = () => {
          if (!row.hasAttribute("data-unread")) {
            const channel = new MessageChannel();
            channel.port1.onmessage = () => done(performance.now() - start);
            channel.port2.postMessage(0);
          } else if (performance.now() > start + 1400) done(null);
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      };
      addEventListener("click", listener, true);
      row.click();
    }));
    samples.push(sample);
    await new Promise((r) => setTimeout(r, 60));
  }
  const done = samples.filter((s) => s !== null).sort((a, b) => a - b);
  const p75 = Math.round(percentile(done, 75)), p95 = Math.round(percentile(done, 95));
  const marks = await page.evaluate(() => performance.getEntriesByName("optimistic", "measure").length);
  report.optimistic = { samples: samples.length, finished: done.length, p75, p95, budget: OPTIMISTIC_BUDGET, marks, cpuThrottle: CPU_THROTTLE };
  const figures = `p75 ${p75} ms, p95 ${p95} ms over ${done.length} of ${samples.length} samples (budget ${OPTIMISTIC_BUDGET.p75} / ${OPTIMISTIC_BUDGET.p95} ms)`;
  if (done.length < samples.length || p75 > OPTIMISTIC_BUDGET.p75 || p95 > OPTIMISTIC_BUDGET.p95) fail("optimistic", figures);
  else pass("optimistic", figures);
  if (!marks) fail("performance marks", "no optimistic measure on the timeline");

  // A refused write rolls back, and the toast says which.
  await page.emulateCPUThrottling(1);
  await new Promise((r) => setTimeout(r, 1700));
  failNext = true;
  await page.evaluate(() => document.querySelector('[data-kit="notification"][data-unread]').click());
  const named = await page.waitForFunction(() => document.body.innerText.includes("Couldn't mark that notification read. That notification is gone."), { timeout: 5000 }).then(() => true, () => false);
  const back = await page.evaluate(() => document.querySelectorAll('[data-kit="notification"][data-unread]').length);
  if (!named) fail("rollback", "no toast named the failed change");
  else if (back !== 1) fail("rollback", `${back} rows unread after the rollback, expected 1`);
  else pass("rollback", "put back, with a toast that names it");
  await shot(page, "rollback-toast");
  await page.browserContext().close();
}

async function phone(theme) {
  const page = await signedIn({ width: 390, height: 844, theme });
  await shot(page, `phone-${theme}`);
  await axe(page, `phone ${theme}`);
  const layout = await page.evaluate(() => {
    const pane = document.querySelector('[data-kit="scroll-pane"]');
    const small = [...document.querySelectorAll('header button, header a, [data-kit="bottom-nav"] a, [data-kit="bottom-nav"] button')]
      .filter((el) => el.offsetParent)
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width < 44 || r.height < 44)
      .map(({ el, r }) => `${el.getAttribute("aria-label") || el.textContent?.trim()} ${Math.round(r.width)}x${Math.round(r.height)}`);
    const tabs = [...document.querySelectorAll('[data-kit="bottom-nav"] > *')].map((t) => t.textContent.trim());
    return { overflow: pane.scrollWidth - pane.clientWidth, page: document.documentElement.scrollWidth - innerWidth, small, tabs };
  });
  if (layout.overflow > 0 || layout.page > 0) fail("phone overflow", JSON.stringify(layout));
  if (layout.small.length) fail("phone touch targets", layout.small.join(", "));
  else pass(`phone ${theme}`, `tabs: ${layout.tabs.join(", ")}`);
  if (layout.tabs.at(-1) !== "More") fail("phone bottom bar", `no More tab: ${layout.tabs.join(", ")}`);

  await (await page.$('[data-kit="bottom-nav-more"]')).click();
  const drawer = await page.waitForSelector('[data-mobile="true"]', { timeout: 3000 }).catch(() => null);
  if (!drawer) fail("phone drawer", "More didn't open the sidebar");
  else {
    await new Promise((r) => setTimeout(r, 350));
    await shot(page, `phone-drawer-${theme}`);
    await axe(page, `phone drawer ${theme}`);
    await page.keyboard.press("Escape");
  }
  await page.browserContext().close();
}

try {
  for (const theme of ["light", "dark"]) await desktop(theme);
  for (const theme of ["light", "dark"]) await phone(theme);
  await reducedMotion();
  await optimistic();
} catch (e) {
  fail("browser", e.message.split("\n")[0]);
} finally {
  await browser.close();
}
writeFileSync(join(out, "shell.json"), JSON.stringify(report, null, 2) + "\n");
console.log(report.errors.length ? `✗ shell-check: ${report.errors.length} error(s) — ${join(out, "shell.json")}` : `✓ shell-check: passed — ${join(out, "shell.json")}`);
process.exit(report.errors.length ? 1 : 0);

#!/usr/bin/env node
// Search and the overview in a real window, against a deployed backend: what a workflow test can't see. ⌘K from anywhere, entity
// results, recents, what it offers when nothing matches, the overview's order and its links, the phone layout, and ⌘K's budget
// at 4x CPU throttle. Screenshots land in --out, to be looked at.
//
//   node frontend/scripts/search-check.mjs --backend <url> --frontend <url> [--out qa/search]
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
const backend = opt("backend")?.replace(/\/$/, "");
const frontend = opt("frontend")?.replace(/\/$/, "");
const out = resolve(opt("out", "qa/search"));
if (!backend || !frontend) { console.error("usage: search-check.mjs --backend <url> --frontend <url> [--out <dir>]"); process.exit(2); }
mkdirSync(out, { recursive: true });

const CPU_THROTTLE = 4;
const BUDGET = { p75: 50, p95: 100 };
const errors = [];
const timings = {};
const check = (ok, what, detail = "") => { if (ok) console.log(`✓ ${what}${detail ? `: ${detail}` : ""}`); else { errors.push({ what, detail }); console.log(`✗ ${what}: ${detail || "no"}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const percentile = (sorted, p) => sorted[Math.ceil((p / 100) * sorted.length) - 1];

const browser = await launchBrowser();
async function open(index, { width = 1440, height = 900, theme = "light", mobile = false } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
  page.on("pageerror", (e) => check(false, "page error", e.message.slice(0, 200)));
  await page.goto(frontend, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="demo-login"]', { timeout: 20000 });
  // By name: sign-in lists Morgan first, and these indexes are the seed's order (Avery, Morgan, Riley).
  await page.evaluate((name) => [...document.querySelectorAll('[data-testid="demo-login"]')].find((b) => b.textContent?.includes(name))?.click(), ["Avery", "Morgan", "Riley"][index]);
  await page.waitForFunction(() => !document.querySelector('[data-testid="demo-login"]'), { timeout: 20000 });
  await page.waitForFunction(() => document.documentElement.dataset.live === "live", { timeout: 15000 });
  // A demo opens on the inbox, so search's checks start from the overview on purpose.
  await page.goto(frontend, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.dataset.live === "live", { timeout: 15000 });
  await page.waitForSelector('[data-testid="overview"]', { timeout: 10000 });
  return page;
}
const go = async (page, path) => {
  await page.evaluate((p) => { history.pushState({}, "", p); dispatchEvent(new PopStateEvent("popstate")); }, path);
  await page.waitForNetworkIdle({ idleTime: 250, timeout: 8000 }).catch(() => {});
};
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });
const palette = async (page) => { await page.keyboard.down("Meta"); await page.keyboard.press("k"); await page.keyboard.up("Meta"); await page.waitForSelector('[data-kit="command-input"]', { visible: true, timeout: 3000 }); };
const ask = async (page, q) => {
  await page.evaluate(() => { const i = document.querySelector('[data-kit="command-input"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ""); i.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.keyboard.type(q);
  await page.waitForFunction(() => !document.querySelector('[data-kit="command-palette"] [role="status"]'), { timeout: 5000 }).catch(() => {});
  await sleep(350);
  await page.waitForFunction(() => !document.querySelector('[data-kit="command-palette"] [role="status"]'), { timeout: 5000 }).catch(() => {});
};
const rows = (page) => page.$$eval('[data-kit="palette-row"]', (r) => r.map((e) => e.textContent.trim()));
const headings = (page) => page.$$eval('[data-kit="command-palette"] [cmdk-group-heading]', (r) => r.map((e) => e.textContent.trim()));
const axe = async (page, name) => {
  await page.evaluate(axeSource);
  const result = await page.evaluate(() => window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }));
  const bad = result.violations.map((v) => `${v.id} (${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(", ")})`);
  check(!bad.length, `${name}: axe`, bad.join("; "));
};

try {
  const a = await open(0);

  // The overview, in its order.
  const order = await a.evaluate(() => {
    const top = (sel) => document.querySelector(sel)?.getBoundingClientRect().top ?? -1;
    return { needs: top('[data-testid="needs-me"]'), agents: top('[data-kit="agent-work"]'), recent: top('[data-kit="activity-feed"]') };
  });
  check(order.needs >= 0 && order.needs < order.agents && order.agents < order.recent, "the overview reads what needs me, agent work, then recent activity", JSON.stringify(order));
  const links = await a.$$eval('[data-testid="needs-me"] a', (l) => l.map((e) => e.getAttribute("href")));
  // Avery: her tasks (none late), the week's finished work, the pipeline closing this month, and the agents' week.
  for (const href of ["/tasks?assignee=me", "/tasks?finished=1&status=done", "/crm?close=month", "/agents"]) check(links.includes(href), `a number links to ${href}`);
  check(await a.$$eval('[data-testid="needs-me"] [data-kit="stat-card"] svg[role="img"]', (l) => l.length) >= 2, "the week's numbers draw their trend");
  await a.click('[data-testid="needs-me"] a[href="/tasks?assignee=me"]');
  await a.waitForFunction(() => location.pathname === "/tasks", { timeout: 4000 });
  check((await a.evaluate(() => location.search)).includes("assignee=me"), "the tasks number opens that list");
  await go(a, "/");
  await a.waitForSelector('[data-testid="overview"]');
  await sleep(300);
  await shot(a, "overview-desktop-light");
  await axe(a, "overview");

  // ⌘K, from another screen.
  await go(a, "/tasks");
  await palette(a);
  check(await a.evaluate(() => document.activeElement?.getAttribute("data-kit") === "command-input"), "⌘K opens with its input focused, from any screen");
  check((await headings(a)).includes("Go to") || (await rows(a)).length > 3, "with nothing typed it holds the static commands");
  await ask(a, "marlow");
  const groups = await headings(a);
  check(["Chat", "Tasks", "Docs", "Customers"].every((g) => groups.includes(g)), "one search reaches the tools", groups.join(", "));
  const found = await rows(a);
  check(found.length <= 60, "it holds about 50 results at most", `${found.length} rows`);
  check(await a.evaluate(() => !!document.querySelector('[data-kit="palette-row"][data-selected="true"]')), "the first result is selected, ready for Enter");
  await shot(a, "palette-results-desktop-light");
  await axe(a, "palette");
  await ask(a, "size guide");
  check((await rows(a)).some((r) => /size guide/i.test(r)), "two words find a record holding both");
  await a.keyboard.press("ArrowDown");
  await a.keyboard.press("Enter");
  await sleep(600);
  check(await a.evaluate(() => !document.querySelector("dialog[open]")), "Enter opens the record and closes ⌘K");
  const landed = await a.evaluate(() => location.pathname);
  check(landed !== "/tasks" || (await a.evaluate(() => location.search)) !== "", "the result went somewhere", landed);

  await palette(a);
  await sleep(400);
  check((await headings(a)).includes("Recent"), "what was opened shows under Recent next time");
  await shot(a, "palette-recents-desktop-light");

  await ask(a, "qqqzzz");
  check(!!(await a.$('[data-testid="search-empty"]')), "no match says so");
  const offered = await rows(a);
  check(offered.some((r) => r.includes("as a task")), "and offers actions instead", offered.join(" / "));
  await shot(a, "palette-no-match-desktop-light");
  await a.keyboard.press("Enter");
  await a.waitForSelector('[data-testid="new-task-title"]', { timeout: 5000 });
  check((await a.$eval('[data-testid="new-task-title"]', (e) => e.value)) === "qqqzzz", "the action carries the words into a new task");
  await a.keyboard.press("Escape");

  // The nav says Customers, and so can the address.
  await go(a, "/customers");
  await a.waitForFunction(() => location.pathname === "/crm", { timeout: 4000 }).catch(() => {});
  check((await a.evaluate(() => location.pathname)) === "/crm", "/customers opens the Customers route");
  await go(a, "/customers/companies/1");
  await a.waitForFunction(() => location.pathname === "/crm/companies/1", { timeout: 4000 }).catch(() => {});
  check((await a.evaluate(() => location.pathname)) === "/crm/companies/1", "and keeps the rest of the address");

  // A guest finds nothing outside their spaces.
  const guest = await open(2);
  await palette(guest);
  await ask(guest, "Fenwick");
  check(!!(await guest.$('[data-testid="search-empty"]')), "a guest finds no customers");
  await shot(guest, "palette-guest-desktop-light");
  await guest.keyboard.press("Escape");
  await shot(guest, "overview-guest-desktop-light");
  await guest.close();

  // Dark, and the phone.
  for (const theme of ["dark", "light"]) {
    if (theme === "dark") {
      const d = await open(1, { theme });
      await sleep(400);
      await shot(d, "overview-desktop-dark");
      await palette(d);
      await ask(d, "checkout");
      await shot(d, "palette-results-desktop-dark");
      await d.close();
    }
    const phone = await open(1, { width: 390, height: 844, theme, mobile: true });
    await sleep(400);
    const wide = await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(wide <= 0, `phone ${theme}: nothing runs off a 390 px screen`, `${wide} px over`);
    await shot(phone, `overview-phone-${theme}`);
    await phone.evaluate(() => document.querySelector('[data-kit="palette-button"]')?.click());
    await phone.waitForSelector('[data-kit="command-input"]', { visible: true, timeout: 3000 });
    await ask(phone, "checkout");
    await shot(phone, `palette-phone-${theme}`);
    const fits = await phone.evaluate(() => { const r = document.querySelector("dialog[open]").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; });
    check(fits, `phone ${theme}: ⌘K fits the screen`);
    await phone.close();
  }

  // ⌘K's budget, at 4x throttle, with the rows it now holds.
  await go(a, "/");
  await a.emulateCPUThrottling(CPU_THROTTLE);
  const opens = [];
  for (let i = 0; i < 20; i++) {
    await a.keyboard.down("Meta"); await a.keyboard.press("k"); await a.keyboard.up("Meta");
    await sleep(120);
    await a.keyboard.press("Escape");
    await sleep(220);
    opens.push(...(await a.evaluate(() => performance.getEntriesByName("palette-open", "measure").map((m) => m.duration))).slice(-1));
  }
  const sorted = [...opens].sort((x, y) => x - y);
  timings.palette = { samples: sorted.length, p75: Math.round(percentile(sorted, 75)), p95: Math.round(percentile(sorted, 95)), budget: BUDGET };
  check(timings.palette.p75 <= BUDGET.p75 && timings.palette.p95 <= BUDGET.p95, "⌘K budget", `p75 ${timings.palette.p75} ms, p95 ${timings.palette.p95} ms over ${sorted.length} samples (${BUDGET.p75}/${BUDGET.p95})`);
} catch (e) {
  check(false, "search-check stopped", e.message.slice(0, 300));
}
await browser.close();
writeFileSync(join(out, "report.json"), JSON.stringify({ backend, frontend, cpuThrottle: CPU_THROTTLE, timings, errors }, null, 2));
console.log(errors.length ? `✗ search-check: ${errors.length} failed` : "✓ search-check: every check passed");
process.exit(errors.length ? 1 : 0);

#!/usr/bin/env node
// The move from demo to real use (R34, KTD5), against a deployed demo: what's left once a real admin clears the demo, and
// which doors stay shut once they end demo mode. It changes the deploy for good, so run it last, on one you can throw away.
//
//   emptied  A real admin clears the demo data. Every count goes to zero and a second clear changes nothing. Search and every
//            list hold nothing of the demo company, real work in a demo space stays reachable, and every screen, in light and
//            dark at desktop and 390 px, shows a designed state with no errors and nothing of the demo.
//   doors    The same admin ends demo mode. Demo sign-in, the demo people list and open sign-up are refused, a demo session
//            from before stops working, the sign-in page offers no demo button, and the admin still signs in.
//
//   node frontend/scripts/real-use-check.mjs --backend <url> --frontend <url> [--out qa/real-use]
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
const out = resolve(opt("out", "qa/real-use"));
if (!backend || !frontend) { console.error("usage: real-use-check.mjs --backend <url> --frontend <url> [--out <dir>]"); process.exit(2); }
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
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
};
const http = async (verb, path, token, body) => {
  const r = await raw(verb, path, token, body);
  if (r.status >= 400) throw new Error(`${verb} ${path}: ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
};
const items = (r) => (Array.isArray(r) ? r : r?.items ?? []);

// Words only the demo company's rows carry, from xano/world.ts. Not "Marlow relaunch": a demo space that holds real work stays,
// with its name (KTD5).
const DEMO_WORDS = ["Marlow Cycles", "Fenwick", "Brightwater", "Northgate", "Tallis", "redirect list", "bike specs", "size guide", "launch brief"];
const stamp = Date.now() % 1_000_000;

const status0 = await http("GET", pathOf("GET", "auth/status"));
if (!status0.demo_mode) { console.error("✗ demo mode is already off here: this check needs a fresh demo deploy."); process.exit(1); }
const avery = (await http("POST", pathOf("POST", "auth/demo"), null, { persona: "admin" })).authToken;
const morgan = (await http("POST", pathOf("POST", "auth/demo"), null, { persona: "member" })).authToken;
const email = `dana.${stamp}@real.example`, password = "Real-pass-1";
const made = await http("POST", pathOf("POST", "auth/invites"), avery, { email, name: "Dana Real", role: "admin" });
const dana = (await http("POST", pathOf("POST", "auth/link/accept"), null, { token: made.token, name: "Dana Real", password })).authToken;

// Real work, some of it in a demo space: it must outlive the clear.
const setup = await http("GET", pathOf("GET", "task-setup"), dana);
const demoProject = setup.projects.find((p) => p.name === "Website relaunch");
const realTask = await http("POST", pathOf("POST", "tasks"), dana, { project_id: demoProject.id, client_id: crypto.randomUUID(), title: `Real follow-up ${stamp}`, status: "todo", priority: "medium" });
const realSpace = await http("POST", pathOf("POST", "spaces"), dana, { name: `Real team ${stamp}`, visibility: "private" });
const realDoc = await http("POST", pathOf("POST", "doc-create"), dana, { space_id: realSpace.id, title: `Real plan ${stamp}`, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Ours." }] }] } });

const browser = await launchBrowser();
const errors = [];
async function open(token, path, width = 1440, theme = "light") {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|status of 4\d\d/.test(m.text())) errors.push(m.text()); });
  await page.setViewport({ width, height: width < 500 ? 844 : 900, hasTouch: width < 500, isMobile: width < 500, deviceScaleFactor: width < 500 ? 2 : 1 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
  await page.goto(`${frontend}/sign-in`, { waitUntil: "domcontentloaded" });
  if (token) await page.evaluate((t) => localStorage.setItem("app.token", t), token);
  await page.goto(`${frontend}${path}`, { waitUntil: "domcontentloaded" });
  return page;
}

async function emptied() {
  gate = "emptied";
  console.log("\n── emptied workspace");
  const refused = await raw("POST", pathOf("POST", "members/clear-demo"), avery);
  check(refused.status === 403, "a demo admin can't clear the demo", String(refused.status));
  const notEnded = await raw("POST", pathOf("POST", "members/end-demo"), avery, { confirmed_ids: [] });
  check(notEnded.status === 403, "nor end demo mode", String(notEnded.status));
  const before = await http("GET", pathOf("GET", "members/clear-demo"), dana);
  check(before.tasks > 0 && before.customers > 0 && before.people > 0, "there's demo data to clear", JSON.stringify(before));
  const cleared = await http("POST", pathOf("POST", "members/clear-demo"), dana);
  const after = await http("GET", pathOf("GET", "members/clear-demo"), dana);
  const left = Object.entries(after).filter(([k, v]) => typeof v === "number" && v > 0);
  check(!left.length && cleared.removed > 0, "every count is zero afterwards", left.length ? left.map(([k, v]) => `${k} ${v}`).join(", ") : `${cleared.removed} rows removed`);
  const again = await http("POST", pathOf("POST", "members/clear-demo"), dana);
  check(!Object.entries(again).some(([k, v]) => typeof v === "number" && v > 0 && k !== "removed") && !again.removed, "clearing again changes nothing", JSON.stringify(again));

  const lists = [["tasks", pathOf("GET", "tasks")], ["docs", pathOf("GET", "doc-list")], ["files", pathOf("GET", "files")], ["companies", pathOf("GET", "companies")],
    ["conversations", pathOf("GET", "conversations")], ["pipeline", pathOf("GET", "pipeline")], ["overview", pathOf("GET", "overview")], ["notifications", pathOf("GET", "app/notifications")]];
  for (const [name, path] of lists) {
    const text = (await raw("GET", path, dana)).text;
    const hit = DEMO_WORDS.find((w) => text.includes(w));
    check(!hit, `${name} hold nothing of the demo`, hit ? `still says ${hit}` : "");
  }
  for (const w of ["Marlow", "Fenwick", "checkout", "size guide"]) {
    const found = items(await http("GET", `${pathOf("GET", "search")}?q=${encodeURIComponent(w)}`, dana));
    check(!found.length, `search finds nothing for "${w}"`, found.slice(0, 2).map((f) => f.title).join(", "));
  }
  const still = await raw("GET", pathOf("GET", "tasks/{id}", { id: realTask.id }), dana);
  check(still.status === 200 && still.text.includes(`Real follow-up ${stamp}`), "real work in a demo space stays reachable");
  check((await raw("GET", pathOf("GET", "docs/{id}", { id: realDoc.id ?? realDoc.doc?.id }), dana)).status === 200, "a real space and its doc stay");
  const people = items(await http("GET", pathOf("GET", "app/people"), dana));
  check(people.some((p) => p.name === "Dana Real"), "the real admin is still here");

  const screens = ["/", "/inbox", "/chat", "/tasks", "/docs", "/crm", "/crm/companies", "/files", "/team", "/approvals", "/agents", "/activity", "/settings"];
  let walked = 0;
  for (const [width, theme] of [[1440, "light"], [1440, "dark"], [390, "light"], [390, "dark"]]) {
    const page = await open(dana, "/", width, theme);
    await page.waitForSelector('[data-kit="user-menu"], [data-kit="user-menu-compact"]', { timeout: 15000 }).catch(() => fail("emptied", "the admin's session didn't open"));
    for (const path of screens) {
      errors.length = 0;
      await page.goto(`${frontend}${path}`, { waitUntil: "domcontentloaded" });
      await page.waitForNetworkIdle({ idleTime: 400, timeout: 10000 }).catch(() => {});
      await sleep(250);
      const seen = await page.evaluate(() => ({ main: document.querySelector("main")?.innerText.trim() ?? "", body: document.body.innerText, overflow: document.documentElement.scrollWidth - innerWidth, skeletons: document.querySelectorAll('main [data-slot="skeleton"]').length }));
      const hit = DEMO_WORDS.find((w) => seen.body.includes(w));
      const name = `${path} at ${width} px ${theme}`;
      walked += 1;
      if (!seen.main) fail(name, "blank");
      else if (/something went wrong/i.test(seen.body)) fail(name, "crashed");
      else if (seen.skeletons) fail(name, "still loading after the network went quiet");
      else if (hit) fail(name, `still shows ${hit}`);
      else if (seen.overflow > 0) fail(name, `scrolls sideways by ${seen.overflow} px`);
      else if (errors.length) fail(name, `console: ${errors[0].slice(0, 160)}`);
      if (width === 1440 && theme === "light") await page.screenshot({ path: join(out, `emptied${path.replace(/\//g, "-") || "-overview"}.png`) });
    }
    await page.browserContext().close();
  }
  report.gates.emptied = { screens: walked };
  check(report.errors.filter((e) => e.gate === "emptied").length === 0, `every screen shows a designed state, ${walked} screens in two themes and two widths`);
}

async function doors() {
  gate = "doors";
  console.log("\n── demo doors");
  // A demo session already open in a browser, from before.
  const before = await open(morgan, "/inbox");
  await before.waitForSelector('[data-kit="user-menu"]', { timeout: 15000 }).catch(() => {});
  const keep = await http("GET", pathOf("GET", "members/end-demo"), dana);
  await http("POST", pathOf("POST", "members/end-demo"), dana, { confirmed_ids: (keep.accounts ?? []).map((a) => a.id) });
  const status = await http("GET", pathOf("GET", "auth/status"));
  check(!status.demo_mode && !status.signup_open, "demo mode and open sign-up are off", JSON.stringify(status));
  check(items(await http("GET", pathOf("GET", "auth/demo/personas"))).length === 0, "nobody is offered as a demo person");
  for (const persona of ["admin", "member", "guest"]) {
    const r = await raw("POST", pathOf("POST", "auth/demo"), null, { persona });
    check(r.status >= 400 && !r.json?.authToken, `demo sign-in as ${persona} is refused`, String(r.status));
  }
  const signup = await raw("POST", pathOf("POST", "auth/signup"), null, { name: "Stranger", email: `stranger.${stamp}@real.example`, password: "Stranger-pass-1" });
  check(signup.status >= 400 && !signup.json?.authToken, "open sign-up is refused", String(signup.status));
  for (const [who, token] of [["Morgan's", morgan], ["Avery's", avery]]) {
    const r = await raw("GET", pathOf("GET", "auth/me"), token);
    check(r.status === 401 || r.status === 403, `${who} demo session from before stops working`, String(r.status));
  }
  await before.reload({ waitUntil: "domcontentloaded" });
  const out1 = await before.waitForFunction(() => location.pathname.startsWith("/sign-in") || !!document.querySelector('[data-kit="session-dialog"]'), { timeout: 15000 }).then(() => true, () => false);
  check(out1, "the open demo window is signed out", await before.evaluate(() => location.pathname));
  await before.browserContext().close();
  const page = await open(null, "/sign-in");
  await page.waitForSelector("form", { timeout: 15000 }).catch(() => {});
  await sleep(800);
  check(!(await page.$('[data-testid="demo-login"]')), "the sign-in page offers no demo sign-in");
  await page.screenshot({ path: join(out, "doors-sign-in.png") });
  await page.browserContext().close();
  const login = await raw("POST", pathOf("POST", "auth/login"), null, { email, password });
  check(login.status === 200 && !!login.json?.authToken, "the real admin still signs in", String(login.status));
}

try {
  await emptied();
  await doors();
} catch (e) {
  fail(`${gate}: stopped`, e.message.split("\n")[0].slice(0, 300));
} finally {
  await browser.close();
}
for (const g of ["emptied", "doors"]) report.gates[g] = { ...report.gates[g], failed: report.errors.filter((e) => e.gate === g).length };
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(report.errors.length ? `\n✗ ${report.errors.length} failed` : "\n✓ all passed");
process.exit(report.errors.length ? 1 : 0);

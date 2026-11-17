#!/usr/bin/env node
// The agent speed budgets (R27), measured the way a person feels them: a real Enter in the real composer at 4x CPU throttle,
// timed from the key's own timestamp to the first paint that shows the result. Each figure is judged at p75 and p95, with its
// sample count, in --out/report.json.
//
//   agent-state  Mention Scout and send: the run's chip on screen, in any live state. p75 100 ms, p95 200 ms. Needs no key.
//   run-start    Mention a hosted agent and send: its chip says Working. p75 1 s, p95 2 s. Needs a deploy with a model key, and
//                ends demo mode on it, because the demo cap allows 20 runs a day: run it last, on a deploy you can throw away.
//                Each run is stopped as soon as it starts, so the model is barely spent.
//
//
//   node frontend/scripts/speed-check.mjs --backend <url> --frontend <url> [--out qa/speed] [--only agent-state,run-start]
//
// Exit 0 = pass, 1 = a budget or a check failed, 2 = usage or a browser that can't measure.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchBrowser } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const backend = opt("backend")?.replace(/\/$/, "");
const frontend = opt("frontend")?.replace(/\/$/, "");
const out = resolve(opt("out", "qa/speed"));
const only = new Set(opt("only", "agent-state").split(","));
if (!backend || !frontend) { console.error("usage: speed-check.mjs --backend <url> --frontend <url> [--out <dir>] [--only agent-state,run-start]"); process.exit(2); }
mkdirSync(out, { recursive: true });

const CPU_THROTTLE = 4;
const BUDGETS = { "agent-state": { p75: 100, p95: 200 }, "run-start": { p75: 1000, p95: 2000 } };
const SAMPLES = { "agent-state": 12, "run-start": 10 };
const report = { backend, frontend, cpuThrottle: CPU_THROTTLE, timings: {}, errors: [] };
const fail = (what, detail) => { report.errors.push({ what, detail }); console.log(`✗ ${what}: ${detail}`); };
const check = (good, what, detail = "") => (good ? console.log(`✓ ${what}${detail ? `: ${detail}` : ""}`) : fail(what, detail || "no"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const percentile = (sorted, p) => sorted[Math.ceil((p / 100) * sorted.length) - 1];
function judge(name, samples) {
  const budget = BUDGETS[name];
  const done = samples.filter((s) => s !== null).sort((a, b) => a - b);
  const p75 = done.length ? Math.round(percentile(done, 75)) : null, p95 = done.length ? Math.round(percentile(done, 95)) : null;
  report.timings[name] = { samples: samples.length, finished: done.length, p75, p95, budget, all: samples.map((s) => (s === null ? null : Math.round(s))) };
  const figures = `p75 ${p75} ms, p95 ${p95} ms over ${done.length} of ${samples.length} samples (budget ${budget.p75} / ${budget.p95} ms)`;
  check(done.length === samples.length && p75 <= budget.p75 && p95 <= budget.p95, `${name} budget`, figures);
}

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
const stamp = Date.now() % 1_000_000;

const browser = await launchBrowser();
async function open(token, path) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${frontend}/sign-in`, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => localStorage.setItem("app.token", t), token);
  await page.goto(`${frontend}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 15000 });
  await page.waitForFunction(() => document.documentElement.dataset.live === "live", { timeout: 12000 }).catch(() => {});
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(() => {});
  return page;
}

/**
 * Types a mention of `agent` and the words, then arms the clock: from the Enter that sends it to the paint where a run chip
 * newer than any before it is on screen in one of `states`.
 */
async function sample(page, agent, words, states, giveUp) {
  await page.click('[data-testid="composer-input"]');
  await page.keyboard.type(`@${agent.slice(0, 4)}`);
  await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 5000 });
  await page.keyboard.press("Enter");
  await sleep(60);
  await page.keyboard.type(` ${words}`);
  await page.evaluate(({ states, giveUp }) => {
    const seen = new Set([...document.querySelectorAll('[data-testid="run-chip"]')]);
    window.__qaRun = new Promise((done) => {
      addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        const start = e.timeStamp;
        const look = () => {
          const fresh = [...document.querySelectorAll('[data-testid="run-chip"]')].some((c) => !seen.has(c) && states.includes(c.dataset.state));
          if (fresh) requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => done(performance.now() - start); ch.port2.postMessage(0); });
          else if (performance.now() - start > giveUp) done(null);
          else requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      }, { capture: true, once: true });
    });
  }, { states, giveUp });
  await page.keyboard.press("Enter");
  return page.evaluate(() => window.__qaRun);
}
const runsOn = async (token, conversation) => (await http("GET", pathOf("GET", "agent-runs") + `?conversation_id=${conversation}`, token)).items;
const stopAll = async (token, conversation, agentId) => {
  for (const r of await runsOn(token, conversation)) if (r.agent_id === agentId && ["queued", "working", "waiting"].includes(r.status)) await raw("POST", pathOf("POST", "agent-runs/{id}/stop", { id: r.id }), token);
};

/** Visible agent state: no key needed, so a fresh demo will do. */
async function agentState() {
  const morgan = (await http("POST", pathOf("POST", "auth/demo"), null, { persona: "member" })).authToken;
  // #design, in the same space as Scout: its samples leave a trail of stopped runs, which stays out of #marlow-launch.
  const launch = (await http("GET", pathOf("GET", "conversations"), morgan)).find((c) => c.name === "design");
  const scout = (await http("GET", pathOf("GET", "agents/hosted"), morgan)).items.find((a) => a.name === "Scout");
  const page = await open(morgan, `/chat/${launch.id}`);
  await page.emulateCPUThrottling(CPU_THROTTLE);
  const samples = [];
  for (let i = 0; i < SAMPLES["agent-state"]; i++) {
    samples.push(await sample(page, "Scout", `speed ${stamp} ${i}: what's open?`, ["queued", "working", "waiting"], 5000));
    await sleep(400);
    await stopAll(morgan, launch.id, scout.id);
    await page.waitForNetworkIdle({ idleTime: 400, timeout: 8000 }).catch(() => {});
  }
  judge("agent-state", samples);
  await page.browserContext().close();
}

/** Run start: a keyed deploy with demo mode off. A real admin adds a hosted agent and a space for it, then asks. */
async function runStart() {
  const avery = (await http("POST", pathOf("POST", "auth/demo"), null, { persona: "admin" })).authToken;
  const hosted = await http("GET", pathOf("GET", "agents/hosted"), avery);
  if (!hosted.model_ready) return fail("run-start", "this deploy holds no model key: run start needs one");
  const made = await http("POST", pathOf("POST", "auth/invites"), avery, { email: `speed.${stamp}@speed.example`, name: `Sam Speed ${stamp}`, role: "admin" });
  const sam = (await http("POST", pathOf("POST", "auth/link/accept"), null, { token: made.token, name: `Sam Speed ${stamp}`, password: "Speed-pass-1" })).authToken;
  const samMe = await http("GET", pathOf("GET", "auth/me"), sam);
  const status = await http("GET", pathOf("GET", "auth/status"));
  if (status.demo_mode) {
    const keep = await http("GET", pathOf("GET", "members/end-demo"), sam);
    const ids = (keep.items ?? keep.accounts ?? keep ?? []).map?.((a) => a.id) ?? [];
    await http("POST", pathOf("POST", "members/end-demo"), sam, { confirmed_ids: ids });
  }
  check(!(await http("GET", pathOf("GET", "auth/status"))).demo_mode, "demo mode is off, so the demo's daily cap doesn't apply");
  const space = await http("POST", pathOf("POST", "spaces"), sam, { name: `Speed ${stamp}`, visibility: "private" });
  const channel = (await http("GET", pathOf("GET", "conversations"), sam)).find((c) => c.space_id === space.id);
  const name = `Sprint${stamp}`;
  const agent = await http("POST", pathOf("POST", "team-agents"), sam, { name, mode: "hosted", brief: "Answer in one short line, then report done.", sponsor_id: samMe.id, space_ids: [space.id] });
  const page = await open(sam, `/chat/${channel.id}`);
  await page.emulateCPUThrottling(CPU_THROTTLE);
  const samples = [];
  for (let i = 0; i < SAMPLES["run-start"]; i++) {
    samples.push(await sample(page, name, `say ok ${i}`, ["working"], 15000));
    await stopAll(sam, channel.id, agent.id);
    // The next mention must not land while this run still holds the agent's one slot on the record.
    for (let t = 0; t < 40; t++) { if (!(await runsOn(sam, channel.id)).some((r) => r.agent_id === agent.id && ["queued", "working", "waiting"].includes(r.status))) break; await sleep(250); }
    await page.waitForNetworkIdle({ idleTime: 400, timeout: 8000 }).catch(() => {});
  }
  judge("run-start", samples);
  await page.browserContext().close();
}

try {
  if (only.has("agent-state")) await agentState();
  if (only.has("run-start")) await runStart();
} catch (e) {
  fail("stopped", e.message.split("\n")[0].slice(0, 300));
} finally {
  await browser.close();
}
const power = (() => { try { return execFileSync("pmset", ["-g", "batt"], { encoding: "utf8" }).match(/'([^']+)'/)?.[1] ?? "unknown"; } catch { return "unknown"; } })();
report.power = power;
console.log(`  measured on ${power}`);
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(report.errors.length ? `\n✗ ${report.errors.length} failed` : "\n✓ all passed");
process.exit(report.errors.length ? 1 : 0);

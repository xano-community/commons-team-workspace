#!/usr/bin/env node
// Proves what a workflow test can't, against a deployed Xano Engine: concurrent writers, and real sockets.
//   1. Writers on a space's channel (tasks) and on the crm channel race while a reader follows `changes?after=`. Every
//      entry must reach the reader once, in order, even one that committed late.
//   2. Two tabs of one person: an item arriving moves the second tab's count, and so does reading it in the first.
// Usage: node frontend/scripts/change-path-check.mjs <backend url>    (npm run qa:changes -- <backend url>)
import { execFileSync } from "node:child_process";

const backend = process.argv[2]?.replace(/\/$/, "");
if (!backend) { console.error("usage: change-path-check.mjs <backend url>"); process.exit(2); }
const WRITERS = 40;
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "✓" : "✗"} ${what}`); if (!ok) failed += 1; };

const routes = JSON.parse(execFileSync("npx", ["xanosdk", "routes", "./xano/index.ts", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).routes;
const pathOf = (verb, name) => routes.find((r) => r.verb === verb && r.ref.endsWith(`/${name}`)).path;
const meta = JSON.parse(execFileSync("npx", ["xanosdk", "local", "token", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));

const http = async (verb, path, token, body) => {
  const res = await fetch(backend + path, { method: verb, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${verb} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};
let rpc = 0;
const runFunction = async (name, input) => {
  const res = await fetch(`${backend}/_engine/mcp`, { method: "POST", headers: { authorization: `Bearer ${meta.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name: "xano_run_function", arguments: { name, input } } }) });
  const answer = await res.json();
  if (answer.error || answer.result?.isError) throw new Error(`${name}: ${JSON.stringify(answer.error ?? answer.result).slice(0, 300)}`);
  return answer.result;
};
const signIn = async (persona) => (await http("POST", pathOf("POST", "auth/demo"), null, { persona })).authToken;
const read = (token, channel, after) => http("GET", `${pathOf("GET", "changes")}?channel=${encodeURIComponent(channel)}&after=${after}`, token);

/** Follows a channel the way a client does, and records what it saw, until `until()` and the head is reached. */
async function follow(token, channel, start, until) {
  const seen = [];
  let last = start;
  for (;;) {
    const done = until();
    const { seq, items } = await read(token, channel, last);
    for (const e of items) { seen.push(e.seq); last = e.seq; }
    if (done && !items.length && last >= seq) return seen;
  }
}

const race = async (token, channel, entity) => {
  const start = (await read(token, channel, -1)).seq;
  let finished = false;
  const reader = follow(token, channel, start, () => finished);
  const results = await Promise.allSettled(Array.from({ length: WRITERS }, (_, i) => runFunction("changes/record", { channel, entity, id: i + 1, op: "updated", actor_id: 1 })));
  finished = true;
  const seen = await reader;
  const wrote = results.filter((r) => r.status === "fulfilled").length;
  const expected = Array.from({ length: WRITERS }, (_, i) => start + i + 1);
  check(wrote === WRITERS, `${channel}: ${wrote} of ${WRITERS} concurrent ${entity} writes committed`);
  check(JSON.stringify(seen) === JSON.stringify(expected), `${channel}: the reader saw each entry once, in order (${seen.length} entries)`);
  if (results.find((r) => r.status === "rejected")) console.log(`  ${results.find((r) => r.status === "rejected").reason.message.slice(0, 200)}`);
};

const avery = await signIn("admin");
const me = await http("GET", pathOf("GET", "auth/me"), avery);
const space = await http("POST", pathOf("POST", "spaces"), avery, { name: `Race ${Date.now()}`, visibility: "private" });
await race(avery, `spaces/${space.id}`, "task");
await race(avery, "crm", "deal");

// Two tabs of one person. Each has its own socket, and only ids arrive.
const live = `${backend.replace(/^http/, "ws")}/ws/live`;
{
  const morgan = await signIn("member");
  const morganMe = await http("GET", pathOf("GET", "auth/me"), morgan);
  const open = () => new Promise((resolve, reject) => {
    const frames = [];
    const socket = new WebSocket(live, morgan);
    socket.onopen = () => setTimeout(() => socket.send(JSON.stringify({ action: "join", channel: `users/${morganMe.id}` })), 300);
    socket.onmessage = (e) => { const f = JSON.parse(String(e.data)); frames.push(f); if (f.action === "join") resolve({ socket, frames }); };
    socket.onerror = () => reject(new Error("the socket didn't open"));
  });
  const [first, second] = [await open(), await open()];
  const wait = async (tabFrames, op) => {
    for (let i = 0; i < 100; i++) {
      const hit = tabFrames.find((f) => f.action === "message" && f.type === "inbox" && f.payload?.op === op);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 30));
    }
    return null;
  };
  const started = Date.now();
  await runFunction("inbox/deliver", { user_id: morganMe.id, kind: "mention", title: "Avery Chen mentioned you", link: "/chat/1", actor_id: me.id, space_id: 0, dm_id: 0, entity: "", entity_id: 0, group_key: `check-${started}`, seq: 1 });
  const arrived = await wait(second.frames, "created");
  check(!!arrived, "the second tab heard a new item");
  check(arrived && !Object.keys(arrived.payload).some((k) => ["title", "body", "name"].includes(k)), "the frame carried ids, and no title");
  const before = (await http("GET", pathOf("GET", "app/notifications/unread"), morgan)).count;
  await http("POST", pathOf("POST", "app/notifications/{id}/read").replace("{id}", arrived.payload.id), morgan, {});
  check(!!(await wait(second.frames, "read")), "reading in the first tab reached the second");
  const after = (await http("GET", pathOf("GET", "app/notifications/unread"), morgan)).count;
  check(after === before - 1, `the count moved with it (${before} to ${after})`);
  first.socket.close();
  second.socket.close();
}

process.exit(failed ? 1 : 0);

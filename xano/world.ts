// The demo company: Oakline, a small studio relaunching a bike maker's website. One story runs through its chat and its tasks,
// so a first look finds people mid-way through real work. Rows refer to each other by position, and every date counts back
// from the deploy. Avery (1) runs the studio, Morgan (2) leads the project, Riley (3) is the client, and Scout (4) and Relay (5) are agents.
import { readFileSync } from "node:fs";
import { APP, DEFAULT_STAGES, DEMO_PEOPLE } from "./app.js";
import { TODAY_REACH_MINUTES, deployZone, seedClock } from "./seed-clock.js";

const AVERY = 1, MORGAN = 2, RILEY = 3, SCOUT = 4, RELAY = 5;
const HOUR = 3_600_000;
const NOW = Date.now();
const ago = (hours: number) => NOW - hours * HOUR;
/** What people said is stamped by the clock (seed-clock.ts): a time of day that fits the words, in working hours. */
export const SEED_CLOCK = seedClock(NOW, deployZone());
const { at, today } = SEED_CLOCK;
const SECOND = 1000, MINUTE = 60 * SECOND;
/** Today's lines are unread. Everything before them was read by the end of the last working day. */
const READ_BEFORE = today(TODAY_REACH_MINUTES);
const dayFromNow = SEED_CLOCK.dateFromNow;

const STUDIO = 1, RELAUNCH = 2, CLIENT_ROOM = 3;
export const SEED_SPACES = [
  { name: "Studio", visibility: "open" as const, guests_can_create: false, created_by: AVERY, is_demo: true },
  { name: "Marlow relaunch", visibility: "private" as const, guests_can_create: false, created_by: MORGAN, is_demo: true },
  { name: "Marlow client room", visibility: "private" as const, guests_can_create: true, created_by: MORGAN, is_demo: true },
];

const JOINED: readonly (readonly [space: number, who: number, role: "manager" | "member"])[] = [
  [STUDIO, AVERY, "manager"], [STUDIO, MORGAN, "member"], [STUDIO, SCOUT, "member"],
  [RELAUNCH, MORGAN, "manager"], [RELAUNCH, AVERY, "member"], [RELAUNCH, SCOUT, "member"], [RELAUNCH, RELAY, "member"],
  [CLIENT_ROOM, MORGAN, "manager"], [CLIENT_ROOM, AVERY, "member"], [CLIENT_ROOM, RILEY, "member"], [CLIENT_ROOM, RELAY, "member"], [CLIENT_ROOM, SCOUT, "member"],
];
export const SEED_SPACE_MEMBERS = JOINED.map(([space_id, user_id, role]) => ({ space_id, user_id, role }));
export const spaceIdsOf = (who: number) => JOINED.filter(([, id]) => id === who).map(([space]) => space);

/** `when` comes from `at(days, "HH:MM")` or `today(minutes)`. */
type Line = readonly [who: number, when: number, body: string];
/** Docs the chat points at, by position in DOCS below. */
const HOLIDAY_COVER = 3, RUNNING_ORDER = 8;
const CHANNELS: readonly { space: number; name: string; purpose: string; lines: readonly Line[] }[] = [
  { space: STUDIO, name: "general", purpose: "Studio news, the Friday demo and the day to day.", lines: [
    [AVERY, at(3, "09:12"), "Morning all. Friday demo moves to 3pm so Morgan can make the Marlow call first."],
    [MORGAN, at(3, "09:31"), `Thanks. I'll bring the new product page, it's finally on real photography. Running order is in <#doc:${RUNNING_ORDER}>.`],
    [AVERY, at(2, "11:05"), "Invoices for October are out. Shout if a client hasn't had theirs by tomorrow."],
    [MORGAN, at(1, "11:48"), "The office wifi drop this morning was the router update, not us. All back now."],
    [AVERY, today(170), `Reminder: holiday requests for December by Friday, please. Who's in when is in <#doc:${HOLIDAY_COVER}>.`],
  ] },
  { space: RELAUNCH, name: "marlow-launch", purpose: "Getting Marlow's new store live on the 14th: specs, checkout and launch day.", lines: [
    [MORGAN, at(2, "09:40"), "Where we are: product pages are built, checkout is on staging, and we're waiting on final bike specs from Riley's team."],
    [AVERY, at(2, "10:12"), "Does the 14th still hold? I told Riley it does."],
    [MORGAN, at(2, "10:20"), "It holds if specs land by Thursday. Anything later and we cut the comparison table from launch."],
    [AVERY, at(1, "10:05"), "Riley says the specs are coming as a spreadsheet, not the PIM export we planned on."],
    [MORGAN, at(1, "10:21"), "Fine for 12 models. I'd rather not hand-key it twice, so one clean import and then it's locked."],
    [MORGAN, at(1, "16:10"), `<@${SCOUT}> what's still open before we can call checkout done?`],
    [AVERY, today(150), "Payment provider confirmed the live keys come through on Wednesday."],
    [MORGAN, today(125), "Good. That unblocks the last checkout test. I'll book it for Wednesday afternoon."],
  ] },
  { space: RELAUNCH, name: "design", purpose: "The hero, the product pages and the size guide.", lines: [
    [MORGAN, at(2, "14:30"), "New hero options are in the shared folder. B is the strongest, but the crop loses the frame on phones."],
    [AVERY, at(2, "15:02"), "B, with the crop fixed. Riley will want the bike fully in frame."],
    [MORGAN, at(1, "14:40"), "Crop's fixed. Also moved the size guide up on the product page, people were missing it in testing."],
  ] },
  { space: CLIENT_ROOM, name: "marlow-oakline", purpose: "Working with Riley's team at Marlow. Riley reads everything here.", lines: [
    [RILEY, at(1, "09:20"), "Hi both, the spec spreadsheet needs one more pass from our engineering lead. Thursday at the latest."],
    [MORGAN, at(1, "09:47"), "Thursday works. Once it's in, we'll lock it and send a review link the same day."],
    [RILEY, today(175), "Could we see the size guide on the new page before the review? Sales keep asking about it."],
    [MORGAN, today(70), `<@${SCOUT}> can you draft a reply for Riley on where the size guide stands?`],
  ] },
];
const whenOf = (space: number, name: string, seq: number) => CHANNELS.find((ch) => ch.space === space && ch.name === name)!.lines[seq - 1][1];

// A finished job for Scout, so its work is on show before anyone has set a model key. It answers within the minute it was asked.
const ASKED_SCOUT = whenOf(RELAUNCH, "marlow-launch", 6);
const SCOUT_THREAD: readonly Line[] = [
  [SCOUT, ASKED_SCOUT + 20 * SECOND, "Reading the launch thread and the open checkout tasks."],
  [SCOUT, ASKED_SCOUT + 48 * SECOND, `Three things stand between us and done: the live payment keys, the end-to-end test that needs them, and the tax rules for EU orders, which <@${MORGAN}> still owns. Nothing else on the checkout list is open.`],
  [SCOUT, ASKED_SCOUT + 50 * SECOND, "Listed what's still open on checkout."],
];
const SCOUT_MENTION_CHANNEL = 2, SCOUT_MENTION_SEQ = 6;
const CHECKED_REDIRECTS = at(1, "12:10");
const ON_TASK: readonly Line[] = [
  [SCOUT, CHECKED_REDIRECTS, "Checking the launch tasks against the redirect list."],
  [SCOUT, CHECKED_REDIRECTS + 50 * SECOND, "All 41 old product URLs have a new home. Two old blog posts have none, so I've noted them on this task for a decision."],
  [SCOUT, CHECKED_REDIRECTS + 52 * SECOND, "Checked the redirect list."],
];

/** `doneHours`: how long ago a finished task was finished, so the overview's week against last week has a real past to read. */
type TaskSeed = { title: string; project: number; status: string; priority: string; assignee?: number; due?: number; description?: string; doneHours?: number; doneAt?: number };
/** Morgan fixed the crop and moved the size guide just before saying so in #design. */
const CROP_FIXED = at(1, "14:31"), SIZE_GUIDE_MOVED = at(1, "14:36");
const PROJECTS = [
  { space_id: RELAUNCH, name: "Website relaunch", created_by: MORGAN, is_demo: true },
  { space_id: STUDIO, name: "Studio ops", created_by: AVERY, is_demo: true },
  { space_id: CLIENT_ROOM, name: "Client sign-off", created_by: MORGAN, is_demo: true },
];
export const SEED_PROJECTS = PROJECTS;
const TASKS: readonly TaskSeed[] = [
  { title: "Check old URLs against the redirect list", project: 1, status: "in_review", priority: "medium", assignee: SCOUT, due: 3, description: "Every old product URL needs a new home before launch. Flag anything with no match." },
  { title: "Run the end-to-end checkout test with live keys", project: 1, status: "todo", priority: "urgent", assignee: MORGAN, due: 2, description: "Needs the live payment keys, due Wednesday. Test a card, a refund and a failed payment." },
  { title: "Set up tax rules for EU orders", project: 1, status: "in_progress", priority: "high", assignee: MORGAN, due: 4 },
  { title: "Import final bike specs", project: 1, status: "todo", priority: "high", assignee: MORGAN, due: 3, description: "One clean import from Riley's spreadsheet, 12 models, then lock it." },
  { title: "Fix hero crop on phones", project: 1, status: "done", priority: "medium", assignee: MORGAN, due: -1, doneAt: CROP_FIXED },
  { title: "Move the size guide up the product page", project: 1, status: "done", priority: "low", assignee: MORGAN, due: -1, doneAt: SIZE_GUIDE_MOVED },
  { title: "Write launch-day runbook", project: 1, status: "todo", priority: "medium", assignee: AVERY, due: 6, description: "Who does what on the 14th, and how we roll back." },
  { title: "Comparison table for bike models", project: 1, status: "backlog", priority: "low", description: "Only if specs land on time. Otherwise it follows after launch." },
  { title: "Connect the stock feed to product pages", project: 1, status: "in_progress", priority: "high", assignee: AVERY, due: 5 },
  { title: "Accessibility pass on checkout", project: 1, status: "backlog", priority: "medium", assignee: MORGAN, due: 7 },
  { title: "Send October invoices", project: 2, status: "done", priority: "medium", assignee: AVERY, due: -2 },
  { title: "Collect December holiday requests", project: 2, status: "todo", priority: "low", assignee: AVERY, due: 3 },
  { title: "Renew the design tool licences", project: 2, status: "backlog", priority: "none", assignee: AVERY, due: 12 },
  { title: "Send final spec spreadsheet", project: 3, status: "in_progress", priority: "high", assignee: RILEY, due: 2 },
  { title: "Approve the new product page", project: 3, status: "todo", priority: "high", assignee: RILEY, due: 5 },
  { title: "Share size guide preview with Marlow sales", project: 3, status: "todo", priority: "medium", assignee: MORGAN, due: 1 },
  // Added after the first sixteen, so the ids other rows point at hold. The finished ones are the last two weeks of work.
  { title: "Send Hana the spec import template", project: 1, status: "todo", priority: "high", assignee: MORGAN, due: -1, description: "Hana wants the column layout before her last pass on the spreadsheet, so the import runs once." },
  { title: "Write product copy for the 12 models", project: 1, status: "done", priority: "medium", assignee: MORGAN, due: -4, doneHours: 100 },
  { title: "Set up checkout on staging", project: 1, status: "done", priority: "high", assignee: AVERY, due: -5, doneHours: 140 },
  { title: "Book the room for the Friday demo", project: 2, status: "done", priority: "none", assignee: AVERY, due: -3, doneHours: 75 },
  { title: "Photograph the 12 bike models", project: 1, status: "done", priority: "medium", assignee: MORGAN, due: -9, doneHours: 216 },
  { title: "Agree redirect rules with Marlow IT", project: 1, status: "done", priority: "medium", assignee: MORGAN, due: -10, doneHours: 250 },
  { title: "Send Riley the review timeline", project: 3, status: "done", priority: "low", assignee: MORGAN, due: -11, doneHours: 270 },
];
const STEP = 1_048_576;
export const SEED_TASKS: any[] = TASKS.map((t, i) => ({
  project_id: t.project, space_id: PROJECTS[t.project - 1].space_id, title: t.title, description: t.description ?? "", status: t.status, priority: t.priority, due_on: t.due === undefined ? null : dayFromNow(t.due),
  assignee_id: t.assignee ?? 0, left_by: 0, created_by: PROJECTS[t.project - 1].created_by, rank: (i + 1) * STEP, client_id: `seed-${i + 1}`, completed_at: t.status === "done" ? t.doneAt ?? ago(t.doneHours ?? 18 + i) : null, created_at: ago(Math.max(70 - i, (t.doneHours ?? 0) + 48)), is_demo: true,
}));
const SCOUT_TASK = 1;

// Built up below, so each is any[]: a table's seed type wants its required columns, and these get them from `say`.
type Row = Record<string, unknown>;
export const SEED_CONVERSATIONS: any[] = [];
export const SEED_MESSAGES: any[] = [];
export const SEED_READS: any[] = [];
const say = (conversation: number, lines: readonly Line[], extra: (line: Line, seq: number) => Row = () => ({})) => lines.forEach((line, i) => {
  const [author_id, when, body] = line;
  const seq = i + 1;
  SEED_MESSAGES.push({ conversation_id: conversation, seq, version: seq, client_msg_id: `seed-${conversation}-${seq}`, author_id, body, created_at: when, thread_id: 0, reply_count: 0, run_id: 0, run_note: false, is_demo: true, ...extra(line, seq) });
});
const member = (space: number, who: number) => JOINED.some(([s, id]) => s === space && id === who);
for (const c of CHANNELS) {
  const id = SEED_CONVERSATIONS.length + 1;
  SEED_CONVERSATIONS.push({ space_id: c.space, kind: "channel", name: c.name, purpose: c.purpose, created_by: AVERY, is_demo: true, unique_key: `channel-${c.space}-${c.name}`, record_type: "", record_id: 0, parent_id: 0, dm_id: 0, crm: false, last_seq: c.lines.length, last_version: c.lines.length, last_message_at: c.lines.at(-1)![1] });
  say(id, c.lines);
  // Everyone has read up to today, so there's something new to find, and not a wall of it.
  const read = c.lines.filter(([, when]) => when < READ_BEFORE).length;
  for (const who of [AVERY, MORGAN, RILEY]) if (member(c.space, who)) SEED_READS.push({ conversation_id: id, user_id: who, last_read_seq: read });
}
const messageOf = (conversation: number, seq: number) => SEED_MESSAGES.find((m) => m.conversation_id === conversation && m.seq === seq)!;

const mention = messageOf(SCOUT_MENTION_CHANNEL, SCOUT_MENTION_SEQ);
const mentionId = SEED_MESSAGES.indexOf(mention) + 1;
const chatThread = SEED_CONVERSATIONS.length + 1;
const taskThread = chatThread + 1;
const thread = (recordType: string, recordId: number, parent: number, lines: readonly Line[]) => ({
  space_id: RELAUNCH, kind: "thread", name: "Thread", created_by: SCOUT, is_demo: true, unique_key: `thread-${recordType}-${recordId}`, record_type: recordType, record_id: recordId, parent_id: parent, dm_id: 0, crm: false,
  last_seq: lines.length, last_version: lines.length, last_message_at: lines.at(-1)![1],
});
SEED_CONVERSATIONS.push(thread("message", mentionId, SCOUT_MENTION_CHANNEL, SCOUT_THREAD), thread("task", SCOUT_TASK, 0, ON_TASK));
const noted = (runId: number, lines: readonly Line[]) => (_: Line, seq: number) => ({ run_id: runId, run_note: seq !== lines.length - 1 });
say(chatThread, SCOUT_THREAD, noted(1, SCOUT_THREAD));
say(taskThread, ON_TASK, noted(2, ON_TASK));
Object.assign(mention, { thread_id: chatThread, reply_count: SCOUT_THREAD.length, last_reply_at: SCOUT_THREAD.at(-1)![1], version: mention.seq });

const finished = (o: Row & { when: number; note: string; took: number }) => {
  const { when, note, took, ...row } = o;
  return { agent_id: SCOUT, requested_by: MORGAN, connection_id: 0, status: "done", reason: "", detail: "", space_id: RELAUNCH, dm_id: 0, active_key: null, base_url: "", attempt: 1, reclaims: 0, done_reported: true, last_note: note, steps: 4, tool_calls: 3, tool_errors: 0, waiting_on: 0,
    created_at: when, claimed_at: when, started_at: when, finished_at: when + took * SECOND, stopped_by: 0, is_demo: true, ...row };
};
export const SEED_RUNS: any[] = [
  finished({ source_type: "message", source_id: mentionId, conversation_id: SCOUT_MENTION_CHANNEL, thread_id: chatThread, when: ASKED_SCOUT, took: 50, note: "Listed what's still open on checkout." }),
  finished({ source_type: "task", source_id: SCOUT_TASK, conversation_id: 0, thread_id: taskThread, when: CHECKED_REDIRECTS, took: 52, note: "Checked the redirect list." }),
];

// The team's docs, with one change from Scout waiting to be looked at. Text is what the server would derive from these lines.
/** `editor`: who touched it last, when that isn't its owner. */
type DocSeed = { space: number; owner: number; title: string; hours: number; editor?: number; lines: readonly (string | readonly [heading: string])[] };
const DOCS: readonly DocSeed[] = [
  { space: RELAUNCH, owner: MORGAN, title: "Marlow launch brief", hours: 9, lines: [
    "The relaunch moves Marlow to the new storefront, with final bike specs from Riley's team and a week of soft launch before the press date.",
    ["Dates"], "Specs lock on Thursday. Checkout goes live on the 14th, with the comparison table to follow if specs land on time.",
    ["Who does what"], "Morgan runs the import and the end-to-end test. Avery owns payments and the live keys.",
  ] },
  { space: RELAUNCH, owner: AVERY, title: "Rollback plan", hours: 30, lines: ["If checkout fails on the day, the old store stays one DNS change away for 48 hours.", ["Who decides"], "Avery makes the call, after a word with Morgan."] },
  { space: STUDIO, owner: AVERY, title: "Holiday cover", hours: 50, lines: ["December requests by Friday, please. Two people in the studio at all times."] },
  { space: CLIENT_ROOM, owner: MORGAN, title: "Size guide notes", hours: 20, lines: ["Sales keep asking about sizing, so the guide moves up the product page. Riley will review it on the new page."] },
  { space: RELAUNCH, owner: MORGAN, title: "Spec import checklist", hours: 26, editor: AVERY, lines: [
    "One clean import from Riley's spreadsheet, then the specs lock. Nobody edits a bike's specs by hand after that.",
    ["Before the import"], "Hana confirms the column layout. Frame sizes use the same names as the size guide. Weights are in kilograms, to one decimal place.",
    ["After the import"], "Spot-check three models against the printed catalogue, then send Riley the review link the same day.",
  ] },
  { space: RELAUNCH, owner: AVERY, title: "Payments go-live notes", hours: 3.5, lines: [
    "The payment provider sends the live keys on Wednesday morning. Avery adds them, and nobody else touches the payment settings that day.",
    ["The test"], "Morgan runs one real card payment, one refund and one failed payment, then we switch the store to live keys.",
    ["If it fails"], "We stay on the old checkout and follow the rollback plan.",
  ] },
  { space: CLIENT_ROOM, owner: MORGAN, title: "Marlow weekly call notes", hours: 31, editor: RILEY, lines: [
    "Riley, Hana, Morgan and Avery.",
    ["Decided"], "Specs come as a spreadsheet, not the PIM export. The review link goes out the day the specs lock.",
    ["Open"], "Sales want to see the size guide before the review. Riley to confirm who signs off the comparison table.",
  ] },
  { space: STUDIO, owner: MORGAN, title: "Friday demo running order", hours: 70, lines: [
    "3pm, in the big room. Ten minutes each, questions at the end.",
    ["Running order"], "Morgan: the Marlow product page on real photography. Avery: the new invoice templates. Scout: what it checked this week.",
  ] },
  { space: STUDIO, owner: AVERY, title: "Studio handbook", hours: 340, editor: MORGAN, lines: [
    "How we work at Oakline, for anyone joining.",
    ["Clients"], "Each client gets a private space and a client room. Clients only ever see their client room.",
    ["Agents"], "Scout and Relay are members like anyone else. Anything a client would read waits for a person's OK first.",
    ["Money"], "Invoices go out on the first working day of the month. Holiday requests go to Avery.",
  ] },
];
const block = (line: string | readonly [string]) => (typeof line === "string"
  ? { type: "paragraph", content: [{ type: "text", text: line }] }
  : { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: line[0] }] });
/** What docs/excerpt would keep: the first paragraph. */
const firstParagraph = (d: DocSeed) => d.lines.find((l): l is string => typeof l === "string") ?? "";
export const SEED_DOCS: any[] = DOCS.map((d) => ({
  owner_id: d.owner, title: d.title, body: { type: "doc", content: d.lines.map(block) }, excerpt: firstParagraph(d).slice(0, 140), text: d.lines.map((l) => (typeof l === "string" ? l : l[0])).join("\n"), record_type: "", record_id: 0, visibility: "team", version: 1, mentions: [],
  last_edited_by: d.editor ?? d.owner, created_at: ago(d.hours + 2), updated_at: ago(d.hours), versioned_at: ago(d.hours), snapshot_version: 0, deleted: false, deleted_by: 0, space_id: d.space, is_demo: true,
}));
export const SEED_DOC_SUGGESTIONS: any[] = [{
  doc_id: 1, space_id: RELAUNCH, agent_id: SCOUT, run_id: 0, base_version: 1, find: "Checkout goes live on the 14th", text: "Checkout goes live on the 14th, once the live keys are tested on Wednesday", blocks: [], note: "The live keys land on Wednesday, and the launch date depends on that test.", status: "pending", applied_version: 0, decided_by: 0, created_at: ago(2),
}];

// The customers: Marlow is the relaunch everyone is on, and the rest are who's next. Close dates count forward from the deploy.
export const SEED_STAGES: any[] = DEFAULT_STAGES.map((stage, i) => ({ ...stage, rank: i + 1, is_demo: true }));
const LEAD = 1, QUALIFIED = 2, PROPOSAL = 3, NEGOTIATION = 4, WON = 5, LOST = 6;
const MARLOW = 1, FENWICK = 2, BRIGHTWATER = 3, HARBOUR = 4, TALLIS = 5, NORTHGATE = 6, ALDER = 7;
const company = (name: string, domain: string, industry: string, owner: number, about: string) => ({ name, domain, industry, about, owner_id: owner, created_by: owner, is_demo: true, created_at: ago(900) });
export const SEED_COMPANIES: any[] = [
  company("Marlow Cycles", "marlow.example", "Bike maker", MORGAN, "Family bike maker with 12 models. We're moving them to a new storefront, and the launch is on the 14th."),
  company("Fenwick Outdoor", "fenwick.example", "Outdoor retail", AVERY, "Six shops and a tired online store. Tom wants one catalogue across both before spring."),
  company("Brightwater Coffee", "brightwater.example", "Coffee roaster", MORGAN, "Small roaster growing fast through subscriptions, and outgrowing its shop plugin."),
  company("Harbour Line Ferries", "harbourline.example", "Passenger ferries", AVERY, "Regional ferry operator. Booking drop-off on phones is the problem they came to us with."),
  company("Tallis Bakery Group", "tallis.example", "Wholesale bakery", MORGAN, "Supplies 200 cafes, and takes most orders by phone and email today."),
  company("Northgate Credit Union", "northgate.example", "Member finance", AVERY, "Member-owned lender. Any new site goes through a long compliance review."),
  company("Alder & Finch", "alderfinch.example", "Furniture", MORGAN, "Two-person furniture studio. They went with a freelancer on price."),
];
const person = (company_id: number, name: string, job_title: string, email: string, phone = "") => ({ company_id, name, job_title, email, phone, created_by: MORGAN, is_demo: true, created_at: ago(800) });
export const SEED_CONTACTS: any[] = [
  person(MARLOW, "Riley Park", "Head of digital", "riley@marlow.example", "+1 555 0142"),
  person(MARLOW, "Hana Osei", "Engineering lead", "hana@marlow.example"),
  person(FENWICK, "Tom Fenwick", "Managing director", "tom@fenwick.example", "+1 555 0177"),
  person(FENWICK, "Priya Nair", "Ecommerce manager", "priya@fenwick.example"),
  person(BRIGHTWATER, "Sam Whitlock", "Founder", "sam@brightwater.example", "+1 555 0119"),
  person(HARBOUR, "Elena Marsh", "Marketing lead", "elena@harbourline.example"),
  person(TALLIS, "Jonas Reed", "Operations director", "jonas@tallis.example"),
  person(NORTHGATE, "Dee Adeyemi", "Head of member services", "dee@northgate.example"),
  person(ALDER, "Ruth Finch", "Co-founder", "ruth@alderfinch.example"),
];
type DealSeed = { title: string; company: number; stage: number; value: number; owner?: number; contact?: number; closes?: number; closedHours?: number };
const DEALS: readonly DealSeed[] = [
  { title: "Marlow website relaunch", company: MARLOW, stage: WON, value: 48_000, owner: MORGAN, contact: 1, closedHours: 1200 },
  { title: "Marlow care plan", company: MARLOW, stage: NEGOTIATION, value: 18_000, owner: MORGAN, contact: 1, closes: 12 },
  { title: "Bike comparison tools", company: MARLOW, stage: PROPOSAL, value: 9_500, owner: MORGAN, contact: 2, closes: 20 },
  { title: "Fenwick storefront rebuild", company: FENWICK, stage: PROPOSAL, value: 64_000, owner: AVERY, contact: 3, closes: 28 },
  { title: "Fenwick spring campaign site", company: FENWICK, stage: QUALIFIED, value: 12_000, owner: MORGAN, contact: 4, closes: 15 },
  { title: "Brightwater subscription shop", company: BRIGHTWATER, stage: QUALIFIED, value: 22_000, owner: MORGAN, contact: 5, closes: 35 },
  { title: "Brightwater wholesale pages", company: BRIGHTWATER, stage: WON, value: 8_000, owner: MORGAN, contact: 5, closedHours: 300 },
  { title: "Harbour Line booking redesign", company: HARBOUR, stage: NEGOTIATION, value: 85_000, owner: AVERY, contact: 6, closes: -2 },
  { title: "Tallis ordering portal", company: TALLIS, stage: LEAD, value: 30_000, contact: 7, closes: 60 },
  { title: "Northgate member site", company: NORTHGATE, stage: LEAD, value: 41_000, owner: AVERY, contact: 8, closes: 75 },
  { title: "Alder & Finch brand site", company: ALDER, stage: LOST, value: 16_000, owner: MORGAN, contact: 9, closedHours: 500 },
];
export const SEED_DEALS: any[] = DEALS.map((d, i) => ({
  company_id: d.company, contact_id: d.contact ?? 0, title: d.title, stage_id: d.stage, value: d.value, close_on: d.closes === undefined ? null : dayFromNow(d.closes), owner_id: d.owner ?? 0, rank: (i + 1) * STEP,
  created_by: d.owner ?? MORGAN, closed_at: d.closedHours === undefined ? null : ago(d.closedHours), is_demo: true, created_at: ago(700 - i),
}));
const noteOn = (record_type: "company" | "deal", record_id: number, company_id: number, author_id: number, hours: number, body: string) => ({ record_type, record_id, company_id, author_id, body, is_demo: true, created_at: ago(hours) });
const CARE_PLAN = 2, BOOKING = 8;
export const SEED_NOTES: any[] = [
  noteOn("company", MARLOW, MARLOW, MORGAN, 60, "Riley's team want one contact for anything after launch. Sales are the loudest voice inside Marlow right now, mostly about sizing."),
  noteOn("deal", CARE_PLAN, MARLOW, MORGAN, 26, "Riley asked what support looks like after the 14th. Sent a first outline: monthly releases and a support budget, renewed yearly."),
  noteOn("deal", CARE_PLAN, MARLOW, SCOUT, 25, `From the launch thread: the open risk is the spec import, which <@${MORGAN}> owns. Worth settling before the care plan is signed, so the handover list is right.`),
  noteOn("deal", BOOKING, HARBOUR, AVERY, 40, "Board meets on Tuesday. Elena thinks the budget is safe, but they want the phone booking numbers first."),
  noteOn("company", FENWICK, FENWICK, AVERY, 90, "Tom is the buyer and Priya runs the day to day. Spring range lands in February, which sets the date for everything."),
];

// Who's talking about the care plan, in the deal's own thread.
const CARE_THREAD: readonly Line[] = [
  [MORGAN, at(1, "12:40"), "Riley's asked for a yearly price. I've pencilled 18k with the releases included. Happy with that?"],
  [AVERY, at(1, "13:30"), "Fine, if support hours are capped. Let's not sign until the spec import is done, so we know what we're looking after."],
];
const careThread = SEED_CONVERSATIONS.length + 1;
SEED_CONVERSATIONS.push({ space_id: 0, kind: "thread", name: "Thread", created_by: MORGAN, is_demo: true, unique_key: `thread-deal-${CARE_PLAN}`, record_type: "deal", record_id: CARE_PLAN, parent_id: 0, dm_id: 0, crm: true, last_seq: CARE_THREAD.length, last_version: CARE_THREAD.length, last_message_at: CARE_THREAD.at(-1)![1] });
say(careThread, CARE_THREAD);

// The first minute: Morgan asked Scout for a reply to Riley, and Scout's draft waits for her OK, because Riley is a guest in the client
// room and reads the thread it would go in. It's a sample run: no model wrote it, the "Sample run" label says so, and however Morgan
// decides, the run ends there with no model call (KTD3). The approval and the post it makes are real.
const SAMPLE_CHANNEL = 4;
const sampleAsk = messageOf(SAMPLE_CHANNEL, CHANNELS.find((ch) => ch.space === CLIENT_ROOM)!.lines.length);
const sampleAskId = SEED_MESSAGES.indexOf(sampleAsk) + 1;
const sampleThread = SEED_CONVERSATIONS.length + 1;
SEED_CONVERSATIONS.push({ space_id: CLIENT_ROOM, kind: "thread", name: "Thread", created_by: SCOUT, is_demo: true, unique_key: `thread-message-${sampleAskId}`, record_type: "message", record_id: sampleAskId, parent_id: SAMPLE_CHANNEL, dm_id: 0, crm: false, last_seq: 0, last_version: 0, last_message_at: null });
Object.assign(sampleAsk, { thread_id: sampleThread });
// Comments on the docs people are working from, in each doc's own thread.
const DOC_COMMENTS: readonly { doc: number; lines: readonly Line[] }[] = [
  { doc: 1, lines: [
    [AVERY, at(1, "16:30"), "Can we say who signs off the comparison table? Riley asked on the call and I didn't have an answer."],
    [MORGAN, at(1, "16:52"), "Riley does, once the specs are locked. I'll add it to the dates."],
  ] },
  { doc: 2, lines: [[MORGAN, at(1, "11:20"), "48 hours feels right. Who's watching the old store over the weekend?"]] },
  { doc: 5, lines: [
    [AVERY, at(1, "13:05"), "Added the weight rule. The catalogue mixes pounds and kilograms."],
    [MORGAN, at(1, "13:20"), "Good catch, thanks."],
    [AVERY, at(1, "13:24"), "I'll check the three models with you on Thursday."],
  ] },
  { doc: 7, lines: [[RILEY, at(1, "09:05"), "Fixed the attendee list. Hana was on the call too."]] },
];
for (const { doc, lines } of DOC_COMMENTS) {
  const id = SEED_CONVERSATIONS.length + 1;
  const space = DOCS[doc - 1].space;
  SEED_CONVERSATIONS.push({ space_id: space, kind: "thread", name: "Thread", created_by: lines[0][0], is_demo: true, unique_key: `thread-doc-${doc}`, record_type: "doc", record_id: doc, parent_id: 0, dm_id: 0, crm: false, last_seq: lines.length, last_version: lines.length, last_message_at: lines.at(-1)![1] });
  say(id, lines);
}
const SAMPLE_RUN = 3, SAMPLE_APPROVAL = 1;
/** When Scout's draft was ready: a few seconds after Morgan asked. */
const DRAFTED = sampleAsk.created_at + 40 * SECOND;
/** What Scout proposes to post. Morgan can change a word before it goes. */
export const SAMPLE_PROPOSAL = "Hi Riley, the size guide now sits right under the bike photos on the new product page. Morgan will send your sales team a preview link on Wednesday, ahead of the review.";
SEED_RUNS.push({
  agent_id: SCOUT, requested_by: MORGAN, connection_id: 0, status: "waiting", reason: "", detail: "", source_type: "message", source_id: sampleAskId, conversation_id: SAMPLE_CHANNEL, thread_id: sampleThread,
  space_id: CLIENT_ROOM, dm_id: 0, active_key: `${SCOUT}-message-${sampleAskId}`, base_url: "", attempt: 1, reclaims: 0, done_reported: false, last_note: "Drafted a reply for Riley, for Morgan to check first.",
  steps: 0, tool_calls: 0, tool_errors: 0, waiting_on: MORGAN, approval_id: SAMPLE_APPROVAL, created_at: sampleAsk.created_at, claimed_at: null, started_at: null, finished_at: null, stopped_by: 0, sample: true, is_demo: true,
});
/** Module approvals last 7 days, so the sample's waits until long after anyone could open the demo. */
export const SAMPLE_EXPIRES_AT = Date.UTC(2099, 0, 1);
export const SEED_APPROVALS: any[] = [{
  user_id: MORGAN, source: "mcp", agent_label: "Scout", connection_id: 0, action: "send_external", title: "Post a message", preview: SAMPLE_PROPOSAL, link: `/chat/${sampleThread}`,
  payload: { conversation_id: sampleThread, body: SAMPLE_PROPOSAL, agent_id: SCOUT, connection_id: 0, run_id: SAMPLE_RUN, record_type: "conversation", record_id: sampleThread, decider_id: 0 },
  approve_label: "Post it", editable_field: "body", approver_roles: "", status: "pending", decided_by: 0, decided_at: null, expires_at: SAMPLE_EXPIRES_AT, created_at: DRAFTED,
}];
// Everyone starts with a welcome. Morgan also has Scout's request, which is where a demo signs in.
export const SEED_NOTIFICATIONS: any[] = [
  ...DEMO_PEOPLE.map((p, i) => ({
    user_id: i + 1, kind: "welcome", title: `Welcome to ${APP.name}`, body: "Your overview shows what needs you. Press ⌘K to jump anywhere.", link: "/", read_at: null, done_at: null,
    space_id: 0, entity: "", entity_id: 0, group_key: `welcome-${i + 1}`, seq: 0, head: true, group_count: 1, needs_action: false, clearable: true,
  })),
  { user_id: MORGAN, kind: "approval", title: "Scout wants to post where guests can read", body: "", link: `/chat/${sampleThread}`, actor_id: SCOUT, read_at: null, done_at: null,
    space_id: CLIENT_ROOM, entity: "approval", entity_id: SAMPLE_APPROVAL, group_key: `approval-${SAMPLE_APPROVAL}`, seq: 0, head: true, group_count: 1, needs_action: true, clearable: false, created_at: DRAFTED },
];

// What already touches Marlow: its launch work, its channels, its docs and Scout's thread on what's left to do.
const LAUNCH_CHANNEL = 2, CLIENT_CHANNEL = 4;
const HOLIDAY_REQUESTS = 12, HERO_CROP = 5;
const IMPORT_SPECS = 4, COMPARISON = 8, CHECKOUT_TEST = 2, SEND_SPECS = 14, APPROVE_PAGE = 15, SIZE_GUIDE = 16, LAUNCH_BRIEF = 1, SIZE_NOTES = 4, IMPORT_CHECKLIST = 5, PAYMENTS_NOTES = 6, CALL_NOTES = 7;
const linked = (from_type: string, from_id: number, scope: number, to_type: string, to_id: number, origin: "manual" | "body" = "manual") => ({ from_type, from_id, to_type, to_id, origin, from_scope: `space-${scope}`, created_by: MORGAN });

// The files people are working from. Each is a table row with its bytes beside it, on every target: a seeded private storage file
// would land in the public bucket, and a table row is private wherever it runs. The thumbnails and previews come from these bytes.
type FileSeed = { file: string; name: string; type: string; kind: string; space: number; by: number; when: number; safe?: string };
const FILES: readonly FileSeed[] = [
  { file: "marlow-hero-option-b.png", name: "Marlow hero option B.png", type: "image/png", kind: "image", space: RELAUNCH, by: MORGAN, when: whenOf(RELAUNCH, "design", 3) - 2 * MINUTE },
  { file: "marlow-bike-specs.csv", name: "Marlow bike specs.csv", type: "text/csv", kind: "text", space: RELAUNCH, by: MORGAN, when: at(1, "10:30"), safe: "text/plain; charset=utf-8" },
  { file: "unmatched-redirects.txt", name: "Unmatched redirects.txt", type: "text/plain", kind: "text", space: RELAUNCH, by: SCOUT, when: ON_TASK[1][1], safe: "text/plain; charset=utf-8" },
  { file: "marlow-size-guide.pdf", name: "Marlow size guide.pdf", type: "application/pdf", kind: "pdf", space: CLIENT_ROOM, by: MORGAN, when: at(1, "15:10") },
  { file: "oakline-logo-pack.zip", name: "Oakline logo pack.zip", type: "application/zip", kind: "archive", space: STUDIO, by: AVERY, when: at(3, "10:40"), safe: "application/octet-stream" },
  // Added after the first five, so the ids links point at hold.
  { file: "checkout-test-plan.csv", name: "Checkout test plan.csv", type: "text/csv", kind: "text", space: RELAUNCH, by: AVERY, when: today(115), safe: "text/plain; charset=utf-8" },
  { file: "marlow-review-timeline.txt", name: "Marlow review timeline.txt", type: "text/plain", kind: "text", space: CLIENT_ROOM, by: MORGAN, when: at(1, "09:52"), safe: "text/plain; charset=utf-8" },
  { file: "december-cover-rota.csv", name: "December cover rota.csv", type: "text/csv", kind: "text", space: STUDIO, by: AVERY, when: at(2, "16:20"), safe: "text/plain; charset=utf-8" },
];
const bytesOf = (name: string) => readFileSync(new URL(`./seed-files/${name}`, import.meta.url));
export const SEED_FILES: any[] = FILES.map((f) => ({
  name: f.name, mime: f.type, size: bytesOf(f.file).length, kind: f.kind, safe_type: f.safe ?? f.type, mode: "table", attachment: null, scope: `space-${f.space}`, space_id: f.space, dm_id: 0, crm: false, uploaded_by: f.by, run_id: 0, created_at: f.when, is_demo: true,
}));
export const SEED_FILE_BLOBS: any[] = FILES.map((f, i) => ({ file_id: i + 1, b64: bytesOf(f.file).toString("base64") }));
const HERO = 1, SPECS = 2, UNMATCHED = 3, SIZE_GUIDE_FILE = 4, TEST_PLAN = 6, TIMELINE = 7, COVER_ROTA = 8;
const crop = messageOf(3, 3);
crop.file_ids = [HERO];

export const SEED_LINKS: any[] = [
  linked("file", SPECS, RELAUNCH, "task", IMPORT_SPECS), linked("file", SPECS, RELAUNCH, "company", MARLOW), linked("file", UNMATCHED, RELAUNCH, "task", SCOUT_TASK), linked("file", HERO, RELAUNCH, "company", MARLOW),
  linked("file", SIZE_GUIDE_FILE, CLIENT_ROOM, "task", SIZE_GUIDE), linked("file", SIZE_GUIDE_FILE, CLIENT_ROOM, "company", MARLOW), linked("file", SIZE_GUIDE_FILE, CLIENT_ROOM, "doc", SIZE_NOTES),
  linked("task", IMPORT_SPECS, RELAUNCH, "company", MARLOW), linked("task", CHECKOUT_TEST, RELAUNCH, "company", MARLOW), linked("task", COMPARISON, RELAUNCH, "deal", 3),
  linked("task", SEND_SPECS, CLIENT_ROOM, "company", MARLOW), linked("task", APPROVE_PAGE, CLIENT_ROOM, "company", MARLOW), linked("task", SIZE_GUIDE, CLIENT_ROOM, "deal", CARE_PLAN),
  linked("conversation", LAUNCH_CHANNEL, RELAUNCH, "company", MARLOW), linked("conversation", CLIENT_CHANNEL, CLIENT_ROOM, "company", MARLOW), linked("conversation", chatThread, RELAUNCH, "deal", CARE_PLAN),
  linked("doc", LAUNCH_BRIEF, RELAUNCH, "company", MARLOW), linked("doc", SIZE_NOTES, CLIENT_ROOM, "company", MARLOW),
  linked("file", TEST_PLAN, RELAUNCH, "task", CHECKOUT_TEST), linked("file", TEST_PLAN, RELAUNCH, "doc", PAYMENTS_NOTES), linked("file", TIMELINE, CLIENT_ROOM, "company", MARLOW),
  linked("message", SEED_MESSAGES.findIndex((m) => m.body.includes(`<#doc:${RUNNING_ORDER}>`)) + 1, STUDIO, "doc", RUNNING_ORDER, "body"),
  linked("message", SEED_MESSAGES.findIndex((m) => m.body.includes(`<#doc:${HOLIDAY_COVER}>`)) + 1, STUDIO, "doc", HOLIDAY_COVER, "body"),
  linked("file", HERO, RELAUNCH, "task", HERO_CROP), linked("file", HERO, RELAUNCH, "message", SEED_MESSAGES.indexOf(crop) + 1),
  linked("file", COVER_ROTA, STUDIO, "doc", HOLIDAY_COVER), linked("file", COVER_ROTA, STUDIO, "task", HOLIDAY_REQUESTS),
  linked("doc", IMPORT_CHECKLIST, RELAUNCH, "task", IMPORT_SPECS), linked("doc", PAYMENTS_NOTES, RELAUNCH, "task", CHECKOUT_TEST), linked("doc", CALL_NOTES, CLIENT_ROOM, "company", MARLOW),
];

// What search holds at the start. Seed rows don't pass through the change path, so this is what it would have written.
const SEARCH_TEXT_LIMIT = 4000;
const noMentions = (text: string) => text.replace(/<[@#][^>]*>/g, " ");
const homeOf = (conversationId: number) => {
  const c = SEED_CONVERSATIONS[conversationId - 1];
  const dm = c.kind === "dm" ? conversationId : c.dm_id ?? 0;
  const scope = dm ? `dm-${dm}` : c.space_id ? `space-${c.space_id}` : c.crm ? "crm" : "";
  const record: Record<string, string> = { task: `/tasks/${c.record_id}`, doc: `/docs/${c.record_id}`, company: `/crm/companies/${c.record_id}`, deal: `/crm/deals/${c.record_id}` };
  return { scope, href: record[c.record_type ?? ""] ?? `/chat/${conversationId}` };
};
const entry = (entity: string, entity_id: number, title: string, body: string, scope: string, href: string, changed_at: number, conversation_id = 0) => {
  const words = body.slice(0, SEARCH_TEXT_LIMIT);
  return { key: `${entity}-${entity_id}`, entity, entity_id, title, body: words, terms: `${title} ${words}`, scope, href, conversation_id, changed_at, is_demo: true };
};
export const SEED_SEARCH: any[] = [
  ...SEED_SPACES.map((s, i) => entry("space", i + 1, s.name, "", `space-${i + 1}`, `/?space=${i + 1}`, NOW)),
  ...SEED_CONVERSATIONS.flatMap((c, i) => (c.kind === "channel" ? [entry("conversation", i + 1, c.name, "", `space-${c.space_id}`, `/chat/${i + 1}`, c.last_message_at ?? NOW)] : [])),
  ...SEED_MESSAGES.flatMap((m, i) => {
    const home = homeOf(m.conversation_id);
    const body = noMentions(m.body);
    return home.scope ? [entry("message", i + 1, body.trim().slice(0, 120), body, home.scope, `${home.href}?seq=${m.seq}`, m.created_at, m.conversation_id)] : [];
  }),
  ...PROJECTS.map((p, i) => entry("project", i + 1, p.name, "", `space-${p.space_id}`, `/tasks?project=${i + 1}`, NOW)),
  ...SEED_TASKS.map((t, i) => entry("task", i + 1, t.title, noMentions(t.description), `space-${t.space_id}`, `/tasks/${i + 1}`, NOW)),
  ...SEED_DOCS.flatMap((d, i) => (d.space_id ? [entry("doc", i + 1, d.title, d.text, `space-${d.space_id}`, `/docs/${i + 1}`, d.updated_at)] : [])),
  ...SEED_FILES.map((f, i) => entry("file", i + 1, f.name, "", f.scope, `/files/${i + 1}`, NOW)),
  ...SEED_COMPANIES.map((c, i) => entry("company", i + 1, c.name, `${c.domain} ${c.industry} ${c.about}`, "crm", `/crm/companies/${i + 1}`, NOW)),
  ...SEED_CONTACTS.map((p, i) => entry("contact", i + 1, p.name, `${p.job_title} ${p.email}`, "crm", `/crm/companies/${p.company_id}?contact=${i + 1}`, NOW)),
  ...SEED_DEALS.map((d, i) => entry("deal", i + 1, d.title, "", "crm", `/crm/deals/${i + 1}`, NOW)),
  ...SEED_NOTES.map((n, i) => entry("crm_note", i + 1, "A note", noMentions(n.body), "crm", `/crm/companies/${n.company_id}`, NOW)),
];

// What's been happening, so the feed reads like a team mid-way through work. A real write adds to it through app/changed.
const did = (actor_id: number, actor_name: string, verb: string, entity: string, entity_id: number, title: string, link: string, space_id: number, when: number) =>
  ({ actor_id, actor_name, via: "", verb, entity, entity_id, title, link, private_to: 0, space_id, created_at: when });
export const SEED_ACTIVITY: any[] = [
  did(MORGAN, "Morgan Reyes", "finished", "task", 6, "finished Move the size guide up the product page", "/tasks/6", RELAUNCH, SIZE_GUIDE_MOVED),
  did(MORGAN, "Morgan Reyes", "finished", "task", 5, "finished Fix hero crop on phones", "/tasks/5", RELAUNCH, CROP_FIXED),
  did(MORGAN, "Morgan Reyes", "assigned", "task", 16, "took Share size guide preview with Marlow sales", "/tasks/16", CLIENT_ROOM, today(60)),
  did(RILEY, "Riley Park", "updated", "task", 14, "started Send final spec spreadsheet", "/tasks/14", CLIENT_ROOM, today(165)),
  did(AVERY, "Avery Chen", "finished", "task", 11, "finished Send October invoices", "/tasks/11", STUDIO, at(2, "11:00")),
].sort((a, b) => a.created_at - b.created_at);

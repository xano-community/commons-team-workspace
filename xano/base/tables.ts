// The base app's own tables: what every template has besides its domain (BASELINE.md).
import { f, table } from "@xano/sdk";
import { APP, DEMO_PEOPLE, DEMO_SIGN_IN, ROLES, SEED_ACTIVITY } from "../app.js";
import { user } from "../table/user.js";

const DAY = 86_400_000;

/** One-click demo sign-in. Delete these rows to turn demo sign-in off. */
export const demo_persona = table({
  name: "demo_persona",
  description: "One-click demo sign-in. Delete these rows to turn demo sign-in off.",
  schema: { key: f.text({ required: true }), label: f.text({ required: true }), description: f.text(), email: f.email({ required: true }) },
  index: [{ type: "btree|unique", fields: [{ name: "key", op: "asc" }] }],
  // In sign-in order: the person the demo's first minute is built around comes first.
  seed: DEMO_SIGN_IN.map((p) => ({ key: p.key, label: p.name, description: p.description, email: p.email })),
});

/** Something a person should know about: an approval waiting, a job assigned to them, an invite accepted. */
export const notification = table({
  name: "notification",
  description: "A person's notifications, newest first. The bell counts the unread ones.",
  schema: {
    user_id: f.tableRef(user, { required: true }),
    /** A short key the app chooses ("approval", "assigned", "invite"), for the icon. */
    kind: f.text(),
    title: f.text({ required: true }),
    body: f.text(),
    /** Where it opens in the app ("/jobs/12"). */
    link: f.text(),
    /** Who caused it, when it was a person. */
    actor_id: f.tableRef(user),
    read_at: f.timestamp({ nullable: true }),
    /** Set when it leaves the inbox: cleared, decided, withdrawn. Read and done are separate. */
    done_at: f.timestamp({ nullable: true }),
    /** The space it's about, so a person who leaves stops seeing it and gets it back on return. 0: the workspace's own. */
    space_id: f.int(),
    /** The record it's about. Its name is resolved per viewer at read time: `title` never holds it. */
    entity: f.text(),
    entity_id: f.int(),
    /** Rows with one key show as one line. */
    group_key: f.text({ required: true }),
    /** The message's place in its conversation, or 0. With `group_key` it says which source a row came from. */
    seq: f.int(),
    /** The newest open row of its group, the one the inbox lists. */
    head: f.bool(),
    /** How many open rows the group holds. Kept on the head. */
    group_count: f.int(),
    /** Waits for a decision: Mark all read skips it, and it sorts first. */
    needs_action: f.bool(),
    /** The person may clear it. The others leave when their record says so. */
    clearable: f.bool(),
  },
  index: [
    { type: "btree", fields: [{ name: "user_id", op: "asc" }, { name: "created_at", op: "desc" }] },
    { type: "btree|unique", fields: [{ name: "user_id", op: "asc" }, { name: "group_key", op: "asc" }, { name: "seq", op: "asc" }] },
    { type: "btree", fields: [{ name: "entity", op: "asc" }, { name: "entity_id", op: "asc" }] },
  ],
  seed: DEMO_PEOPLE.map((p, i) => ({
    user_id: i + 1, kind: "welcome", title: `Welcome to ${APP.name}`,
    body: "Your overview shows what needs you. Press ⌘K to jump anywhere.", link: "/", read_at: null, done_at: null,
    space_id: 0, entity: "", entity_id: 0, group_key: `welcome-${i + 1}`, seq: 0, head: true, group_count: 1, needs_action: false, clearable: true,
  })),
});

/** What happened, by people and their agents: the overview's feed and each record's timeline. */
export const activity = table({
  name: "activity",
  description: "What people and their agents did. Written by app/changed; read by the activity feed and record timelines.",
  schema: {
    actor_id: f.tableRef(user),
    /** Their name when it happened, so the feed and the assistant can say who without a lookup. */
    actor_name: f.text(),
    /** The agent that acted for the person ("Claude Code"), or empty when the person did it themselves. */
    via: f.text(),
    /** The person who approved it, when an agent asked first. */
    approved_by: f.tableRef(user),
    /** A past-tense phrase: "moved", "created", "approved". */
    verb: f.text(),
    /** The kind of record ("job") and its id: a record's timeline filters on both. */
    entity: f.text(),
    entity_id: f.int(),
    /** What they did, as the rest of a sentence after their name: "moved Fix the boiler to In progress". */
    title: f.text({ required: true }),
    link: f.text(),
    /** Only this person (plus the actor and team managers) sees the row. Empty: everyone signed in. */
    private_to: f.tableRef(user),
    /** The space the record lives in, so only people who reach it read this row. 0: the workspace's own. */
    space_id: f.int(),
  },
  index: [
    { type: "btree", fields: [{ name: "created_at", op: "desc" }] },
    { type: "btree", fields: [{ name: "entity", op: "asc" }, { name: "entity_id", op: "asc" }] },
  ],
  // Dated from the deploy, so "25 minutes ago" is true on every fresh deploy.
  seed: SEED_ACTIVITY.map((a) => ({
    created_at: Date.now() - a.minutesAgo * 60_000, actor_id: a.actor, actor_name: DEMO_PEOPLE[a.actor - 1]?.name ?? "", via: a.via ?? "",
    verb: a.verb, entity: a.entity, entity_id: a.entity_id, title: a.title, link: a.link ?? "", private_to: 0, space_id: 0,
  })),
});

/** Invite links (a new person joins with a role) and password-reset links (an admin issues one). */
export const access_link = table({
  name: "access_link",
  description: "One-time links: invites to join with a role, and password resets. Only a hash of the token is stored.",
  schema: {
    kind: f.enum(["invite", "reset"], { required: true }),
    email: f.email({ required: true }),
    name: f.text(),
    role: f.enum([...ROLES]),
    /** The reset's person; the new person, once an invite is accepted. */
    user_id: f.tableRef(user),
    token_hash: f.text({ required: true, access: "private" }),
    expires_at: f.timestamp({ required: true }),
    used_at: f.timestamp({ nullable: true }),
    revoked: f.bool(),
    created_by: f.tableRef(user, { required: true }),
  },
  index: [
    { type: "btree|unique", fields: [{ name: "token_hash", op: "asc" }] },
    { type: "btree", fields: [{ name: "email", op: "asc" }] },
  ],
});

/** The workspace's own settings: one row. Add the domain's settings here as columns (BASELINE.md). */
export const workspace_setting = table({
  name: "workspace_setting",
  description: "The workspace's settings: one row, edited by people who manage the team. No row means nobody has set the workspace up, and every demo door stays shut.",
  schema: {
    /** Always 1. Its unique index means two setups can't both create the row, whatever ids earlier attempts used. */
    singleton: f.int({ required: true }),
    name: f.text({ required: true }),
    /** An IANA zone ("Europe/London"): how the app reads "today". */
    timezone: f.text(),
    week_start: f.enum(["monday", "sunday"]),
    /** On: auth/demo signs the demo people in. Anything but true, including no row, keeps it shut. */
    demo_mode: f.bool(),
    /** On: anyone can create an account through auth/signup. Anything but true, including no row, keeps it shut. */
    signup_open: f.bool(),
    /** On: hosted runs stay queued, and none start until it's off. */
    agents_paused: f.bool(),
  },
  index: [{ type: "btree|unique", fields: [{ name: "singleton", op: "asc" }] }],
  seed: [{ singleton: 1, name: APP.name, timezone: "UTC", week_start: "monday", demo_mode: true, signup_open: true, agents_paused: false }],
});

export { DAY };

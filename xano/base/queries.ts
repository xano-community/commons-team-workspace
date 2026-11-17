// The base app's endpoints, in the `app` group: settings, notifications, the activity feed and the people list.
// Everything that mints or carries a token (demo sign-in, invites, reset links) is in the Authentication group
// instead, where request history is off: see query/authentication/links.ts.
import { apiGroup, auth, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, or, query, ref, s, withFilters } from "@xano/sdk";
import type { InferRow } from "@xano/sdk";
import { user } from "../table/user.js";
import { rbac } from "../rbac.js";
import { activity, notification, workspace_setting } from "./tables.js";
import { changed } from "./functions.js";
import { gateActive } from "../function/members/gate.js";
import { bindBrowser, inReachedFeed, reachOf } from "../function/access/reach.js";
import { space_member } from "../table/spaces/space_member.js";
import { clearItem, countInbox, listInbox, readAllItems, readItem } from "../function/inbox/read.js";
import type { RecordView } from "../query/links.js";

export const appGroup = apiGroup({ name: "app", canonical: "app", middleware: { pre: [gateActive] }, description: "What every template has besides its domain: settings, notifications, activity, people." });

type Settings = { id: number; name: string; timezone: string; week_start: "monday" | "sunday"; demo_mode: boolean; signup_open: boolean };
const SETTINGS_FIELDS = ["id", "name", "timezone", "week_start", "demo_mode", "signup_open"] as const;
const settingsRow = (as: string, extra: { lock?: boolean } = {}) =>
  s.db.get({ table: workspace_setting, fieldName: "singleton", fieldValue: c.int(1), output: SETTINGS_FIELDS, as, ...extra });

/** GET app/settings: the workspace's name, time zone and week start. Guests have only their spaces. */
export const getSettings = query({
  apiGroup: appGroup, auth: user,
  name: "app/settings", verb: "GET",
  description: "The workspace's settings.",
  stack: [
    ...rbac.require("workspace.read", "Guests don't have access to the workspace's settings."),
    settingsRow("row"),
    guard.found("row", { message: "The workspace has no settings row." }),
  ],
  response: ref("row"),
  responseShape: {} as Settings,
});

/** PATCH app/settings: rename the workspace, set its time zone and week start. team.manage. */
export const updateSettings = query({
  apiGroup: appGroup, auth: user,
  name: "app/settings", verb: "PATCH",
  description: "Change the workspace's settings. Only people who manage the team.",
  input: {
    name: input.text({ required: true, methods: ["trim"] }),
    timezone: input.text({ methods: ["trim"] }),
    week_start: input.enum(["monday", "sunday"]),
  },
  stack: [
    ...rbac.require("team.manage", "Only people who manage the team change the settings."),
    guard.require(expr(withFilters(inp("name"), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "The workspace needs a name." }),
    guard.require(expr(withFilters(inp("name"), fl.strlen()), "<=", c.int(60)), { errorType: "badrequest", message: "Keep the name under 60 characters." }),
    settingsRow("current"),
    guard.found("current", { message: "The workspace has no settings row." }),
    s.db.patch({ table: workspace_setting, fieldValue: ref("current.id"), data: obj({ name: inp("name"), timezone: inp("timezone"), week_start: inp("week_start") }) }),
    changed({ entity: "settings", id: ref("current.id"), title: "updated the workspace settings", verb: "updated", link: "/settings" }),
    settingsRow("row"),
  ],
  response: ref("row"),
  responseShape: {} as Settings,
});

type InboxItem = InferRow<typeof notification> & { actor_name: string | null; actor_kind: "human" | "agent" | null };
type InboxPage = {
  items: InboxItem[]; curPage: number; nextPage: number | null; prevPage: number | null; itemsTotal: number; pageTotal: number;
  /** Lines open now, and rows this person has ever had: together they tell "all done" from "never had any". */
  open: number; ever: number;
  records: RecordView[];
};
const me = () => ({ actor_id: auth("id"), browser: ref("browser") });

/** GET app/notifications: my inbox, what needs a decision first, paged. `view` narrows it to unread or needs a decision. */
export const listNotifications = query({
  apiGroup: appGroup, auth: user,
  name: "app/notifications", verb: "GET",
  description: "The signed-in person's inbox.",
  input: { view: input.enum(["all", "unread", "needs"]), space_id: input.int(), page: input.int() },
  stack: [...bindBrowser(), s.function.run({ fn: listInbox, as: "inbox", input: { ...me(), view: inp("view"), space_id: inp("space_id"), page: inp("page") } })],
  response: ref("inbox"),
  responseShape: {} as InboxPage,
});

/** GET app/notifications/unread: the inbox's number. */
export const unreadNotifications = query({
  apiGroup: appGroup, auth: user,
  name: "app/notifications/unread", verb: "GET",
  description: "How many unread lines the signed-in person's inbox has.",
  stack: [...bindBrowser(), s.function.run({ fn: countInbox, as: "n", input: me() })],
  response: { count: ref("n") },
  responseShape: {} as { count: number },
});

/** POST app/notifications/{id}/read: mark one of mine read, with what's grouped under it. 404 for anyone else's. */
export const readNotification = query({
  apiGroup: appGroup, auth: user,
  name: "app/notifications/{id}/read", verb: "POST",
  description: "Mark one of your inbox lines read.",
  input: { id: input.int({ required: true }) },
  stack: [...bindBrowser(), s.function.run({ fn: readItem, as: "done", input: { ...me(), id: inp("id") } })],
  response: { id: inp("id"), read: c.bool(true) },
});

/** POST app/notifications/{id}/done: clear one of mine out of the inbox. */
export const clearNotification = query({
  apiGroup: appGroup, auth: user,
  name: "app/notifications/{id}/done", verb: "POST",
  description: "Clear one of your inbox lines.",
  input: { id: input.int({ required: true }) },
  stack: [...bindBrowser(), s.function.run({ fn: clearItem, as: "done", input: { ...me(), id: inp("id") } })],
  response: { id: inp("id"), done: c.bool(true) },
});

/** POST app/notifications/read-all: mark everything read but what's waiting for a decision. */
export const readAllNotifications = query({
  apiGroup: appGroup, auth: user,
  name: "app/notifications/read-all", verb: "POST",
  description: "Mark your inbox read, except what needs a decision.",
  stack: [...bindBrowser(), s.function.run({ fn: readAllItems, as: "done", input: me() })],
  response: { read: c.bool(true) },
});

/** The feed or one record's timeline, for a person or an agent's tool alike. Only a person in a browser reads private rows by role. */
export const activityPage = defineFunction({
  name: "app/activity_page",
  description: "A page of what an actor may read of the activity feed.",
  input: { actor_id: input.int({ required: true }), browser: input.bool(), entity: input.text(), entity_id: input.int(), page: input.int(), size: input.int(), by: input.int() },
  stack: [
    reachOf(inp("actor_id"), inp("browser")),
    s.set_var("size", c.int(20)),
    s.conditional({ when: expr(inp("size"), ">", c.int(0)), then: [s.update_var("size", inp("size"))] }),
    s.conditional({ when: expr(ref("size"), ">", c.int(100)), then: [s.update_var("size", c.int(100))] }),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["role"], as: "reader" }),
    s.set_var("sees_private", c.bool(false)),
    s.conditional({ when: expr(inp("browser"), "=", c.bool(true)), then: [
      s.conditional({ when: rbac.has(ref("reader.role", { safe: true }), "team.manage"), then: [s.update_var("sees_private", c.bool(true))] }),
    ] }),
    s.conditional({
      when: expr(ref("sees_private"), "=", c.bool(true)),
      then: [s.db.query({ table: activity,
        where: [cmp(col("entity"), "=", inp("entity"), { ignoreEmpty: true }), cmp(col("entity_id"), "=", inp("entity_id"), { ignoreEmpty: true }), cmp(col("actor_id"), "=", inp("by"), { ignoreEmpty: true }), inReachedFeed()],
        sort: [{ sortBy: "created_at", dir: "desc" }], paging: { page: inp("page"), per_page: ref("size"), metadata: true, totals: true }, as: "rows" })],
      else: [s.db.query({ table: activity,
        where: [
          cmp(col("entity"), "=", inp("entity"), { ignoreEmpty: true }), cmp(col("entity_id"), "=", inp("entity_id"), { ignoreEmpty: true }), cmp(col("actor_id"), "=", inp("by"), { ignoreEmpty: true }), inReachedFeed(),
          or(cmp(col("private_to"), "=", c.null()), expr(col("private_to"), "=", c.int(0)), expr(col("private_to"), "=", inp("actor_id")), expr(col("actor_id"), "=", inp("actor_id"))),
        ],
        sort: [{ sortBy: "created_at", dir: "desc" }], paging: { page: inp("page"), per_page: ref("size"), metadata: true, totals: true }, as: "rows" })],
    }),
  ],
  response: ref("rows"),
});

/**
 * GET app/activity: what people and their agents did, newest first. `entity` + `entity_id` for one record's
 * timeline. A private row shows only to its person, its actor and team managers, and a row in a space only to
 * people who reach that space.
 */
export const listActivity = query({
  apiGroup: appGroup, auth: user,
  name: "app/activity", verb: "GET",
  description: "The activity feed, one record's timeline (entity + entity_id), or what one member did (by).",
  input: { entity: input.text(), entity_id: input.int(), page: input.int(), per_page: input.int(), by: input.int() },
  stack: [
    ...rbac.signedIn(),
    ...bindBrowser(),
    s.function.run({ fn: activityPage, as: "rows", input: { actor_id: auth("id"), browser: ref("browser"), entity: inp("entity"), entity_id: inp("entity_id"), page: inp("page"), size: inp("per_page"), by: inp("by") } }),
  ],
  response: ref("rows"),
  responseShape: {} as { items: InferRow<typeof activity>[]; curPage: number; nextPage: number | null; prevPage: number | null; itemsTotal: number; pageTotal: number },
});

/**
 * GET app/people: everyone's id, name, role, kind and status. Pickers offer the active rows, and old work finds a
 * former member's name here. A guest sees only the people who share a space with them.
 */
export const listPeople = query({
  apiGroup: appGroup, auth: user,
  name: "app/people", verb: "GET",
  description: "Every member, past and present: id, name, role, kind and status.",
  stack: [
    ...rbac.signedIn(),
    s.conditional({
      when: expr(ref("me.role"), "=", c.text("guest")),
      then: [
        reachOf(auth("id")),
        s.db.query({ table: space_member, where: cmp(col("space_id"), "in", ref("reach.space_ids")), output: ["user_id"], as: "neighbours" }),
        s.array.map({ source: ref("neighbours"), as: "neighbour_ids", transform: ref("$this.user_id") }),
        s.db.query({ table: user, where: or(cmp(col("id"), "in", ref("neighbour_ids")), expr(col("id"), "=", auth("id"))), sort: [{ sortBy: "name", dir: "asc" }], output: ["id", "name", "role", "kind", "status"], paging: { per_page: 500, metadata: false }, as: "rows" }),
      ],
      else: [s.db.query({ table: user, sort: [{ sortBy: "name", dir: "asc" }], output: ["id", "name", "role", "kind", "status"], paging: { per_page: 500, metadata: false }, as: "rows" })],
    }),
  ],
  response: ref("rows"),
  responseShape: [] as { id: number; name: string; role: string; kind: "human" | "agent"; status: "active" | "disabled" | "removed" }[],
});


export const baseQueries = [getSettings, updateSettings, listNotifications, unreadNotifications, readNotification, clearNotification, readAllNotifications, listActivity, listPeople];

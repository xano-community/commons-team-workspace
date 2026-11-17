// Workflow tests for the access rule, spaces and the guest walk. Each makes its own rows: a test run starts with an
// empty database. Sockets, kicks and the MCP key path need a live connection, so they're proven over HTTP and WebSocket.
import { c, cmp, col, fl, obj, ref, s, withFilters, workflowTest, type Value } from "@xano/sdk";
import { agent } from "../agent.js";
import { activity, notification, workspace_setting } from "../base/tables.js";
import { getSettings, listActivity, listPeople } from "../base/queries.js";
import { auth_setup } from "../query/authentication/auth_setup_POST.js";
import { auth_signup } from "../query/authentication/auth_signup_POST.js";
import { listInvites } from "../query/authentication/links.js";
import { endDemoPreview, removeMemberRoute } from "../query/members.js";
import {
  addSpaceMemberRoute, createSpaceRoute, getConversation, getSpace, joinSpaceRoute, listConversations, listSpaceMembers, listSpaces,
  removeSpaceMemberRoute, setSpaceRoleRoute, updateSpaceRoute,
} from "../query/spaces.js";
import { accessRule, canCreate, canJoinRoom, canManage, canReach, reachFn } from "../function/access/reach.js";
import { GUEST_HISTORY_WARNING, removeSpaceMember } from "../function/access/spaces.js";
import { runSetup } from "../function/members/setup.js";
import { PERSON_EXTRAS } from "../function/members/gate.js";
import { user } from "../table/user.js";
import { space } from "../table/spaces/space.js";
import { space_member } from "../table/spaces/space_member.js";
import { conversation } from "../table/messaging/conversation.js";
import { conversation_member } from "../table/messaging/conversation_member.js";

// A test reads rows it just made, and a missing row should fail that test: the null-safety warning doesn't apply.
export const rowsTest: typeof workflowTest = (def) => workflowTest({ ...def, diagnostics: { allow: ["stack.drill-maybe-null"] } });

export const PASSWORD = "Access-test-1";
export const NOT_FOUND = c.text("Not found.");

export const person = (key: string, role = "member") => s.db.add({ table: user, as: key, row: {
  name: c.text(`Test ${key}`), email: c.text(`${key}@access-test.example`), password: c.text(PASSWORD), role: c.text(role),
  kind: c.text("human"), status: c.text("active"), is_demo: c.bool(false),
} });
const agentRow = (key: string, sponsor: string) => s.db.add({ table: user, as: key, row: {
  name: c.text(`Agent ${key}`), email: c.null(), password: c.null(), role: c.text("agent"), kind: c.text("agent"), sponsor_id: ref(`${sponsor}.id`), status: c.text("active"), is_demo: c.bool(false),
} });
export const settings = () => s.db.add({ table: workspace_setting, as: "settings", row: {
  singleton: c.int(1), name: c.text("Test"), timezone: c.text("UTC"), week_start: c.text("monday"), demo_mode: c.bool(false), signup_open: c.bool(false),
} });
export const makeSpace = (key: string, visibility = "private", guests = false) => s.db.add({ table: space, as: key, row: { name: c.text(`Space ${key}`), visibility: c.text(visibility), guests_can_create: c.bool(guests), is_demo: c.bool(false) } });
/** A row with no matching user.space_ids: the routes own that. For the rule, which reads only space_member. */
export const joined = (spaceKey: string, who: string, role = "member") => s.db.add({ table: space_member, as: `${who}_in_${spaceKey}`, row: { space_id: ref(`${spaceKey}.id`), user_id: ref(`${who}.id`), role: c.text(role) } });
export const dm = (key: string, ...members: string[]) => [
  s.db.add({ table: conversation, as: key, row: { kind: c.text("dm"), name: c.text(`DM ${key}`), is_demo: c.bool(false) } }),
  ...members.map((m) => s.db.add({ table: conversation_member, as: `${m}_in_${key}`, row: { conversation_id: ref(`${key}.id`), user_id: ref(`${m}.id`) } })),
];
export const channel = (key: string, spaceKey: string) => s.db.add({ table: conversation, as: key, row: { space_id: ref(`${spaceKey}.id`), kind: c.text("channel"), name: c.text(`Channel ${key}`), is_demo: c.bool(false) } });

export const personToken = (row: string, as: string) => s.security.create_auth_token({ table: user, id: ref(`${row}.id`), extras: obj({ kind: c.text(PERSON_EXTRAS.kind) }), expiration: c.int(3600), as });
/** What an MCP sign-in holds: a token on the user table with no person marker. */
const unmarkedToken = (row: string, as: string) => s.security.create_auth_token({ table: user, id: ref(`${row}.id`), extras: c.obj({}), expiration: c.int(3600), as });
export const bearer = (tokenVar: string) => ({ Authorization: ref(tokenVar) });
const reach = (who: string, type: string, id: Value, as: string, browser = true) => s.function.call({ fn: canReach, as, input: { actor_id: ref(`${who}.id`), browser: c.bool(browser), type: c.text(type), id } });
export const yes = (name: string) => s.expect.to_be_true({ expr: ref(name) });
export const no = (name: string) => s.expect.to_be_false({ expr: ref(name) });
export const seesText = (name: string, text: string) => s.expect.to_contain({ expr: withFilters(ref(name), fl.json_encode()), value: c.text(text) });
export const missesText = (name: string, text: string) => s.expect.to_be_false({ expr: withFilters(withFilters(ref(name), fl.json_encode()), fl.contains(c.text(text))) });
export const notFound = (name: string) => s.expect.to_equal({ expr: ref(`${name}.message`), value: NOT_FOUND });
/** user.space_ids holds exactly what space_member says for this row. */
const inStep = (who: Value, tag: string) => [
  s.db.query({ table: space_member, where: cmp(col("user_id"), "=", who), sort: [{ sortBy: "space_id", dir: "asc" }], output: ["space_id"], as: `rows_${tag}` }),
  s.array.map({ source: ref(`rows_${tag}`), as: `ids_${tag}`, transform: ref("$this.space_id") }),
  s.db.get({ table: user, fieldValue: who, output: ["space_ids"], as: `copy_${tag}` }),
  s.expect.to_equal({ expr: withFilters(ref(`copy_${tag}.space_ids`), fl.json_encode()), value: withFilters(ref(`ids_${tag}`), fl.json_encode()) }),
];
/** The same, and pinned to a count, so an empty pair can't pass by accident. */
const holds = (who: Value, count: number, tag: string) => [
  ...inStep(who, tag),
  s.expect.to_equal({ expr: withFilters(ref(`ids_${tag}`), fl.count()), value: c.int(count) }),
];
const addBody = (spaceRef: string, who: string, extra: Record<string, Value> = {}) => ({ id: ref(spaceRef), user_id: ref(`${who}.id`), ...extra });

/** A doc with no space, created on a company, as the rule sees it. */
const crmDoc = (who: string, browser: boolean, as: string) => [
  s.function.call({ fn: accessRule, as, input: { actor_id: ref(`${who}.id`), browser: c.bool(browser), space_id: c.int(0), dm_id: c.int(0), crm_record: c.bool(true) } }),
];
const creating = (who: string, spaceKey: string, as: string) => [
  s.function.call({ fn: canCreate, as, input: { actor_id: ref(`${who}.id`), browser: c.bool(true), space_id: ref(`${spaceKey}.id`) } }),
];

export const accessTests = [
  workflowTest({
    name: "access: an admin reads a private space, and an agent outside it gets not found",
    stack: [
      settings(), person("admin", "admin"), person("owner"), agentRow("scout", "admin"), makeSpace("secret"), joined("secret", "owner", "manager"),
      channel("general", "secret"),
      personToken("admin", "admin_token"),
      s.api.call({ api: getSpace, headers: bearer("admin_token"), input: { id: ref("secret.id") }, as: "read" }),
      s.expect.to_equal({ expr: ref("read.space.id"), value: ref("secret.id") }),
      s.expect.to_be_true({ expr: ref("read.can_manage") }),
      s.api.call({ api: getConversation, headers: bearer("admin_token"), input: { id: ref("general.id") }, as: "read_channel" }),
      s.expect.to_equal({ expr: ref("read_channel.id"), value: ref("general.id") }),
      reach("scout", "space", ref("secret.id"), "agent_browser", true), no("agent_browser"),
      reach("scout", "space", ref("secret.id"), "agent_key", false), no("agent_key"),
      reach("scout", "conversation", ref("general.id"), "agent_channel", false), no("agent_channel"),
      s.function.call({ fn: reachFn, as: "agent_reach", input: { actor_id: ref("scout.id"), browser: c.bool(false) } }),
      s.expect.to_be_empty({ expr: ref("agent_reach.space_ids") }),
      joined("secret", "scout"),
      reach("scout", "space", ref("secret.id"), "agent_joined", false), yes("agent_joined"),
    ],
  }),
  workflowTest({
    name: "access: an agent holding an admin's role still passes only by joining",
    description: "Role never stands in for membership, even on a row an edit gave the admin role and a browser flag.",
    stack: [
      settings(), person("admin", "admin"), makeSpace("secret"),
      s.db.add({ table: user, as: "robot", row: { name: c.text("Robot"), email: c.null(), password: c.null(), role: c.text("admin"), kind: c.text("agent"), status: c.text("active"), is_demo: c.bool(false) } }),
      reach("robot", "space", ref("secret.id"), "as_browser", true), no("as_browser"),
      s.function.call({ fn: canManage, as: "manages", input: { actor_id: ref("robot.id"), browser: c.bool(true), space_id: ref("secret.id") } }), no("manages"),
    ],
  }),
  workflowTest({
    name: "access: an admin outside a DM gets not found, in reads and in lists",
    stack: [
      settings(), person("admin", "admin"), person("ana"), person("ben"), ...dm("chat", "ana", "ben"),
      makeSpace("open_one", "open"), channel("general", "open_one"),
      personToken("admin", "admin_token"), personToken("ana", "ana_token"),
      s.api.call({ api: getConversation, headers: bearer("admin_token"), input: { id: ref("chat.id") }, as: "admin_read" }),
      notFound("admin_read"),
      s.api.call({ api: listConversations, headers: bearer("admin_token"), as: "admin_list" }),
      missesText("admin_list", "DM chat"), seesText("admin_list", "Channel general"),
      s.function.call({ fn: reachFn, as: "admin_reach", input: { actor_id: ref("admin.id"), browser: c.bool(true) } }),
      s.expect.to_be_empty({ expr: ref("admin_reach.dm_ids") }),
      reach("admin", "conversation", ref("chat.id"), "admin_rule", true), no("admin_rule"),
      s.api.call({ api: getConversation, headers: bearer("ana_token"), input: { id: ref("chat.id") }, as: "ana_read" }),
      s.expect.to_equal({ expr: ref("ana_read.id"), value: ref("chat.id") }),
      s.api.call({ api: listConversations, headers: bearer("ana_token"), as: "ana_list" }),
      seesText("ana_list", "DM chat"), missesText("ana_list", "Channel general"),
      s.api.call({ api: getConversation, headers: bearer("ana_token"), input: { id: c.int(2147483647) }, as: "missing" }),
      s.expect.to_equal({ expr: withFilters(ref("missing"), fl.json_encode()), value: withFilters(ref("admin_read"), fl.json_encode()) }),
    ],
  }),
  rowsTest({
    name: "access: an admin's own key or sign-in reaches only their joined spaces and DMs",
    stack: [
      settings(), person("admin", "admin"), person("owner"), makeSpace("mine"), makeSpace("theirs"), joined("mine", "admin", "manager"), joined("theirs", "owner", "manager"),
      channel("theirs_general", "theirs"), ...dm("chat", "admin", "owner"),
      s.function.call({ fn: agent.connectFn, input: { user_id: ref("admin.id"), name: c.text("Laptop"), scope: c.text("read"), days: c.int(1) }, as: "key" }),
      s.db.get({ table: agent.agent_connection, fieldValue: ref("key.connection.id"), output: ["user_id"], as: "conn" }),
      s.function.call({ fn: reachFn, as: "key_reach", input: { actor_id: ref("conn.user_id"), browser: c.bool(false) } }),
      s.expect.to_equal({ expr: withFilters(ref("key_reach.space_ids"), fl.count()), value: c.int(1) }),
      s.expect.to_equal({ expr: withFilters(ref("key_reach.space_ids"), fl.first()), value: ref("mine.id") }),
      s.expect.to_equal({ expr: withFilters(ref("key_reach.dm_ids"), fl.first()), value: ref("chat.id") }),
      reach("admin", "space", ref("mine.id"), "key_mine", false), yes("key_mine"),
      reach("admin", "space", ref("theirs.id"), "key_theirs", false), no("key_theirs"),
      reach("admin", "conversation", ref("theirs_general.id"), "key_channel", false), no("key_channel"),
      reach("admin", "conversation", ref("chat.id"), "key_dm", false), yes("key_dm"),
      unmarkedToken("admin", "signin_token"), personToken("admin", "browser_token"),
      s.api.call({ api: getSpace, headers: bearer("signin_token"), input: { id: ref("theirs.id") }, as: "signin_theirs" }),
      notFound("signin_theirs"),
      s.api.call({ api: getSpace, headers: bearer("signin_token"), input: { id: ref("mine.id") }, as: "signin_mine" }),
      s.expect.to_equal({ expr: ref("signin_mine.space.id"), value: ref("mine.id") }),
      s.expect.to_be_false({ expr: ref("signin_mine.can_manage") }),
      s.api.call({ api: listSpaces, headers: bearer("signin_token"), as: "signin_list" }),
      missesText("signin_list", "Space theirs"),
      s.api.call({ api: addSpaceMemberRoute, headers: bearer("signin_token"), input: addBody("mine.id", "owner"), as: "signin_add" }),
      s.expect.to_contain({ expr: ref("signin_add.message"), value: c.text("managers") }),
      s.api.call({ api: getSpace, headers: bearer("browser_token"), input: { id: ref("theirs.id") }, as: "browser_theirs" }),
      s.expect.to_equal({ expr: ref("browser_theirs.space.id"), value: ref("theirs.id") }),
    ],
  }),
  workflowTest({
    name: "access: a removed member loses the space on their next call, and the manager is told",
    stack: [
      settings(), person("admin", "admin"), person("boss"), person("leaver"), personToken("admin", "admin_token"), personToken("boss", "boss_token"), personToken("leaver", "leaver_token"),
      s.api.call({ api: createSpaceRoute, headers: bearer("boss_token"), input: { name: c.text("Project"), visibility: c.text("private") }, as: "made" }),
      s.api.call({ api: addSpaceMemberRoute, headers: bearer("boss_token"), input: addBody("made.id", "leaver"), as: "added" }),
      s.expect.to_be_true({ expr: ref("added.added") }),
      s.api.call({ api: getSpace, headers: bearer("leaver_token"), input: { id: ref("made.id") }, as: "before" }),
      s.expect.to_equal({ expr: ref("before.space.id"), value: ref("made.id") }),
      s.api.call({ api: removeSpaceMemberRoute, headers: bearer("admin_token"), input: addBody("made.id", "leaver"), as: "removed" }),
      s.expect.to_be_true({ expr: ref("removed.removed") }),
      // A test has no realtime server, so a kick can't land here. frontend/scripts/files-check.mjs reads `kick_failed` from a real removal.
      s.api.call({ api: getSpace, headers: bearer("leaver_token"), input: { id: ref("made.id") }, as: "after" }),
      notFound("after"),
      s.api.call({ api: listSpaces, headers: bearer("leaver_token"), as: "list" }),
      missesText("list", "Project"),
      s.api.call({ api: listActivity, headers: bearer("leaver_token"), as: "feed" }),
      missesText("feed", "Project"),
      s.function.call({ fn: canJoinRoom, as: "room", input: { actor_id: ref("leaver.id"), browser: c.bool(true), room: withFilters(c.text("space-"), fl.concat(ref("made.id"))) } }), no("room"),
      s.db.query({ table: notification, where: cmp(col("user_id"), "=", ref("boss.id")), output: ["title"], as: "boss_told" }),
      seesText("boss_told", "Test leaver left a space"),
    ],
  }),
  workflowTest({
    name: "access: a member who isn't a manager can't remove anyone, and an outsider can't tell the space exists",
    stack: [
      settings(), person("boss"), person("plain"), person("outsider"), makeSpace("work"), joined("work", "boss", "manager"), joined("work", "plain"),
      personToken("plain", "plain_token"), personToken("outsider", "outsider_token"),
      s.api.call({ api: removeSpaceMemberRoute, headers: bearer("plain_token"), input: addBody("work.id", "boss"), as: "by_member" }),
      s.expect.to_contain({ expr: ref("by_member.message"), value: c.text("managers") }),
      s.api.call({ api: removeSpaceMemberRoute, headers: bearer("outsider_token"), input: addBody("work.id", "plain"), as: "by_outsider" }),
      notFound("by_outsider"),
      s.api.call({ api: joinSpaceRoute, headers: bearer("outsider_token"), input: { id: ref("work.id") }, as: "joining_private" }),
      notFound("joining_private"),
      s.api.call({ api: listSpaceMembers, headers: bearer("outsider_token"), input: { id: ref("work.id") }, as: "their_members" }),
      notFound("their_members"),
      s.function.call({ fn: canJoinRoom, as: "bad_type", input: { actor_id: ref("plain.id"), browser: c.bool(true), room: c.text("board") } }), no("bad_type"),
      s.function.call({ fn: canJoinRoom, as: "bad_id", input: { actor_id: ref("plain.id"), browser: c.bool(true), room: withFilters(c.text("space-"), fl.concat(ref("work.id")), fl.concat(c.text("x"))) } }), no("bad_id"),
      s.function.call({ fn: canJoinRoom, as: "good", input: { actor_id: ref("plain.id"), browser: c.bool(true), room: withFilters(c.text("space-"), fl.concat(ref("work.id"))) } }), yes("good"),
    ],
  }),
  workflowTest({
    name: "access: a guest walks every door and reaches only their spaces and people",
    stack: [
      settings(), person("admin", "admin"), person("neighbour"), person("stranger"), person("riley", "guest"),
      makeSpace("client"), makeSpace("internal"), makeSpace("lobby", "open"),
      joined("client", "riley"), joined("client", "neighbour", "manager"), joined("internal", "stranger", "manager"),
      s.db.add({ table: activity, as: "workspace_row", row: { actor_id: ref("admin.id"), actor_name: c.text("Admin"), verb: c.text("updated"), entity: c.text("settings"), entity_id: c.int(1), title: c.text("workspace row"), space_id: c.int(0) } }),
      s.db.add({ table: activity, as: "client_row", row: { actor_id: ref("neighbour.id"), actor_name: c.text("N"), verb: c.text("updated"), entity: c.text("space"), entity_id: ref("client.id"), title: c.text("client row"), space_id: ref("client.id") } }),
      s.db.add({ table: activity, as: "internal_row", row: { actor_id: ref("stranger.id"), actor_name: c.text("S"), verb: c.text("updated"), entity: c.text("space"), entity_id: ref("internal.id"), title: c.text("internal row"), space_id: ref("internal.id") } }),
      personToken("riley", "token"),
      s.api.call({ api: getSettings, headers: bearer("token"), as: "settings_read" }),
      s.expect.to_contain({ expr: ref("settings_read.message"), value: c.text("Guests") }),
      s.api.call({ api: listInvites, headers: bearer("token"), as: "team_invites" }),
      s.expect.to_contain({ expr: ref("team_invites.message"), value: c.text("manage the team") }),
      s.api.call({ api: endDemoPreview, headers: bearer("token"), as: "team_accounts" }),
      s.expect.to_contain({ expr: ref("team_accounts.message"), value: c.text("manage the team") }),
      s.api.call({ api: removeMemberRoute, headers: bearer("token"), input: { id: ref("neighbour.id"), new_sponsor_id: c.int(0) }, as: "team_remove" }),
      s.expect.to_contain({ expr: ref("team_remove.message"), value: c.text("manage the team") }),
      s.api.call({ api: createSpaceRoute, headers: bearer("token"), input: { name: c.text("Mine"), visibility: c.text("open") }, as: "making" }),
      s.expect.to_contain({ expr: ref("making.message"), value: c.text("Only members") }),
      s.api.call({ api: joinSpaceRoute, headers: bearer("token"), input: { id: ref("lobby.id") }, as: "joining" }),
      notFound("joining"),
      s.api.call({ api: listSpaces, headers: bearer("token"), as: "spaces" }),
      seesText("spaces", "Space client"), missesText("spaces", "Space internal"), missesText("spaces", "Space lobby"),
      s.api.call({ api: getSpace, headers: bearer("token"), input: { id: ref("internal.id") }, as: "internal_read" }),
      notFound("internal_read"),
      s.api.call({ api: listPeople, headers: bearer("token"), as: "people" }),
      seesText("people", "Test neighbour"), seesText("people", "Test riley"), missesText("people", "Test stranger"), missesText("people", "Test admin"),
      s.api.call({ api: listActivity, headers: bearer("token"), as: "feed" }),
      seesText("feed", "client row"), missesText("feed", "workspace row"), missesText("feed", "internal row"),
      s.function.call({ fn: accessRule, as: "crm", input: { actor_id: ref("riley.id"), browser: c.bool(true), space_id: c.int(0), dm_id: c.int(0), crm_record: c.bool(true) } }), no("crm"),
    ],
  }),
  workflowTest({
    name: "access: a doc with no space, created on a company, follows crm.read",
    stack: [
      settings(), person("admin", "admin"), person("member"), person("riley", "guest"), agentRow("scout", "admin"),
      ...crmDoc("admin", true, "admin_browser"), yes("admin_browser"),
      ...crmDoc("admin", false, "admin_key"), yes("admin_key"),
      ...crmDoc("member", true, "member_browser"), yes("member_browser"),
      ...crmDoc("member", false, "member_key"), yes("member_key"),
      ...crmDoc("scout", false, "agent_key"), yes("agent_key"),
      ...crmDoc("riley", true, "guest_browser"), no("guest_browser"),
      ...crmDoc("riley", false, "guest_key"), no("guest_key"),
      s.db.patch({ table: user, fieldValue: ref("member.id"), data: obj({ status: c.text("removed") }) }),
      ...crmDoc("member", true, "gone"), no("gone"),
    ],
  }),
  workflowTest({
    name: "access: a private-space doc linked to a company stays not found for a non-member with crm.read",
    stack: [
      settings(), person("admin", "admin"), person("member"), person("insider"), makeSpace("secret"), joined("secret", "insider"),
      s.function.call({ fn: accessRule, as: "outsider", input: { actor_id: ref("member.id"), browser: c.bool(true), space_id: ref("secret.id"), dm_id: c.int(0), crm_record: c.bool(true) } }), no("outsider"),
      s.function.call({ fn: accessRule, as: "insider_reach", input: { actor_id: ref("insider.id"), browser: c.bool(true), space_id: ref("secret.id"), dm_id: c.int(0), crm_record: c.bool(true) } }), yes("insider_reach"),
      s.function.call({ fn: accessRule, as: "admin_reach", input: { actor_id: ref("admin.id"), browser: c.bool(true), space_id: ref("secret.id"), dm_id: c.int(0), crm_record: c.bool(true) } }), yes("admin_reach"),
    ],
  }),
  workflowTest({
    name: "access: a guest creates tasks and docs only where the space allows it",
    stack: [
      settings(), person("boss"), person("riley", "guest"), person("outsider"), makeSpace("closed"), makeSpace("welcoming", "private", true),
      joined("closed", "boss", "manager"), joined("closed", "riley"), joined("welcoming", "boss", "manager"), joined("welcoming", "riley"),
      ...creating("riley", "closed", "guest_closed"), no("guest_closed"),
      ...creating("riley", "welcoming", "guest_open"), yes("guest_open"),
      ...creating("boss", "closed", "member_closed"), yes("member_closed"),
      ...creating("outsider", "welcoming", "outsider_open"), no("outsider_open"),
      personToken("boss", "boss_token"),
      s.api.call({ api: updateSpaceRoute, headers: bearer("boss_token"), input: { id: ref("closed.id"), name: c.text("Closed"), visibility: c.text("private"), guests_can_create: c.bool(true), archived: c.bool(false) }, as: "turned_on" }),
      s.expect.to_be_true({ expr: ref("turned_on.guests_can_create") }),
      ...creating("riley", "closed", "guest_after"), yes("guest_after"),
      s.api.call({ api: updateSpaceRoute, headers: bearer("boss_token"), input: { id: ref("closed.id"), name: c.text("Closed"), visibility: c.text("private"), guests_can_create: c.bool(true), archived: c.bool(true) }, as: "archived" }),
      s.expect.to_not_be_null({ expr: ref("archived.archived_at") }),
      ...creating("boss", "closed", "after_archive"), no("after_archive"),
    ],
  }),
  workflowTest({
    name: "access: the last manager can't leave without handing over",
    stack: [
      settings(), person("boss"), person("next"), personToken("boss", "token"), personToken("next", "next_token"),
      s.api.call({ api: createSpaceRoute, headers: bearer("token"), input: { name: c.text("Project"), visibility: c.text("open") }, as: "made" }),
      s.api.call({ api: removeSpaceMemberRoute, headers: bearer("token"), input: addBody("made.id", "boss"), as: "leaving" }),
      s.expect.to_contain({ expr: ref("leaving.message"), value: c.text("last manager") }),
      s.api.call({ api: setSpaceRoleRoute, headers: bearer("token"), input: addBody("made.id", "boss", { role: c.text("member") }), as: "stepping_down" }),
      s.expect.to_contain({ expr: ref("stepping_down.message"), value: c.text("last manager") }),
      s.api.call({ api: joinSpaceRoute, headers: bearer("next_token"), input: { id: ref("made.id") }, as: "joined_in" }),
      s.expect.to_be_true({ expr: ref("joined_in.joined") }),
      s.api.call({ api: setSpaceRoleRoute, headers: bearer("token"), input: addBody("made.id", "next", { role: c.text("manager") }), as: "handed" }),
      s.expect.to_equal({ expr: ref("handed.role"), value: c.text("manager") }),
      s.api.call({ api: removeSpaceMemberRoute, headers: bearer("token"), input: addBody("made.id", "boss"), as: "left" }),
      s.expect.to_be_true({ expr: ref("left.removed") }),
      s.api.call({ api: getSpace, headers: bearer("token"), input: { id: ref("made.id") }, as: "after" }),
      notFound("after"),
    ],
  }),
  workflowTest({
    name: "access: an agent or a guest can't be made a manager",
    stack: [
      settings(), person("boss"), person("riley", "guest"), agentRow("scout", "boss"), personToken("boss", "token"),
      s.api.call({ api: createSpaceRoute, headers: bearer("token"), input: { name: c.text("Project"), visibility: c.text("private") }, as: "made" }),
      s.api.call({ api: addSpaceMemberRoute, headers: bearer("token"), input: addBody("made.id", "scout"), as: "added_agent" }),
      s.expect.to_be_true({ expr: ref("added_agent.added") }),
      s.api.call({ api: setSpaceRoleRoute, headers: bearer("token"), input: addBody("made.id", "scout", { role: c.text("manager") }), as: "to_agent" }),
      s.expect.to_contain({ expr: ref("to_agent.message"), value: c.text("Only a member") }),
    ],
  }),
  rowsTest({
    name: "access: adding a guest shows the history warning and changes nothing until it's confirmed",
    stack: [
      settings(), person("boss"), person("riley", "guest"), person("plain"), personToken("boss", "token"),
      s.api.call({ api: createSpaceRoute, headers: bearer("token"), input: { name: c.text("Project"), visibility: c.text("private") }, as: "made" }),
      s.api.call({ api: addSpaceMemberRoute, headers: bearer("token"), input: addBody("made.id", "riley"), as: "first" }),
      s.expect.to_be_false({ expr: ref("first.added") }),
      s.expect.to_equal({ expr: ref("first.warning"), value: c.text(GUEST_HISTORY_WARNING) }),
      ...holds(ref("riley.id"), 0, "unconfirmed"),
      s.api.call({ api: addSpaceMemberRoute, headers: bearer("token"), input: addBody("made.id", "riley", { history_ok: c.bool(true) }), as: "second" }),
      s.expect.to_be_true({ expr: ref("second.added") }),
      s.expect.to_be_null({ expr: ref("second.warning") }),
      ...holds(ref("riley.id"), 1, "confirmed"),
      s.api.call({ api: addSpaceMemberRoute, headers: bearer("token"), input: addBody("made.id", "plain"), as: "no_warning" }),
      s.expect.to_be_true({ expr: ref("no_warning.added") }),
      s.expect.to_be_null({ expr: ref("no_warning.warning") }),
    ],
  }),
  rowsTest({
    name: "access: user.space_ids stays in step with space_member through every change",
    stack: [
      settings(), person("admin", "admin"), person("boss"), person("joiner"), person("leaver"), personToken("admin", "admin_token"), personToken("boss", "boss_token"), personToken("joiner", "joiner_token"), personToken("leaver", "leaver_token"),
      ...holds(ref("joiner.id"), 0, "fresh"),
      s.api.call({ api: createSpaceRoute, headers: bearer("boss_token"), input: { name: c.text("One"), visibility: c.text("open") }, as: "one" }),
      s.api.call({ api: createSpaceRoute, headers: bearer("boss_token"), input: { name: c.text("Two"), visibility: c.text("private") }, as: "two" }),
      ...holds(ref("boss.id"), 2, "created"),
      s.api.call({ api: joinSpaceRoute, headers: bearer("joiner_token"), input: { id: ref("one.id") }, as: "self_join" }),
      ...holds(ref("joiner.id"), 1, "joined"),
      s.api.call({ api: joinSpaceRoute, headers: bearer("joiner_token"), input: { id: ref("one.id") }, as: "self_join_again" }),
      ...holds(ref("joiner.id"), 1, "joined_twice"),
      s.api.call({ api: addSpaceMemberRoute, headers: bearer("boss_token"), input: addBody("two.id", "joiner"), as: "added" }),
      ...holds(ref("joiner.id"), 2, "added"),
      s.api.call({ api: addSpaceMemberRoute, headers: bearer("boss_token"), input: addBody("two.id", "joiner"), as: "added_again" }),
      ...holds(ref("joiner.id"), 2, "added_twice"),
      s.db.query({ table: notification, where: cmp(col("user_id"), "=", ref("joiner.id")), returnType: "count", as: "told" }),
      s.expect.to_equal({ expr: ref("told"), value: c.int(1) }),
      s.api.call({ api: setSpaceRoleRoute, headers: bearer("boss_token"), input: addBody("two.id", "joiner", { role: c.text("manager") }), as: "promoted" }),
      ...holds(ref("joiner.id"), 2, "promoted"),
      s.api.call({ api: removeSpaceMemberRoute, headers: bearer("joiner_token"), input: addBody("one.id", "joiner"), as: "left" }),
      ...holds(ref("joiner.id"), 1, "left"),
      s.api.call({ api: addSpaceMemberRoute, headers: bearer("boss_token"), input: addBody("two.id", "leaver"), as: "leaver_added" }),
      s.api.call({ api: addSpaceMemberRoute, headers: bearer("boss_token"), input: addBody("one.id", "leaver"), as: "leaver_added_two" }),
      ...holds(ref("leaver.id"), 2, "leaver_in"),
      s.api.call({ api: removeMemberRoute, headers: bearer("admin_token"), input: { id: ref("leaver.id"), new_sponsor_id: c.int(0) }, as: "offboarded" }),
      s.expect.to_equal({ expr: ref("offboarded.status"), value: c.text("removed") }),
      ...holds(ref("leaver.id"), 0, "offboarded"),
    ],
  }),
  rowsTest({
    name: "access: setup writes the first admin's space_ids",
    stack: [
      s.function.call({ fn: runSetup, as: "made", input: { submitted_token: c.text("t"), expected_token: c.text("t"), workspace_name: c.text("Acme"), name: c.text("First"), email: c.text("first@access-test.example"), password: c.text(PASSWORD) } }),
      ...holds(ref("made.user_id"), 1, "setup"),
    ],
  }),
  rowsTest({
    name: "access: a refused removal changes neither space_member nor space_ids",
    stack: [
      settings(), person("boss"), personToken("boss", "token"),
      s.api.call({ api: createSpaceRoute, headers: bearer("token"), input: { name: c.text("Project"), visibility: c.text("open") }, as: "made" }),
      s.function.call({ fn: removeSpaceMember, as: "refused", input: { actor_id: ref("boss.id"), browser: c.bool(true), space_id: ref("made.id"), user_id: ref("boss.id") } }),
      s.expect.to_contain({ expr: ref("refused.message"), value: c.text("last manager") }),
      ...holds(ref("boss.id"), 1, "refused"),
    ],
  }),
  workflowTest({
    name: "access: an empty reach lists nothing, and open spaces show without their contents",
    stack: [
      settings(), person("boss"), person("loner"), makeSpace("lobby", "open"), makeSpace("secret"), joined("lobby", "boss", "manager"), channel("lobby_general", "lobby"),
      personToken("loner", "token"), unmarkedToken("loner", "key_token"),
      s.api.call({ api: listConversations, headers: bearer("token"), as: "nothing" }),
      s.expect.to_be_empty({ expr: ref("nothing") }),
      s.api.call({ api: listSpaces, headers: bearer("token"), as: "offered" }),
      seesText("offered", "Space lobby"), missesText("offered", "Space secret"),
      s.api.call({ api: getSpace, headers: bearer("token"), input: { id: ref("lobby.id") }, as: "contents" }),
      notFound("contents"),
      s.api.call({ api: listSpaces, headers: bearer("key_token"), as: "key_list" }),
      missesText("key_list", "Space lobby"),
      s.api.call({ api: joinSpaceRoute, headers: bearer("key_token"), input: { id: ref("lobby.id") }, as: "key_join" }),
      notFound("key_join"),
    ],
  }),
  workflowTest({
    name: "access: auth/setup is the only way to set up, and sign-up can't reach it",
    stack: [
      s.expect.to_throw({ body: [s.api.call({ api: auth_setup, input: { setup_token: c.text(""), workspace_name: c.text("Acme"), name: c.text("First"), email: c.text("first@access-test.example"), password: c.text(PASSWORD) }, as: "blank" })], exception: c.text("setup_token") }),
      s.api.call({ api: auth_setup, input: { setup_token: c.text("a guess"), workspace_name: c.text("Acme"), name: c.text("First"), email: c.text("first@access-test.example"), password: c.text(PASSWORD) }, as: "unset" }),
      s.expect.to_not_be_defined({ expr: ref("unset.authToken") }),
      s.api.call({ api: auth_signup, input: { name: c.text("First"), email: c.text("first@access-test.example"), password: c.text(PASSWORD) }, as: "signup" }),
      s.expect.to_not_be_defined({ expr: ref("signup.authToken") }),
      s.db.query({ table: workspace_setting, returnType: "count", as: "rows" }),
      s.expect.to_equal({ expr: ref("rows"), value: c.int(0) }),
    ],
  }),
];

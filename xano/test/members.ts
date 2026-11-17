// Workflow tests for members, setup and the demo doors. Each makes its own rows: a test run starts with an empty
// database, which is also what proves the doors fail closed when the settings row is missing.
import { c, fl, obj, ref, s, withFilters, workflowTest } from "@xano/sdk";
import { agent } from "../agent.js";
import { access_link, demo_persona, workspace_setting } from "../base/tables.js";
import { listPeople } from "../base/queries.js";
import { auth_login } from "../query/authentication/auth_login_POST.js";
import { auth_me } from "../query/authentication/auth_me_GET.js";
import { auth_signup } from "../query/authentication/auth_signup_POST.js";
import { demoLogin, demoPersonas } from "../query/authentication/demo.js";
import { acceptLink, checkLink, createResetLink } from "../query/authentication/links.js";
import { changePassword } from "../query/authentication/profile.js";
import { endDemoRoute, removeMemberRoute } from "../query/members.js";
import { endDemo } from "../function/members/end_demo.js";
import { removeMember } from "../function/members/offboard.js";
import { runSetup } from "../function/members/setup.js";
import { PERSON_EXTRAS } from "../function/members/gate.js";
import { user } from "../table/user.js";
import { space } from "../table/spaces/space.js";
import { space_member } from "../table/spaces/space_member.js";
import { conversation } from "../table/messaging/conversation.js";

// A test reads rows it just made, and a missing row should fail that test: the null-safety warning doesn't apply.
const rowsTest: typeof workflowTest = (def) => workflowTest({ ...def, diagnostics: { allow: ["stack.drill-maybe-null"] } });

const FAR = Date.UTC(2099, 0, 1);
const PASSWORD = "Members-test-1";
/** The password the seed used to give every demo person. It must never sign anyone in. */
const OLD_DEMO_PASSWORD = "DemoPass123";
// A token and its SHA-256, so a test can hold what the app never stores.
const LINK = { token: "base-test-reset", hash: "2f01ac66df420f7620c1663868130b4f5301f075562d35f5a8046b71f6e61f9d" };

const person = (key: string, role = "member", extra: Record<string, ReturnType<typeof c.text> | ReturnType<typeof c.bool>> = {}) => s.db.add({ table: user, as: key, row: {
  name: c.text(`Test ${key}`), email: c.text(`${key}@members-test.example`), password: c.text(PASSWORD), role: c.text(role),
  kind: c.text("human"), status: c.text("active"), is_demo: c.bool(false), ...extra,
} });
const demoPerson = (key: string, role = "member") => s.db.add({ table: user, as: key, row: {
  name: c.text(`Demo ${key}`), email: c.text(`${key}@members-test.example`), password: c.null(), role: c.text(role),
  kind: c.text("human"), status: c.text("active"), is_demo: c.bool(true),
} });
const agentRow = (key: string, sponsor: ReturnType<typeof ref>) => s.db.add({ table: user, as: key, row: {
  name: c.text(`Agent ${key}`), email: c.null(), password: c.null(), role: c.text("agent"), kind: c.text("agent"), sponsor_id: sponsor, status: c.text("active"), is_demo: c.bool(false),
} });
const settings = (demo: boolean) => s.db.add({ table: workspace_setting, as: "settings", row: {
  singleton: c.int(1), name: c.text("Test"), timezone: c.text("UTC"), week_start: c.text("monday"), demo_mode: c.bool(demo), signup_open: c.bool(demo),
} });
const persona = (key: string) => s.db.add({ table: demo_persona, as: `persona_${key}`, row: { key: c.text(key), label: c.text(key), description: c.text(""), email: c.text(`${key}@members-test.example`) } });
const tokenFor = (row: string, as: string) => s.security.create_auth_token({ table: user, id: ref(`${row}.id`), extras: obj(Object.fromEntries(Object.entries(PERSON_EXTRAS).map(([k, v]) => [k, c.text(v)]))), expiration: c.int(3600), as });
const bearer = (tokenVar: string) => ({ Authorization: ref(tokenVar) });
const resetLink = (to: string, by: string) => s.db.add({ table: access_link, as: "link", row: {
  kind: c.text("reset"), email: c.text("nobody@members-test.example"), user_id: ref(`${to}.id`),
  token_hash: c.text(LINK.hash), expires_at: c.int(FAR), revoked: c.bool(false), created_by: ref(`${by}.id`),
} });

const setupInput = (submitted: string, expected: string, who = "first") => ({
  submitted_token: c.text(submitted), expected_token: c.text(expected), workspace_name: c.text("Acme"), name: c.text("First Admin"),
  email: c.text(`${who}@members-test.example`), password: c.text(PASSWORD),
});

export const memberTests = [
  workflowTest({
    name: "members: a missing settings row keeps demo sign-in and sign-up shut",
    stack: [
      demoPerson("avery", "admin"), persona("avery"),
      s.api.call({ api: demoLogin, input: { persona: c.text("avery") }, as: "demo" }),
      s.expect.to_not_be_defined({ expr: ref("demo.authToken") }),
      s.api.call({ api: demoPersonas, as: "personas" }),
      s.expect.to_be_empty({ expr: ref("personas") }),
      s.api.call({ api: auth_signup, input: { name: c.text("New"), email: c.text("new@members-test.example"), password: c.text(PASSWORD) }, as: "signup" }),
      s.expect.to_not_be_defined({ expr: ref("signup.authToken") }),
      s.db.get({ table: user, fieldName: "email", fieldValue: c.text("new@members-test.example"), as: "made" }),
      s.expect.to_be_null({ expr: ref("made") }),
    ],
  }),
  workflowTest({
    name: "members: the demo doors open only for active demo rows while demo mode is on",
    stack: [
      settings(true), demoPerson("avery", "admin"), persona("avery"), person("real"), persona("real"),
      s.api.call({ api: demoLogin, input: { persona: c.text("avery") }, as: "demo" }),
      s.expect.to_be_defined({ expr: ref("demo.authToken") }),
      s.api.call({ api: auth_me, headers: bearer("demo.authToken"), as: "me" }),
      s.expect.to_equal({ expr: ref("me.id"), value: ref("avery.id") }),
      s.api.call({ api: demoLogin, input: { persona: c.text("real") }, as: "not_demo" }),
      s.expect.to_not_be_defined({ expr: ref("not_demo.authToken") }),
      s.db.patch({ table: user, fieldValue: ref("avery.id"), data: obj({ status: c.text("disabled") }) }),
      s.api.call({ api: demoLogin, input: { persona: c.text("avery") }, as: "disabled" }),
      s.expect.to_not_be_defined({ expr: ref("disabled.authToken") }),
    ],
  }),
  workflowTest({
    name: "members: the old demo password and a null password are refused, not a 500",
    stack: [
      settings(true), demoPerson("avery", "admin"),
      s.api.call({ api: auth_login, input: { email: c.text("avery@members-test.example"), password: c.text(OLD_DEMO_PASSWORD) }, as: "old" }),
      s.expect.to_equal({ expr: ref("old.message"), value: c.text("Invalid Credentials.") }),
      s.expect.to_throw({ body: [s.api.call({ api: auth_login, input: { email: c.text("avery@members-test.example"), password: c.text("") }, as: "blank" })], exception: c.text("password") }),
      tokenFor("avery", "token"),
      s.api.call({ api: changePassword, headers: bearer("token"), input: { current_password: c.text(OLD_DEMO_PASSWORD), new_password: c.text("Brand-new-1") }, as: "changed" }),
      s.expect.to_contain({ expr: ref("changed.message"), value: c.text("no password") }),
    ],
  }),
  workflowTest({
    name: "members: login needs an email, an active row and a person",
    description: "A password added in a test never matches on login, so this proves the refusals. The same doors are proven with real passwords over HTTP.",
    stack: [
      person("gone", "member", { status: c.text("removed") }),
      s.api.call({ api: auth_login, input: { email: c.text("gone@members-test.example"), password: c.text(PASSWORD) }, as: "gone_login" }),
      s.expect.to_equal({ expr: ref("gone_login.message"), value: c.text("Invalid Credentials.") }),
      person("robot", "agent", { kind: c.text("agent") }),
      s.api.call({ api: auth_login, input: { email: c.text("robot@members-test.example"), password: c.text(PASSWORD) }, as: "robot_login" }),
      s.expect.to_equal({ expr: ref("robot_login.message"), value: c.text("Invalid Credentials.") }),
      s.db.add({ table: user, as: "no_email", row: { name: c.text("Nameless"), email: c.null(), password: c.null(), role: c.text("agent"), kind: c.text("agent"), status: c.text("active"), is_demo: c.bool(false) } }),
      s.expect.to_throw({ body: [s.api.call({ api: auth_login, input: { email: c.text(""), password: c.text("x") }, as: "empty" })], exception: c.text("email") }),
    ],
  }),
  workflowTest({
    name: "members: setup is refused with an empty SETUP_TOKEN, a wrong token, and a second time",
    stack: [
      s.function.call({ fn: runSetup, input: setupInput("", ""), as: "empty" }),
      s.expect.to_contain({ expr: ref("empty.message"), value: c.text("Setup is off") }),
      s.function.call({ fn: runSetup, input: setupInput("anything", ""), as: "unset" }),
      s.expect.to_contain({ expr: ref("unset.message"), value: c.text("Setup is off") }),
      s.function.call({ fn: runSetup, input: setupInput("wrong", "right-token"), as: "wrong" }),
      s.expect.to_contain({ expr: ref("wrong.message"), value: c.text("isn't right") }),
      s.db.query({ table: workspace_setting, returnType: "count", as: "rows" }),
      s.expect.to_equal({ expr: ref("rows"), value: c.int(0) }),
      s.function.call({ fn: runSetup, input: setupInput("right-token", "right-token"), as: "first" }),
      s.expect.to_be_defined({ expr: ref("first.user_id") }),
      s.function.call({ fn: runSetup, input: setupInput("right-token", "right-token", "second"), as: "second" }),
      s.expect.to_contain({ expr: ref("second.message"), value: c.text("already set up") }),
      s.db.query({ table: user, returnType: "count", as: "people" }),
      s.expect.to_equal({ expr: ref("people"), value: c.int(1) }),
    ],
  }),
  rowsTest({
    name: "members: setup makes the admin, closed settings, a default space and #general",
    stack: [
      s.function.call({ fn: runSetup, input: setupInput("right-token", "right-token"), as: "made" }),
      s.db.get({ table: user, fieldValue: ref("made.user_id"), as: "admin" }),
      s.expect.to_equal({ expr: ref("admin.role"), value: c.text("admin") }),
      s.expect.to_equal({ expr: ref("admin.kind"), value: c.text("human") }),
      s.db.get({ table: workspace_setting, fieldName: "singleton", fieldValue: c.int(1), as: "row" }),
      s.expect.to_equal({ expr: ref("row.name"), value: c.text("Acme") }),
      s.expect.to_be_false({ expr: ref("row.demo_mode") }),
      s.expect.to_be_false({ expr: ref("row.signup_open") }),
      s.db.get({ table: space_member, fieldName: "user_id", fieldValue: ref("admin.id"), as: "membership" }),
      s.db.get({ table: space, fieldValue: ref("membership.space_id"), as: "home" }),
      s.expect.to_equal({ expr: ref("home.name"), value: c.text("Acme") }),
      s.db.get({ table: conversation, fieldName: "space_id", fieldValue: ref("home.id"), as: "general" }),
      s.expect.to_equal({ expr: ref("general.name"), value: c.text("general") }),
    ],
  }),
  rowsTest({
    name: "members: a reset link for an agent is refused when made and when accepted",
    stack: [
      settings(false), person("admin", "admin"), agentRow("scout", ref("admin.id")),
      tokenFor("admin", "token"),
      s.api.call({ api: createResetLink, headers: bearer("token"), input: { id: ref("scout.id") }, as: "made" }),
      s.expect.to_not_be_defined({ expr: ref("made.token") }),
      resetLink("scout", "admin"),
      s.api.call({ api: checkLink, input: { token: c.text(LINK.token) }, as: "check" }),
      s.expect.to_not_be_defined({ expr: ref("check.kind") }),
      s.api.call({ api: acceptLink, input: { token: c.text(LINK.token), password: c.text(PASSWORD) }, as: "accepted" }),
      s.expect.to_not_be_defined({ expr: ref("accepted.authToken") }),
      s.db.get({ table: user, fieldValue: ref("scout.id"), output: ["id", "password"], as: "still" }),
      s.expect.to_be_null({ expr: ref("still.password") }),
      s.db.get({ table: access_link, fieldValue: ref("link.id"), as: "unspent" }),
      s.expect.to_be_null({ expr: ref("unspent.used_at") }),
    ],
  }),
  workflowTest({
    name: "members: a reset link is refused for a removed person and a demo person",
    stack: [
      settings(false), person("admin", "admin"), person("gone", "member", { status: c.text("removed") }), demoPerson("avery"),
      tokenFor("admin", "token"),
      s.api.call({ api: createResetLink, headers: bearer("token"), input: { id: ref("gone.id") }, as: "for_gone" }),
      s.expect.to_not_be_defined({ expr: ref("for_gone.token") }),
      s.api.call({ api: createResetLink, headers: bearer("token"), input: { id: ref("avery.id") }, as: "for_demo" }),
      s.expect.to_not_be_defined({ expr: ref("for_demo.token") }),
      resetLink("gone", "admin"),
      s.api.call({ api: acceptLink, input: { token: c.text(LINK.token), password: c.text(PASSWORD) }, as: "accepted" }),
      s.expect.to_not_be_defined({ expr: ref("accepted.authToken") }),
    ],
  }),
  workflowTest({
    name: "members: an invite dies with the person who sent it",
    stack: [
      settings(false), person("admin", "admin"), person("leaver", "admin"),
      s.db.add({ table: access_link, as: "link", row: {
        kind: c.text("invite"), email: c.text("joiner@members-test.example"), name: c.text("Jo"), role: c.text("member"),
        token_hash: c.text(LINK.hash), expires_at: c.int(FAR), revoked: c.bool(false), created_by: ref("leaver.id"),
      } }),
      s.db.patch({ table: user, fieldValue: ref("leaver.id"), data: obj({ status: c.text("removed") }) }),
      s.api.call({ api: acceptLink, input: { token: c.text(LINK.token), name: c.text("Jo"), password: c.text(PASSWORD) }, as: "accepted" }),
      s.expect.to_not_be_defined({ expr: ref("accepted.authToken") }),
      s.db.get({ table: user, fieldName: "email", fieldValue: c.text("joiner@members-test.example"), as: "joined" }),
      s.expect.to_be_null({ expr: ref("joined") }),
    ],
  }),
  rowsTest({
    name: "members: removing yourself or the last admin is refused",
    stack: [
      settings(false), person("admin", "admin"), person("member"),
      tokenFor("admin", "token"),
      s.api.call({ api: removeMemberRoute, headers: bearer("token"), input: { id: ref("admin.id") }, as: "self" }),
      s.expect.to_contain({ expr: ref("self.message"), value: c.text("can't remove yourself") }),
      s.function.call({ fn: removeMember, input: { actor_id: ref("member.id"), member_id: ref("admin.id"), new_sponsor_id: c.int(0) }, as: "last" }),
      s.expect.to_contain({ expr: ref("last.message"), value: c.text("last admin") }),
      s.db.get({ table: user, fieldValue: ref("admin.id"), as: "still" }),
      s.expect.to_equal({ expr: ref("still.status"), value: c.text("active") }),
    ],
  }),
  rowsTest({
    name: "members: a removed person can't use any route, and keeps their name on old work",
    stack: [
      settings(false), person("admin", "admin"), person("leaver"),
      tokenFor("admin", "admin_token"), tokenFor("leaver", "leaver_token"),
      s.api.call({ api: auth_me, headers: bearer("leaver_token"), as: "before" }),
      s.expect.to_equal({ expr: ref("before.id"), value: ref("leaver.id") }),
      s.function.call({ fn: agent.connectFn, input: { user_id: ref("leaver.id"), name: c.text("Key"), scope: c.text("read"), days: c.int(1) }, as: "key" }),
      s.api.call({ api: removeMemberRoute, headers: bearer("admin_token"), input: { id: ref("leaver.id"), new_sponsor_id: c.int(0) }, as: "removed" }),
      s.expect.to_equal({ expr: ref("removed.status"), value: c.text("removed") }),
      s.api.call({ api: auth_me, headers: bearer("leaver_token"), as: "me" }),
      s.expect.to_not_be_defined({ expr: ref("me.id") }),
      s.api.call({ api: listPeople, headers: bearer("leaver_token"), as: "people" }),
      s.expect.to_contain({ expr: ref("people.message"), value: c.text("has ended") }),
      s.api.call({ api: auth_login, input: { email: c.text("leaver@members-test.example"), password: c.text(PASSWORD) }, as: "login" }),
      s.expect.to_not_be_defined({ expr: ref("login.authToken") }),
      s.db.get({ table: agent.agent_connection, fieldValue: ref("key.connection.id"), as: "conn" }),
      s.expect.to_be_true({ expr: ref("conn.revoked") }),
      s.db.get({ table: user, fieldValue: ref("leaver.id"), output: ["id", "name", "password"], as: "row" }),
      s.expect.to_equal({ expr: ref("row.name"), value: c.text("Test leaver") }),
      s.expect.to_be_null({ expr: ref("row.password") }),
      s.api.call({ api: listPeople, headers: bearer("admin_token"), as: "listed" }),
      s.expect.to_contain({ expr: withFilters(ref("listed"), fl.json_encode()), value: c.text("Test leaver") }),
    ],
  }),
  rowsTest({
    name: "members: a sponsor's agents need a new sponsor, whose keys are then revoked",
    stack: [
      settings(false), person("admin", "admin"), person("leaver"), person("guest", "guest"), person("heir"),
      agentRow("scout", ref("leaver.id")),
      tokenFor("admin", "token"),
      s.function.call({ fn: agent.connectFn, input: { user_id: ref("scout.id"), name: c.text("Key"), scope: c.text("read"), days: c.int(1) }, as: "key" }),
      s.api.call({ api: removeMemberRoute, headers: bearer("token"), input: { id: ref("leaver.id"), new_sponsor_id: c.int(0) }, as: "no_choice" }),
      s.expect.to_contain({ expr: ref("no_choice.message"), value: c.text("Choose who") }),
      s.api.call({ api: removeMemberRoute, headers: bearer("token"), input: { id: ref("leaver.id"), new_sponsor_id: ref("guest.id") }, as: "to_guest" }),
      s.expect.to_contain({ expr: ref("to_guest.message"), value: c.text("guest") }),
      s.api.call({ api: removeMemberRoute, headers: bearer("token"), input: { id: ref("leaver.id"), new_sponsor_id: ref("scout.id") }, as: "to_agent" }),
      s.expect.to_contain({ expr: ref("to_agent.message"), value: c.text("current member") }),
      s.db.get({ table: user, fieldValue: ref("leaver.id"), as: "unchanged" }),
      s.expect.to_equal({ expr: ref("unchanged.status"), value: c.text("active") }),
      s.api.call({ api: removeMemberRoute, headers: bearer("token"), input: { id: ref("leaver.id"), new_sponsor_id: ref("heir.id") }, as: "removed" }),
      s.expect.to_equal({ expr: ref("removed.status"), value: c.text("removed") }),
      s.db.get({ table: user, fieldValue: ref("scout.id"), as: "moved" }),
      s.expect.to_equal({ expr: ref("moved.sponsor_id"), value: ref("heir.id") }),
      s.db.get({ table: agent.agent_connection, fieldValue: ref("key.connection.id"), as: "conn" }),
      s.expect.to_be_true({ expr: ref("conn.revoked") }),
    ],
  }),
  workflowTest({
    name: "members: end demo mode shuts all three demo doors",
    stack: [
      settings(true), person("real", "admin"), demoPerson("avery", "admin"), persona("avery"),
      tokenFor("real", "token"), tokenFor("avery", "demo_token"),
      s.function.call({ fn: agent.connectFn, input: { user_id: ref("avery.id"), name: c.text("Demo key"), scope: c.text("read"), days: c.int(1) }, as: "key" }),
      s.db.add({ table: access_link, as: "invite", row: {
        kind: c.text("invite"), email: c.text("joiner@members-test.example"), name: c.text("Jo"), role: c.text("member"),
        token_hash: c.text(LINK.hash), expires_at: c.int(FAR), revoked: c.bool(false), created_by: ref("real.id"),
      } }),
      s.api.call({ api: endDemoRoute, headers: bearer("token"), input: { confirmed_ids: c.array([]) }, as: "ended" }),
      s.expect.to_be_true({ expr: ref("ended.ended") }),
      s.api.call({ api: demoLogin, input: { persona: c.text("avery") }, as: "demo" }),
      s.expect.to_not_be_defined({ expr: ref("demo.authToken") }),
      s.api.call({ api: auth_signup, input: { name: c.text("New"), email: c.text("new@members-test.example"), password: c.text(PASSWORD) }, as: "signup" }),
      s.expect.to_not_be_defined({ expr: ref("signup.authToken") }),
      s.api.call({ api: auth_login, input: { email: c.text("avery@members-test.example"), password: c.text(OLD_DEMO_PASSWORD) }, as: "login" }),
      s.expect.to_equal({ expr: ref("login.message"), value: c.text("Invalid Credentials.") }),
      s.api.call({ api: auth_me, headers: bearer("demo_token"), as: "demo_me" }),
      s.expect.to_not_be_defined({ expr: ref("demo_me.id") }),
      s.function.call({ fn: agent.checkKeyFn, input: { connection_id: ref("key.connection.id"), write: c.bool(false) }, as: "checked" }),
      s.expect.to_contain({ expr: ref("checked.message"), value: c.text("revoked") }),
      s.api.call({ api: acceptLink, input: { token: c.text(LINK.token), name: c.text("Jo"), password: c.text(PASSWORD) }, as: "accepted" }),
      s.expect.to_not_be_defined({ expr: ref("accepted.authToken") }),
      s.api.call({ api: auth_me, headers: bearer("token"), as: "real_me" }),
      s.expect.to_equal({ expr: ref("real_me.id"), value: ref("real.id") }),
    ],
  }),
  rowsTest({
    name: "members: end demo mode needs a real admin and the current list of accounts",
    stack: [
      settings(true), demoPerson("avery", "admin"), person("real", "admin"), person("other"),
      s.function.call({ fn: endDemo, input: { actor_id: ref("avery.id"), confirmed_ids: c.array([]) }, as: "by_demo" }),
      s.expect.to_contain({ expr: ref("by_demo.message"), value: c.text("Invite yourself") }),
      s.function.call({ fn: endDemo, input: { actor_id: ref("real.id"), confirmed_ids: c.array([]) }, as: "stale" }),
      s.expect.to_contain({ expr: ref("stale.message"), value: c.text("list of accounts changed") }),
      s.db.get({ table: workspace_setting, fieldName: "singleton", fieldValue: c.int(1), as: "row" }),
      s.expect.to_be_true({ expr: ref("row.demo_mode") }),
      s.set_var("shown", withFilters(c.array([]), fl.array_push(ref("other.id")))),
      s.function.call({ fn: endDemo, input: { actor_id: ref("real.id"), confirmed_ids: ref("shown") }, as: "ended" }),
      s.expect.to_be_true({ expr: ref("ended.ended") }),
      s.db.get({ table: user, fieldValue: ref("other.id"), as: "kept" }),
      s.expect.to_equal({ expr: ref("kept.status"), value: c.text("active") }),
    ],
  }),
];

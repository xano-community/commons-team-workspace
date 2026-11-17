// Changing a space and who's in it. The routes in query/spaces.ts are thin: the rules live here, so an approval can run
// the same action later. Each takes `browser` and answers not found before it answers no.
import { and, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, statements, withFilters, type Value } from "@xano/sdk";
import { changed, notify } from "../../base/functions.js";
import { rbac } from "../../rbac.js";
import { user } from "../../table/user.js";
import { space } from "../../table/spaces/space.js";
import { space_member } from "../../table/spaces/space_member.js";
import { conversation } from "../../table/messaging/conversation.js";
import { canManage, requireReach } from "./reach.js";
import { addMembership, membershipChange, requireHandover } from "./membership.js";
import { afterRemoval } from "./removal.js";

const MANAGERS_ONLY = "Only this space's managers can do that.";
const ARCHIVED = "This space is archived.";
/** What a guest is told before they join, for the person adding them to confirm. */
export const GUEST_HISTORY_WARNING = "Guests can read everything already in this space, including its history.";

const spaceLink = (id: Value) => withFilters(c.text("/?space="), fl.concat(id));
const nameRules = statements(
  guard.require(expr(withFilters(inp("name"), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "Name the space." }),
  guard.require(expr(withFilters(inp("name"), fl.strlen()), "<=", c.int(60)), { errorType: "badrequest", message: "Keep the name under 60 characters." }),
);
/** Answers not found unless the caller reaches the space, and no unless they manage it. */
const requireManage = statements(
  ...requireReach({ actor: inp("actor_id"), browser: inp("browser"), type: "space", id: inp("space_id") }),
  s.function.run({ fn: canManage, as: "manages", input: { actor_id: inp("actor_id"), browser: inp("browser"), space_id: inp("space_id") } }),
  guard.require(expr(ref("manages"), "=", c.bool(true)), { errorType: "accessdenied", message: MANAGERS_ONLY }),
);
/** Locks the space, so changes to its managers take turns, and refuses an archived one. Binds `locked`. */
const lockOpenSpace = statements(
  s.db.get({ table: space, fieldValue: inp("space_id"), lock: true, output: ["id", "name", "archived_at"], as: "locked" }),
  guard.found("locked", { message: "Not found." }),
  guard.require(expr(ref("locked.archived_at"), "=", c.null()), { errorType: "badrequest", message: ARCHIVED }),
);
const memberRow = (as: string) => s.db.query({ table: space_member, where: [cmp(col("space_id"), "=", inp("space_id")), cmp(col("user_id"), "=", inp("user_id"))], output: ["id", "role"], returnType: "single", as });

export const createSpace = defineFunction({
  name: "spaces/create",
  description: "Create a space, with its creator as manager.",
  input: { actor_id: input.int({ required: true }), browser: input.bool(), name: input.text({ methods: ["trim"] }), visibility: input.enum(["open", "private"], { required: true }), guests_can_create: input.bool() },
  stack: [
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["kind", "role"], as: "actor" }),
    guard.found("actor", { errorType: "accessdenied", message: "Only members create spaces." }),
    guard.require(and(expr(inp("browser"), "=", c.bool(true)), expr(ref("actor.kind"), "=", c.text("human"))), { errorType: "accessdenied", message: "Only members create spaces." }),
    rbac.allows(ref("actor.role"), "space.create", "Only members create spaces."),
    ...nameRules,
    s.db.transaction({ body: [
      s.db.add({ table: space, as: "made", row: { name: inp("name"), visibility: inp("visibility"), guests_can_create: inp("guests_can_create"), created_by: inp("actor_id"), is_demo: c.bool(false) } }),
      ...addMembership({ space: ref("made.id"), person: inp("actor_id"), role: c.text("manager") }),
      // A space is somewhere to talk from the moment it exists.
      s.db.add({ table: conversation, as: "first_channel", row: {
        space_id: ref("made.id"), kind: c.text("channel"), name: c.text("general"), created_by: inp("actor_id"), is_demo: c.bool(false),
        unique_key: withFilters(c.text("channel-"), fl.concat(ref("made.id")), fl.concat(c.text("-general"))),
      } }),
    ] }),
    changed({ entity: "space", id: ref("made.id"), op: "created", verb: "created", actor: inp("actor_id"), space: ref("made.id"), link: spaceLink(ref("made.id")),
      title: withFilters(c.text("created "), fl.concat(inp("name"))) }),
  ],
  response: ref("made"),
});

export const updateSpace = defineFunction({
  name: "spaces/update",
  description: "Rename a space, change who it's open to, or archive it.",
  input: {
    actor_id: input.int({ required: true }), browser: input.bool(), space_id: input.int({ required: true }), name: input.text({ methods: ["trim"] }),
    visibility: input.enum(["open", "private"], { required: true }), guests_can_create: input.bool(), archived: input.bool(),
  },
  stack: [
    ...requireManage,
    ...nameRules,
    s.db.get({ table: space, fieldValue: inp("space_id"), output: ["archived_at"], as: "before" }),
    guard.found("before", { message: "Not found." }),
    s.set_var("archived_at", ref("before.archived_at")),
    s.conditional({
      when: expr(inp("archived"), "=", c.bool(true)),
      then: [s.conditional({ when: expr(ref("archived_at"), "=", c.null()), then: [s.update_var("archived_at", c.now())] })],
      else: [s.update_var("archived_at", c.null())],
    }),
    s.db.patch({ table: space, fieldValue: inp("space_id"), data: obj({ name: inp("name"), visibility: inp("visibility"), guests_can_create: inp("guests_can_create"), archived_at: ref("archived_at") }) }),
    changed({ entity: "space", id: inp("space_id"), verb: "updated", actor: inp("actor_id"), space: inp("space_id"), link: spaceLink(inp("space_id")),
      title: withFilters(c.text("updated "), fl.concat(inp("name"))) }),
    s.db.get({ table: space, fieldValue: inp("space_id"), as: "row" }),
  ],
  response: ref("row"),
});

/**
 * Adds someone to a space. Adding a guest changes nothing until `history_ok` confirms the warning, because a guest can
 * read what was written before they joined. Answers `added` and, when it held back, the `warning` to show.
 */
export const addSpaceMember = defineFunction({
  name: "spaces/add_member",
  description: "Add a person or agent to a space.",
  input: { actor_id: input.int({ required: true }), browser: input.bool(), space_id: input.int({ required: true }), user_id: input.int({ required: true }), history_ok: input.bool() },
  stack: [
    ...requireManage,
    s.db.get({ table: user, fieldValue: inp("user_id"), output: ["id", "name", "role", "status"], as: "person" }),
    guard.found("person", { errorType: "badrequest", message: "Choose a current member." }),
    guard.require(expr(ref("person.status"), "=", c.text("active")), { errorType: "badrequest", message: "Choose a current member." }),
    s.set_var("warning", c.null()),
    s.conditional({ when: and(expr(ref("person.role"), "=", c.text("guest")), expr(inp("history_ok"), "!=", c.bool(true))), then: [s.update_var("warning", c.text(GUEST_HISTORY_WARNING))] }),
    s.set_var("added", c.bool(false)),
    s.conditional({ when: expr(ref("warning"), "=", c.null()), then: [
      s.db.transaction({ body: [
        ...lockOpenSpace,
        ...addMembership({ space: inp("space_id"), person: inp("user_id"), role: c.text("member") }),
      ] }),
      s.update_var("added", c.bool(true)),
      s.conditional({ when: expr(ref("already_in"), "=", c.int(0)), then: [
        notify({ to: inp("user_id"), kind: "space", actor: inp("actor_id"), link: spaceLink(inp("space_id")), space: inp("space_id"), entity: "space", entityId: inp("space_id"), title: "You were added to a space" }),
        changed({ entity: "space_member", id: inp("user_id"), op: "created", verb: "added", actor: inp("actor_id"), space: inp("space_id"), link: spaceLink(inp("space_id")),
          title: withFilters(c.text("added "), fl.concat(ref("person.name")), fl.concat(c.text(" to ")), fl.concat(ref("locked.name"))) }),
      ] }),
    ] }),
  ],
  response: { added: ref("added"), warning: ref("warning") },
});

/** Joins an open space. A person's own choice: guests, agents and connections are added by a manager instead. */
export const joinSpace = defineFunction({
  name: "spaces/join",
  description: "Join an open space.",
  input: { actor_id: input.int({ required: true }), browser: input.bool(), space_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["name", "role", "kind"], as: "actor" }),
    guard.found("actor", { errorType: "notfound", message: "Not found." }),
    s.db.get({ table: space, fieldValue: inp("space_id"), output: ["visibility"], as: "target" }),
    guard.require(and(
      expr(ref("target.visibility", { safe: true }), "=", c.text("open")), expr(inp("browser"), "=", c.bool(true)),
      expr(ref("actor.kind"), "=", c.text("human")), expr(ref("actor.role"), "!=", c.text("guest")),
    ), { errorType: "notfound", message: "Not found." }),
    s.db.transaction({ body: [
      ...lockOpenSpace,
      ...addMembership({ space: inp("space_id"), person: inp("actor_id"), role: c.text("member") }),
    ] }),
    s.conditional({ when: expr(ref("already_in"), "=", c.int(0)), then: [
      changed({ entity: "space_member", id: inp("actor_id"), op: "created", verb: "joined", actor: inp("actor_id"), space: inp("space_id"), link: spaceLink(inp("space_id")),
        title: withFilters(c.text("joined "), fl.concat(ref("locked.name"))) }),
    ] }),
  ],
  response: { joined: c.bool(true) },
});

/** Makes a person a manager, or back to a member. Agents and guests can't manage, and a space keeps at least one manager. */
export const setSpaceRole = defineFunction({
  name: "spaces/set_role",
  description: "Hand a space over: make a member a manager, or a manager a member.",
  input: { actor_id: input.int({ required: true }), browser: input.bool(), space_id: input.int({ required: true }), user_id: input.int({ required: true }), role: input.enum(["manager", "member"], { required: true }) },
  stack: [
    ...requireManage,
    s.db.get({ table: user, fieldValue: inp("user_id"), output: ["name", "kind", "role", "status"], as: "person" }),
    guard.found("person", { errorType: "notfound", message: "Not found." }),
    s.conditional({ when: expr(inp("role"), "=", c.text("manager")), then: [
      guard.require(and(expr(ref("person.kind"), "=", c.text("human")), expr(ref("person.role"), "!=", c.text("guest")), expr(ref("person.status"), "=", c.text("active"))), { errorType: "badrequest", message: "Only a member can manage a space." }),
    ] }),
    s.db.transaction({ body: [
      ...lockOpenSpace,
      memberRow("target"),
      guard.found("target", { message: "Not found." }),
      s.conditional({ when: expr(inp("role"), "=", c.text("member")), then: [requireHandover("target", inp("space_id"), inp("user_id"))] }),
      ...membershipChange(inp("user_id"), [s.db.patch({ table: space_member, fieldValue: ref("target.id"), data: obj({ role: inp("role") }) })]),
    ] }),
    changed({ entity: "space_member", id: inp("user_id"), verb: "updated", actor: inp("actor_id"), space: inp("space_id"), link: spaceLink(inp("space_id")),
      title: withFilters(c.text("made "), fl.concat(ref("person.name")), fl.concat(c.text(" a ")), fl.concat(inp("role"))) }),
  ],
  response: { user_id: inp("user_id"), role: inp("role") },
});

/**
 * Takes someone out of a space: a manager or admin removing them, or a person leaving. The rows go in a transaction,
 * which ends before the kick, so a kick that fails can't bring them back. `kick_failed` tells the caller if one did.
 */
export const removeSpaceMember = defineFunction({
  name: "spaces/remove_member",
  description: "Remove someone from a space, or leave it.",
  input: { actor_id: input.int({ required: true }), browser: input.bool(), space_id: input.int({ required: true }), user_id: input.int({ required: true }) },
  stack: [
    ...requireReach({ actor: inp("actor_id"), browser: inp("browser"), type: "space", id: inp("space_id") }),
    s.conditional({ when: expr(inp("actor_id"), "!=", inp("user_id")), then: [
      s.function.run({ fn: canManage, as: "manages", input: { actor_id: inp("actor_id"), browser: inp("browser"), space_id: inp("space_id") } }),
      guard.require(expr(ref("manages"), "=", c.bool(true)), { errorType: "accessdenied", message: MANAGERS_ONLY }),
    ] }),
    s.db.transaction({ body: [
      s.db.get({ table: space, fieldValue: inp("space_id"), lock: true, output: ["id"], as: "locked" }),
      memberRow("target"),
      guard.found("target", { message: "Not found." }),
      requireHandover("target", inp("space_id"), inp("user_id")),
      ...membershipChange(inp("user_id"), [s.db.del({ table: space_member, fieldValue: ref("target.id") })]),
    ] }),
    s.function.run({ fn: afterRemoval, as: "kick_failed", input: { actor_id: inp("actor_id"), user_id: inp("user_id"), space_id: inp("space_id") } }),
    // A sponsor who just left mustn't go on deciding what's in there.
    s.function.run({ fn: "agents/reroute_approvals", as: "rerouted" }),
  ],
  response: { removed: c.bool(true), kick_failed: ref("kick_failed") },
});

export const spaceFunctions = [createSpace, updateSpace, addSpaceMember, joinSpace, setSpaceRole, removeSpaceMember];

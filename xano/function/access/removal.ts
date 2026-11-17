// What follows a removal, after its transaction commits. Nothing here can undo the removal: reads already refuse the
// person, and a kick that fails is reported, not raised.
import { c, cmp, col, defineFunction, env, expr, fl, guard, inp, input, obj, ref, s, statements, withFilters, type Value } from "@xano/sdk";
import { changed, notify } from "../../base/functions.js";
import { live } from "../../base/live.js";
import { user } from "../../table/user.js";
import { space } from "../../table/spaces/space.js";
import { space_member } from "../../table/spaces/space_member.js";
import { conversation } from "../../table/messaging/conversation.js";
import { unassignLeaver } from "../tasks/tasks.js";

/**
 * Takes a person off channels, when REALTIME_KICK is `on`. The local Engine answers 501 to a kick, past any try_catch,
 * so the flag is off there. A stale subscription carries only ids, and every read still refuses.
 */
export const kickFn = defineFunction({
  name: "access/kick",
  description: "Remove a person's sockets from channels. Answers whether any kick failed.",
  input: { user_id: input.int({ required: true }), channels: input.list(input.text()) },
  stack: [
    s.set_var("kick_failed", c.bool(false)),
    s.conditional({ when: expr(env("REALTIME_KICK"), "=", c.text("on")), then: [
      s.foreach({ list: inp("channels"), as: "channel", body: [
        s.try_catch({
          try: [s.realtime.kick({ server: live, channel: ref("channel"), authTable: user, authId: inp("user_id"), reason: c.text("removed") })],
          catch: [s.update_var("kick_failed", c.bool(true))],
        }),
      ] }),
    ] }),
  ],
  response: ref("kick_failed"),
});

/** Takes the person out of the space live: off its channels, its rows out of their open screens, and its managers told. */
export const afterRemoval = defineFunction({
  name: "access/after_removal",
  description: "After someone leaves a space: kick their sockets, purge their open screens and tell the managers.",
  input: { actor_id: input.int({ required: true }), user_id: input.int({ required: true }), space_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: space, fieldValue: inp("space_id"), output: ["name"], as: "left_space" }),
    guard.found("left_space", { message: "No such space." }),
    s.db.get({ table: user, fieldValue: inp("user_id"), output: ["name"], as: "left_person" }),
    guard.found("left_person", { message: "No such member." }),
    s.db.query({ table: conversation, where: cmp(col("space_id"), "=", inp("space_id")), output: ["id"], as: "channels" }),
    s.set_var("space_path", withFilters(c.text("spaces/"), fl.concat(inp("space_id")))),
    s.set_var("room_path", withFilters(c.text("rooms/space-"), fl.concat(inp("space_id")))),
    s.array.map({ source: ref("channels"), as: "room_paths", transform: withFilters(c.text("rooms/conversation-"), fl.concat(ref("$this.id"))) }),
    s.array.map({ source: ref("channels"), as: "typing_paths", transform: withFilters(c.text("typing/"), fl.concat(ref("$this.id"))) }),
    s.set_var("paths", withFilters(ref("room_paths"), fl.array_merge(ref("typing_paths")))),
    s.function.run({ fn: kickFn, as: "kick_failed", input: { user_id: inp("user_id"),
      channels: withFilters(ref("paths"), fl.array_push(ref("space_path")), fl.array_push(ref("room_path"))) } }),
    s.realtime.publish({ server: live, channel: withFilters(c.text("users/"), fl.concat(inp("user_id"))), message: c.text("purge"), data: obj({ space_id: inp("space_id") }) }),
    s.db.query({ table: space_member, where: [cmp(col("space_id"), "=", inp("space_id")), cmp(col("role"), "=", c.text("manager"))], output: ["user_id"], as: "managers" }),
    s.foreach({ list: ref("managers"), as: "manager", body: [
      notify({ to: ref("manager.user_id"), kind: "space", actor: inp("actor_id"), link: withFilters(c.text("/?space="), fl.concat(inp("space_id"))), space: inp("space_id"), entity: "space", entityId: inp("space_id"),
        title: withFilters(ref("left_person.name"), fl.concat(c.text(" left a space"))) }),
    ] }),
    changed({ entity: "space_member", id: inp("user_id"), op: "deleted", verb: "removed", actor: inp("actor_id"), space: inp("space_id"),
      link: withFilters(c.text("/?space="), fl.concat(inp("space_id"))),
      title: withFilters(ref("left_person.name"), fl.concat(c.text(" left ")), fl.concat(ref("left_space.name"))) }),
    s.function.run({ fn: unassignLeaver, as: "released", input: { actor_id: inp("actor_id"), user_id: inp("user_id"), space_id: inp("space_id") } }),
  ],
  response: ref("kick_failed"),
});

/** After someone leaves the workspace: the same for each space they were in, then off the shared channels. */
export const afterWorkspaceRemoval = (actor: Value, person: Value, rows: string) => statements(
  s.foreach({ list: ref(rows), as: "left", body: [
    s.function.run({ fn: afterRemoval, as: "left_result", input: { actor_id: actor, user_id: person, space_id: ref("left.space_id") } }),
  ] }),
  s.function.run({ fn: kickFn, as: "shared_kick", input: { user_id: person, channels: c.array(["app"]) } }),
);

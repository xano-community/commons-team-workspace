// Who's in a space. `space_member` is the truth, and `user.space_ids` is its copy for code that can read only a user
// row. Every write goes through membershipChange, so the two change in one transaction and can't drift apart.
import { c, cmp, col, expr, guard, obj, ref, s, statements, type Statement, type Value } from "@xano/sdk";
import { user } from "../../table/user.js";
import { space_member } from "../../table/spaces/space_member.js";
import { conversation } from "../../table/messaging/conversation.js";
import { conversation_read } from "../../table/messaging/conversation_read.js";

/** A new joiner starts read at each channel's newest message. A person who comes back starts there too. */
const startRead = (o: { space: Value; person: Value }) => statements(
  s.db.query({ table: conversation, where: [cmp(col("space_id"), "=", o.space), cmp(col("kind"), "=", c.text("channel"))], output: ["id", "last_seq"], as: "joined_channels" }),
  s.foreach({ list: ref("joined_channels"), as: "joined_channel", body: [
    s.db.query({ table: conversation_read, where: [cmp(col("conversation_id"), "=", ref("joined_channel.id")), cmp(col("user_id"), "=", o.person)], output: ["id"], returnType: "single", as: "earlier_read" }),
    s.conditional({
      when: expr(ref("earlier_read"), "=", c.null()),
      then: [s.db.add({ table: conversation_read, as: "started_read", row: { conversation_id: ref("joined_channel.id"), user_id: o.person, last_read_seq: ref("joined_channel.last_seq") } })],
      else: [
        s.set_var("earlier_read_id", ref("earlier_read.id", { safe: true })),
        s.db.patch({ table: conversation_read, fieldValue: ref("earlier_read_id"), data: obj({ last_read_seq: ref("joined_channel.last_seq") }) }),
      ],
    }),
  ] }),
);

/**
 * A change to one person's memberships. Call it inside `s.db.transaction`. Locking their row first makes two changes
 * at once take turns, and the copy is rebuilt from the rows, so a change can never lose another's.
 */
export const membershipChange = (person: Value, change: Statement[]) => statements(
  s.db.get({ table: user, fieldValue: person, lock: true, output: ["id"], as: "member_lock" }),
  guard.found("member_lock", { message: "No such member." }),
  ...change,
  s.db.query({ table: space_member, where: cmp(col("user_id"), "=", person), sort: [{ sortBy: "space_id", dir: "asc" }], output: ["space_id"], as: "member_rows" }),
  s.array.map({ source: ref("member_rows"), as: "member_space_ids", transform: ref("$this.space_id") }),
  s.db.patch({ table: user, fieldValue: person, data: obj({ space_ids: ref("member_space_ids") }) }),
);

/** Adds a row, or leaves the one that's there, so a retry changes nothing. */
export const addMembership = (o: { space: Value; person: Value; role: Value }) => membershipChange(o.person, [
  s.db.query({ table: space_member, where: [cmp(col("space_id"), "=", o.space), cmp(col("user_id"), "=", o.person)], returnType: "count", as: "already_in" }),
  s.conditional({ when: expr(ref("already_in"), "=", c.int(0)), then: [
    s.db.add({ table: space_member, as: "membership", row: { space_id: o.space, user_id: o.person, role: o.role } }),
    ...startRead(o),
  ] }),
]);

/** Every row of one person's, for leaving the workspace. */
export const dropAllMemberships = (person: Value) => membershipChange(person, [
  s.db.query({ table: space_member, where: cmp(col("user_id"), "=", person), output: ["id", "space_id"], as: "left_rows" }),
  s.foreach({ list: ref("left_rows"), as: "row", body: [s.db.del({ table: space_member, fieldValue: ref("row.id") })] }),
]);

/** Binds `other_managers`: how many managers the space has besides `person`. Needs the space row locked. */
export const countOtherManagers = (space: Value, person: Value) => s.db.query({ table: space_member, returnType: "count", as: "other_managers",
  where: [cmp(col("space_id"), "=", space), cmp(col("role"), "=", c.text("manager")), cmp(col("user_id"), "!=", person)] });

export const LAST_MANAGER = "This is the space's last manager. Make someone else a manager first.";
/** Refuses when `row`, a space_member row, is the space's only manager. */
export const requireHandover = (row: string, space: Value, person: Value) => s.conditional({
  when: expr(ref(`${row}.role`), "=", c.text("manager")),
  then: [
    countOtherManagers(space, person),
    guard.require(expr(ref("other_managers"), ">=", c.int(1)), { errorType: "badrequest", message: LAST_MANAGER }),
  ],
});

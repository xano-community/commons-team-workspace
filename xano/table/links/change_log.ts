import { f, table } from "@xano/sdk";

/** The newest sequence number on a live channel. Its row is the lock writers on that channel take turns on. */
export const change_channel = table({
  name: "change_channel",
  description: "One row per live channel, holding its last sequence number.",
  schema: { channel: f.text({ required: true }), last_seq: f.int({ required: true }) },
  index: [{ type: "btree|unique", fields: [{ name: "channel", op: "asc" }] }],
});

/** What changed on a channel, in commit order. Ids only, so a client that catches up reads nothing it couldn't refetch. */
export const change_log = table({
  name: "change_log",
  description: "Every change published on a gated channel, so a client can catch up on what it missed.",
  schema: {
    channel: f.text({ required: true }),
    seq: f.int({ required: true }),
    entity: f.text({ required: true }),
    entity_id: f.int(),
    op: f.text(),
    actor_id: f.int(),
    /** Where inside the record it happened: a message's place in its conversation. */
    at: f.int(),
  },
  index: [{ type: "btree|unique", fields: [{ name: "channel", op: "asc" }, { name: "seq", op: "asc" }] }],
});

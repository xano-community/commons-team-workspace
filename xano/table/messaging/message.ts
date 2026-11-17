import { f, table } from "@xano/sdk";
import { SEED_MESSAGES } from "../../world.js";
import { user } from "../user.js";
import { conversation } from "./conversation.js";

/**
 * One message. `seq` is its place in the conversation, with no gaps. `version` moves on each edit and delete, and the
 * highest wins. Mentions live in `body` as `<@5>` and `<#doc:12>`, so a rename shows everywhere and a title can't outlive
 * someone's access. A deleted message keeps its row and loses its text.
 */
export const message = table({
  name: "message",
  description: "A message in a channel, a DM or a record's thread.",
  schema: {
    conversation_id: f.tableRef(conversation, { required: true }),
    seq: f.int({ required: true }),
    version: f.int({ required: true }),
    /** Chosen by the sender. A retry with the same one answers the row it already made. */
    client_msg_id: f.text({ required: true }),
    author_id: f.tableRef(user, { required: true }),
    body: f.text(),
    /** The files sent with it. They live where the message does, so whoever reads it reaches them. */
    file_ids: f.json(),
    edited_at: f.timestamp({ nullable: true }),
    deleted_at: f.timestamp({ nullable: true }),
    /** The thread on this message, once someone opens one. */
    thread_id: f.int(),
    reply_count: f.int(),
    last_reply_at: f.timestamp({ nullable: true }),
    /** The agent run that wrote it. */
    run_id: f.int(),
    /** A progress note from a run, which reads quieter than something said to the room. */
    run_note: f.bool(),
    /** A person said yes to this before it went out. The author stays the agent. */
    approved_by: f.tableRef(user),
    /** The app a person's connection speaks through, such as "ChatGPT". Empty when they wrote it themselves. */
    via: f.text(),
    /** A run's note in a place guests can read: they don't see it until the run's result is approved. */
    held: f.bool(),
    is_demo: f.bool(),
  },
  index: [
    { type: "btree|unique", fields: [{ name: "conversation_id", op: "asc" }, { name: "seq", op: "asc" }] },
    { type: "btree|unique", fields: [{ name: "conversation_id", op: "asc" }, { name: "client_msg_id", op: "asc" }] },
    { type: "btree", fields: [{ name: "conversation_id", op: "asc" }, { name: "version", op: "asc" }] },
  ],
  seed: SEED_MESSAGES,
});

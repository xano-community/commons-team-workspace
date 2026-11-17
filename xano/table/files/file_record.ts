import { f, table } from "@xano/sdk";
import { SEED_FILES } from "../../world.js";
import { user } from "../user.js";

export const FILE_KINDS = ["image", "pdf", "text", "document", "sheet", "archive", "media", "other"] as const;
/** `signed` lives in private storage and goes out on a short signed link. `table` keeps its bytes in file_blob, for a deployment that can't sign. */
export const FILE_MODES = ["signed", "table"] as const;

/**
 * A file, and where it lives: a space, a DM or the CRM, the same three places every record has. A row keeps the mode it was
 * written with, so a plan that changes later moves nothing. `kind` and `safe_type` are the server's own reading of the file.
 * Only images, PDFs and text ever get a type a browser would show: everything else, HTML and SVG above all, goes out as bytes.
 */
export const file_record = table({
  name: "file_record",
  description: "A file in a space, a DM or the CRM.",
  schema: {
    name: f.text({ required: true }),
    /** What the uploader's browser said. It's kept to show, and never believed. */
    mime: f.text(),
    size: f.int(),
    kind: f.enum(FILE_KINDS, { required: true }),
    /** The Content-Type this file goes out with. */
    safe_type: f.text({ required: true }),
    mode: f.enum(FILE_MODES, { required: true }),
    attachment: f.attachment({ nullable: true }),
    /** "space-3", "dm-4" or "crm", as in `reach.scopes`. */
    scope: f.text({ required: true }),
    space_id: f.int(),
    dm_id: f.int(),
    crm: f.bool(),
    uploaded_by: f.tableRef(user),
    /** The agent run that saved it. */
    run_id: f.int(),
    /** Chosen by the uploader's browser, so a retry finds the row it made. */
    client_id: f.text({ nullable: true }),
    deleted_at: f.timestamp({ nullable: true }),
    is_demo: f.bool(),
  },
  index: [
    { type: "btree", fields: [{ name: "scope", op: "asc" }] },
    { type: "btree", fields: [{ name: "space_id", op: "asc" }] },
    { type: "btree|unique", fields: [{ name: "client_id", op: "asc" }] },
  ],
  seed: SEED_FILES,
});

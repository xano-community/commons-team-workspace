import { f, table } from "@xano/sdk";
import { SEED_FILE_BLOBS } from "../../world.js";
import { file_record } from "./file_record.js";

/** A table-stored file's bytes, as base64. They sit apart from file_record so a list never reads them. */
export const file_blob = table({
  name: "file_blob",
  description: "The stored bytes of a file kept in a table.",
  schema: {
    file_id: f.tableRef(file_record, { required: true }),
    b64: f.text({ required: true }),
  },
  index: [{ type: "btree|unique", fields: [{ name: "file_id", op: "asc" }] }],
  seed: SEED_FILE_BLOBS,
});

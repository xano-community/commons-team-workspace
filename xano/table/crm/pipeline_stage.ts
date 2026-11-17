import { f, table } from "@xano/sdk";
import { SEED_STAGES } from "../../world.js";

export const STAGE_KINDS = ["open", "won", "lost"] as const;

/** One column of the pipeline. Everyone shares one pipeline. `won` and `lost` close a deal, and a pipeline always keeps one of each. */
export const pipeline_stage = table({
  name: "pipeline_stage",
  description: "A stage of the sales pipeline, in order, with what reaching it means for a deal.",
  schema: {
    name: f.text({ required: true }),
    kind: f.enum(STAGE_KINDS, { default: "open" }),
    /** Its place on the board, lowest first. */
    rank: f.int(),
    is_demo: f.bool(),
  },
  index: [{ type: "btree", fields: [{ name: "rank", op: "asc" }] }],
  seed: SEED_STAGES,
});

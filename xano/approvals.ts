import { defineApprovals } from "@xano-sdk/agents";
import { user } from "./table/user.js";
import { SEED_APPROVALS } from "./world.js";
import { rbac } from "./rbac.js";
import { approvedBulk, approvedCustomer, approvedDelete, approvedDm, approvedDoc, approvedExport, approvedFile, approvedJoin, approvedPost, approvedTask } from "./agents/actions.js";

/**
 * What an agent asks a person's OK for (AGENT-APPROVALS.md): one entry per action, each a function that does the thing and
 * re-checks everyone involved. Agents ask through `agentAsk()` (xano/agents/ask.ts), which picks who decides. `admin` is the only
 * role that may ever approve: the list of approvals has no space check, so a wider role would read private previews.
 */
export const approvals = defineApprovals({
  user,
  canonical: "approvals",
  actions: {
    send_external: { fn: approvedPost, label: "Post it", editable: "body" },
    send_dm: { fn: approvedDm, label: "Send it", editable: "body" },
    save_task: { fn: approvedTask, label: "Save the task", editable: "title" },
    save_doc: { fn: approvedDoc, label: "Save the doc", editable: "text" },
    save_crm_record: { fn: approvedCustomer, label: "Save and link it" },
    save_file: { fn: approvedFile, label: "Save the file", editable: "name" },
    delete_record: { fn: approvedDelete, label: "Delete it" },
    bulk_change: { fn: approvedBulk, label: "Change them" },
    export_crm: { fn: approvedExport, label: "Export them", approvers: ["admin"] },
    grant_space_access: { fn: approvedJoin, label: "Add to the space", approvers: ["admin"] },
    change_role: { fn: rbac.setRoleFn, label: "Change role", editable: "role", approvers: ["admin"] },
  },
  // Scout's sample request, so the first minute shows an agent asking before any model key is set (xano/world.ts).
  seed: SEED_APPROVALS,
});

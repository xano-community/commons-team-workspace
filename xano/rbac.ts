import { defineRbac } from "@xano-sdk/rbac";
import { HUMAN_ROLES } from "./app.js";
import { user } from "./table/user.js";
import { gateActive } from "./function/members/gate.js";

/** Who may do what (RBAC.md). Roles are user.role's values (xano/app.ts ROLES). `team.manage` is required. */
export const rbac = defineRbac({
  user,
  canonical: "rbac",
  permissions: {
    "team.manage": ["admin"],
    /** Reach every space from a browser session. */
    "space.oversee": ["admin"],
    "space.create": ["admin", "member"],
    /** The workspace's own pages, such as settings. Guests have only their spaces. */
    "workspace.read": ["admin", "member", "agent"],
    "crm.read": ["admin", "member", "agent"],
    /** Change the pipeline's stages, which everyone shares. */
    "crm.manage": ["admin"],
    /** Change a doc you didn't write, in a space you reach. */
    "docs.edit": ["admin", "member", "agent"],
  },
  memberColumns: ["sponsor_id", "status", "is_demo"],
  kindRoles: { human: [...HUMAN_ROLES], agent: ["agent"] },
  middleware: { pre: [gateActive] },
});

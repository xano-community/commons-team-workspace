// Managing who's in the workspace: offboarding, ending demo mode and clearing demo data. Everything here needs team.manage.
import { apiGroup, auth, c, cmp, col, inp, input, query, ref, s } from "@xano/sdk";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";
import { gateActive } from "../function/members/gate.js";
import { activeSponsored, removeMember } from "../function/members/offboard.js";
import { endDemo, otherAccounts } from "../function/members/end_demo.js";
import { clearDemo, demoCounts } from "../function/members/clear_demo.js";

export const membersGroup = apiGroup({ name: "members", canonical: "members", middleware: { pre: [gateActive] }, description: "Removing members and ending demo mode." });

type Account = { id: number; name: string; email: string | null; role: string; kind: "human" | "agent" };

/** GET members/{id}/offboarding: the agents who need a new sponsor, and who can take them on. */
export const offboarding = query({
  apiGroup: membersGroup, auth: user,
  name: "members/{id}/offboarding", verb: "GET",
  description: "What removing a member would hand over.",
  input: { id: input.int({ required: true }) },
  stack: [
    ...rbac.require("team.manage", "Only people who manage the team remove members."),
    activeSponsored(inp("id"), "agents"),
    s.db.query({ table: user, as: "sponsors", output: ["id", "name"], sort: [{ sortBy: "name", dir: "asc" }],
      where: [cmp(col("kind"), "=", c.text("human")), cmp(col("status"), "=", c.text("active")), cmp(col("role"), "!=", c.text("guest")), cmp(col("id"), "!=", inp("id"))] }),
  ],
  response: { agents: ref("agents"), sponsors: ref("sponsors") },
  responseShape: {} as { agents: { id: number; name: string }[]; sponsors: { id: number; name: string }[] },
});

/** POST members/{id}/remove: end someone's access. Their name stays on what they did. */
export const removeMemberRoute = query({
  apiGroup: membersGroup, auth: user,
  // It can close an approval, which starts a run again, and a run mints a token, so nothing of this request is kept.
  history: false,
  name: "members/{id}/remove", verb: "POST",
  description: "Remove a person or agent. A sponsor's agents go to new_sponsor_id.",
  input: { id: input.int({ required: true }), new_sponsor_id: input.int() },
  stack: [
    ...rbac.require("team.manage", "Only people who manage the team remove members."),
    s.function.run({ fn: removeMember, as: "removed", input: { actor_id: auth("id"), member_id: inp("id"), new_sponsor_id: inp("new_sponsor_id") } }),
  ],
  response: ref("removed"),
  responseShape: {} as { id: number; status: "removed" },
});

/** GET members/end-demo: the accounts that outlive demo mode, for an admin to confirm. */
export const endDemoPreview = query({
  apiGroup: membersGroup, auth: user,
  name: "members/end-demo", verb: "GET",
  description: "Every account that isn't a demo row, besides your own.",
  stack: [
    ...rbac.require("team.manage", "Only people who manage the team end demo mode."),
    otherAccounts(auth("id"), "accounts"),
  ],
  response: { accounts: ref("accounts") },
  responseShape: {} as { accounts: Account[] },
});

/** POST members/end-demo: shut every demo door. `confirmed_ids` are the accounts the admin was shown. */
export const endDemoRoute = query({
  apiGroup: membersGroup, auth: user,
  name: "members/end-demo", verb: "POST",
  description: "End demo mode for good.",
  input: { confirmed_ids: input.list(input.int()) },
  stack: [
    ...rbac.require("team.manage", "Only people who manage the team end demo mode."),
    s.function.run({ fn: endDemo, as: "ended", input: { actor_id: auth("id"), confirmed_ids: inp("confirmed_ids") } }),
  ],
  response: ref("ended"),
  responseShape: {} as { ended: boolean },
});

/** What Clear demo data removes and switches off, counted. All zero once it's done. */
export type DemoData = { people: number; agents: number; spaces: number; conversations: number; messages: number; tasks: number; docs: number; files: number; customers: number; removed: number; cleared: boolean };

/** GET members/clear-demo: the counts the confirm dialog shows. Changes nothing. */
export const clearDemoPreview = query({
  apiGroup: membersGroup, auth: user,
  name: "members/clear-demo", verb: "GET",
  description: "What clearing the demo data would remove, counted.",
  stack: [
    ...rbac.require("team.manage", "Only people who manage the team clear demo data."),
    s.function.run({ fn: demoCounts, as: "counts", input: { actor_id: auth("id") } }),
  ],
  response: ref("counts"),
  responseShape: {} as DemoData,
});

/** POST members/clear-demo: remove the demo company and keep everything real. Safe to repeat. */
export const clearDemoRoute = query({
  apiGroup: membersGroup, auth: user,
  name: "members/clear-demo", verb: "POST",
  description: "Remove the demo data. Real rows and pipeline stages stay.",
  // It can end runs and requests, which carry nothing worth keeping in history.
  history: false,
  stack: [
    ...rbac.require("team.manage", "Only people who manage the team clear demo data."),
    s.function.run({ fn: clearDemo, as: "cleared", input: { actor_id: auth("id") } }),
  ],
  response: ref("cleared"),
  responseShape: {} as DemoData,
});

export const memberQueries = [offboarding, removeMemberRoute, endDemoPreview, endDemoRoute, clearDemoPreview, clearDemoRoute];

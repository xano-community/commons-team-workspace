import { f, table } from "@xano/sdk";
import { DEMO_AGENTS, DEMO_PEOPLE, ROLES } from "../app.js";
import { spaceIdsOf } from "../world.js";
import { account } from "./account.js";

// table "user" — generated from a Xano bundle.
export const user = table({
  name: "user",
  guid: "efb558104909137dac95907814c26051",
  description: "Stores user information and allows the user to authenticate  against",
  auth: true,
  schema: {
    id: f.int({
      required: true,
    }),
    created_at: f.timestamp({
      default: "now",
      access: "private",
    }),
    name: f.text({
      required: true,
      methods: [
        "trim",
      ],
    }),
    email: f.email({
      nullable: true,
      required: true,
      methods: [
        "trim",
        "lower",
      ],
    }),
    password: f.password({
      nullable: true,
      required: true,
      methods: [
        "min:8",
        "minAlpha:1",
        "minDigit:1",
      ],
    }),
    account_id: f.tableRef(account, {
      description: "Reference to the company the user belongs to.",
    }),
    role: f.enum([...ROLES], {
      description: "The role of the user within their company (e.g., 'admin', 'member').",
    }),
    kind: f.enum(["human", "agent"], {
      default: "human",
      description: "A person signs in. An agent has no email or password and acts through its keys.",
    }),
    sponsor_id: f.int({
      description: "The person accountable for this agent. Empty for people.",
    }),
    agent_mode: f.enum(["", "hosted", "connected"], {
      default: "",
      description: "How an agent works: `hosted` runs here when it's mentioned or assigned, `connected` picks up work with its own key. Empty for people.",
    }),
    brief: f.text({
      description: "What a hosted agent is for, in plain words. Passed to every run, and shown on its profile.",
    }),
    status: f.enum(["active", "disabled", "removed"], {
      default: "active",
      description: "Only `active` rows sign in. `removed` is an offboarded member; `disabled` is a demo row after demo mode ended. Both keep their name on old work.",
    }),
    space_ids: f.int({
      array: true,
      description: "The spaces this row has joined, for code that can read only a user row. space_member is the truth: function/access/membership.ts writes this beside it.",
    }),
    is_demo: f.bool({
      description: "A seeded demo row: it signs in only through auth/demo, and only while demo mode is on.",
    }),
    password_reset: f.object({
      token: f.password(),
      expiration: f.timestamp({
        nullable: true,
      }),
      used: f.bool(),
    }),
  },
  index: [
    {
      type: "btree|unique",
      fields: [
        {
          name: "email",
          op: "asc",
        },
      ],
    },
  ],
  tags: [
    "xano:quick-start",
  ],
  // The demo people, then their agents (xano/app.ts), in order: other tables refer to them by position (user_id: 1
  // is the first). No row has a password: demo people sign in through auth/demo, and agents never sign in.
  seed: [
    ...DEMO_PEOPLE.map((p, i) => ({ name: p.name, email: p.email, password: null, role: p.role, kind: "human" as const, status: "active" as const, space_ids: spaceIdsOf(i + 1), is_demo: true })),
    ...DEMO_AGENTS.map((a, i) => ({ name: a.name, email: null, password: null, role: "agent" as const, kind: "agent" as const, agent_mode: a.mode, brief: a.brief, sponsor_id: a.sponsor, status: "active" as const, space_ids: spaceIdsOf(DEMO_PEOPLE.length + i + 1), is_demo: true })),
  ],
});

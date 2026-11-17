// The app's name, roles and demo people: the first backend file a template edits (BASELINE.md).
// `xano/table/user.ts` reads ROLES and DEMO_PEOPLE from here (modules/base/install.mjs wired it), so the role
// enum, the seeded people, the demo sign-in and the invite form all follow this one file.

export const APP = {
  /** Shown in the sidebar, the sign-in screen and the MCP sign-in page. Admins can rename it in Settings. */
  name: "Commons",
  /** The repo slug. It names the workspace and the ChatGPT/Claude sign-in page's API group. */
  slug: "team-workspace",
} as const;

/** user.role's values, most trusted first. Every permission in xano/rbac.ts names some of these. */
export const ROLES = ["admin", "member", "guest", "agent"] as const;
export type Role = (typeof ROLES)[number];

/** The roles a person can hold. An agent holds `agent` and nothing else (xano/rbac.ts locks this). */
export const HUMAN_ROLES = ["admin", "member", "guest"] as const satisfies readonly Role[];

/** What a sign-up gets. Guests are invited to a space, so an open sign-up joins as a member. */
export const SIGNUP_ROLE: Role = "member";

/**
 * One demo person per role a visitor should try, in seed order: rows in other tables refer to them by
 * position (`user_id: 1` is the first). They sign in with one click through auth/demo, never a password.
 */
export const DEMO_PEOPLE: readonly { key: string; name: string; email: string; role: Role; description: string }[] = [
  { key: "admin", name: "Avery Chen", email: "avery@demo.example", role: "admin", description: "Runs the studio, and sees every space" },
  { key: "member", name: "Morgan Reyes", email: "morgan@demo.example", role: "member", description: "Leads the relaunch. Scout has a draft waiting for you" },
  { key: "guest", name: "Riley Park", email: "riley@demo.example", role: "guest", description: "The client, who sees only the client room" },
];
/** The demo people in the order sign-in offers them. Morgan first: Scout's draft waits for her, so her first minute is the demo's. */
export const DEMO_SIGN_IN = [...DEMO_PEOPLE].sort((a, b) => Number(b.key === "member") - Number(a.key === "member"));

/** The demo agents, seeded after the people. `sponsor` is a DEMO_PEOPLE position: the person accountable for it. */
export const DEMO_AGENTS: readonly { name: string; sponsor: number; mode: "hosted" | "connected"; brief: string }[] = [
  { name: "Scout", sponsor: 2, mode: "hosted", brief: "You keep the Marlow relaunch moving. When someone asks, read what's already been said, answer in a few plain lines, and turn agreed next steps into tasks with an owner and a date. If a date or an owner isn't settled, say who needs to decide rather than guessing." },
  { name: "Relay", sponsor: 2, mode: "connected", brief: "Morgan's assistant on her own machine. It picks up what's in its inbox when she runs it, and asks before anything reaches the client." },
];

/**
 * What the activity feed shows on a fresh deploy: a few believable lines by the demo people and their agents,
 * so the overview isn't empty (BASELINE.md). `actor` is a DEMO_PEOPLE position (1 = the first); `via` names the
 * agent that did it for them; `title` is the rest of a sentence after their name.
 */
export type SeedActivity = { actor: number; via?: string; verb: string; entity: string; entity_id: number; title: string; link?: string; minutesAgo: number };
export const SEED_ACTIVITY: SeedActivity[] = [];

/**
 * The sales pipeline a workspace starts with, in order: four open stages, then the two that close a deal. The demo seeds
 * them, and first-admin setup creates them on a workspace with no seed, so the customer board works from the first sign-in.
 */
export const DEFAULT_STAGES: readonly { name: string; kind: "open" | "won" | "lost" }[] = [
  { name: "Lead", kind: "open" }, { name: "Qualified", kind: "open" }, { name: "Proposal", kind: "open" },
  { name: "Negotiation", kind: "open" }, { name: "Won", kind: "won" }, { name: "Lost", kind: "lost" },
];

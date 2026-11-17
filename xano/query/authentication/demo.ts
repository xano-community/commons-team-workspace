import { and, c, env, expr, fl, guard, inp, input, obj, query, ref, s, withFilters } from "@xano/sdk";
import { user } from "../../table/user.js";
import { demo_persona, workspace_setting } from "../../base/tables.js";
import { PERSON_EXTRAS, requireActivePerson } from "../../function/members/gate.js";
import { Authentication } from "../authentication.js";

/** Binds `name` to whether `when` holds. */
const flag = (name: string, when: Parameters<typeof s.conditional>[0]["when"]) => [
  s.set_var(name, c.bool(false)),
  s.conditional({ when, then: [s.update_var(name, c.bool(true))] }),
];

const DEMO_OFF = "Demo sign-in is off for this workspace.";
/** Binds `demo_on`: true only when a settings row exists and has demo mode on. */
const readDemoMode = [
  s.db.get({ table: workspace_setting, fieldName: "singleton", fieldValue: c.int(1), output: ["demo_mode"], as: "ws" }),
  ...flag("demo_on", expr(ref("ws.demo_mode", { safe: true }), "=", c.bool(true))),
];

/** Public: what the signed-out screens may offer. The workspace's name, and booleans; never who's in it. */
export const authStatus = query({
  name: "auth/status", verb: "GET", apiGroup: Authentication,
  description: "Whether this backend needs setup, can be set up, and has its demo and sign-up doors open.",
  stack: [
    s.db.get({ table: workspace_setting, fieldName: "singleton", fieldValue: c.int(1), output: ["name", "demo_mode", "signup_open"], as: "ws" }),
    ...flag("setup_required", expr(ref("ws"), "=", c.null())),
    ...flag("setup_ready", expr(withFilters(env("SETUP_TOKEN"), fl.strlen()), ">=", c.int(1))),
    ...flag("demo_on", expr(ref("ws.demo_mode", { safe: true }), "=", c.bool(true))),
    ...flag("signup_on", expr(ref("ws.signup_open", { safe: true }), "=", c.bool(true))),
  ],
  response: { setup_required: ref("setup_required"), setup_ready: ref("setup_ready"), demo_mode: ref("demo_on"), signup_open: ref("signup_on"), name: ref("ws.name", { safe: true }) },
  responseShape: {} as { setup_required: boolean; setup_ready: boolean; demo_mode: boolean; signup_open: boolean; name: string | null },
});

/** Public: the personas the sign-in screen offers, while demo mode is on. No secrets in it. */
export const demoPersonas = query({
  name: "auth/demo/personas", verb: "GET", apiGroup: Authentication,
  description: "The demo personas shown on the sign-in screen, for demo people who can still sign in. Empty once demo mode is off.",
  stack: [
    ...readDemoMode,
    s.set_var("rows", c.array([])),
    s.conditional({ when: expr(ref("demo_on"), "=", c.bool(true)), then: [
      s.db.query({ table: demo_persona, output: ["key", "label", "description", "email"], sort: [{ sortBy: "id", dir: "asc" }], as: "personas" }),
      // Only someone who can still sign in: after Clear demo data the demo people are switched off, and a button would only fail.
      s.foreach({ list: ref("personas"), as: "persona", body: [
        s.db.get({ table: user, fieldName: "email", fieldValue: ref("persona.email"), output: ["status", "is_demo"], as: "persona_user" }),
        s.conditional({ when: and(expr(ref("persona_user.status", { safe: true }), "=", c.text("active")), expr(ref("persona_user.is_demo", { safe: true }), "=", c.bool(true))), then: [
          s.update_var("rows", withFilters(ref("rows"), fl.array_push(obj({ key: ref("persona.key"), label: ref("persona.label"), description: ref("persona.description") })))),
        ] }),
      ] }),
    ] }),
  ],
  response: ref("rows"),
  responseShape: [] as { key: string; label: string; description: string }[],
});

/** Public: sign in as a demo persona. Mints a token only for an active demo row, and only while demo mode is on. */
export const demoLogin = query({
  name: "auth/demo", verb: "POST", apiGroup: Authentication,
  description: "One-click demo sign-in, while demo mode is on.",
  input: { persona: input.text({ required: true }) },
  stack: [
    ...readDemoMode,
    guard.require(expr(ref("demo_on"), "=", c.bool(true)), { errorType: "accessdenied", message: DEMO_OFF }),
    s.db.get({ table: demo_persona, fieldName: "key", fieldValue: inp("persona"), as: "p" }),
    guard.found("p", { message: "Demo sign-in is off for that persona." }),
    s.db.get({ table: user, fieldName: "email", fieldValue: ref("p.email"), output: ["id", "name", "email", "role", "kind", "status", "is_demo"], as: "u" }),
    guard.found("u", { message: "The demo account is not seeded." }),
    guard.require(expr(ref("u.is_demo"), "=", c.bool(true)), { errorType: "accessdenied", message: DEMO_OFF }),
    ...requireActivePerson("u", { message: DEMO_OFF }),
    s.security.create_auth_token({ table: user, id: ref("u.id"), extras: obj({ kind: c.text(PERSON_EXTRAS.kind) }), expiration: c.int(86400), as: "authToken" }),
  ],
  response: { authToken: ref("authToken"), user_id: ref("u.id") },
});

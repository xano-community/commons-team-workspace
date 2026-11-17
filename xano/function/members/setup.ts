// First-admin setup: the only way into a backend with no settings row. auth/setup is its route.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { APP, DEFAULT_STAGES } from "../../app.js";
import { workspace_setting } from "../../base/tables.js";
import { changed } from "../../base/functions.js";
import { user } from "../../table/user.js";
import { space } from "../../table/spaces/space.js";
import { conversation } from "../../table/messaging/conversation.js";
import { pipeline_stage } from "../../table/crm/pipeline_stage.js";
import { addMembership } from "../access/membership.js";
import { passwordRules } from "./gate.js";

const ALREADY_SET_UP = "This workspace is already set up. Sign in instead.";

/**
 * Creates the admin, the settings row, a default space, #general and the default pipeline in one transaction, and answers the
 * admin's id. Customer stages can't be made closing ones from the board, so the Won and Lost stages are made here (KTD10).
 * `expected_token` is the backend's SETUP_TOKEN: while it is empty, setup is refused whatever was submitted.
 * The settings row goes in first. Its unique index holds a second setup at that insert until the first commits, and
 * then fails it, so two setups at once can't both create an admin.
 */
export const runSetup = defineFunction({
  name: "setup/run",
  description: "Create the first admin and the workspace they run. Refused unless the setup token matches.",
  input: {
    submitted_token: input.text(), expected_token: input.text(),
    workspace_name: input.text({ methods: ["trim"] }), name: input.text({ methods: ["trim"] }),
    email: input.email({ methods: ["trim", "lower"] }), password: input.text(),
  },
  stack: [
    guard.require(expr(withFilters(inp("expected_token"), fl.strlen()), ">=", c.int(1)), { errorType: "accessdenied", message: "Setup is off. Set SETUP_TOKEN on this backend, then try again." }),
    guard.require(expr(inp("submitted_token"), "=", inp("expected_token")), { errorType: "accessdenied", message: "That setup token isn't right." }),
    guard.require(expr(withFilters(inp("workspace_name"), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "Name the workspace." }),
    guard.require(expr(withFilters(inp("workspace_name"), fl.strlen()), "<=", c.int(60)), { errorType: "badrequest", message: "Keep the workspace name under 60 characters." }),
    guard.require(expr(withFilters(inp("name"), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "Add your name." }),
    guard.require(expr(withFilters(inp("name"), fl.strlen()), "<=", c.int(80)), { errorType: "badrequest", message: "Keep your name under 80 characters." }),
    guard.require(expr(withFilters(inp("email"), fl.strlen()), ">=", c.int(3)), { errorType: "badrequest", message: "Add your email." }),
    ...passwordRules("password"),
    s.db.get({ table: workspace_setting, fieldName: "singleton", fieldValue: c.int(1), output: ["id"], as: "existing" }),
    guard.require(expr(ref("existing"), "=", c.null()), { errorType: "accessdenied", message: ALREADY_SET_UP }),
    s.set_var("admin_id", c.int(0)),
    s.set_var("space_id", c.int(0)),
    s.try_catch({
      try: [s.db.transaction({ body: [
        s.db.add({ table: workspace_setting, as: "settings", row: {
          singleton: c.int(1), name: inp("workspace_name"), timezone: c.text("UTC"), week_start: c.text("monday"), demo_mode: c.bool(false), signup_open: c.bool(false),
        } }),
        s.db.query({ table: user, where: cmp(col("kind"), "=", c.text("human")), returnType: "count", as: "people" }),
        guard.require(expr(ref("people"), "=", c.int(0)), { errorType: "accessdenied", message: ALREADY_SET_UP }),
        s.db.add({ table: user, as: "admin", row: {
          name: inp("name"), email: inp("email"), password: inp("password"), role: c.text("admin"), kind: c.text("human"), status: c.text("active"), is_demo: c.bool(false),
        } }),
        s.db.add({ table: space, as: "home", row: { name: inp("workspace_name"), visibility: c.text("open"), created_by: ref("admin.id"), is_demo: c.bool(false) } }),
        ...addMembership({ space: ref("home.id"), person: ref("admin.id"), role: c.text("manager") }),
        s.db.add({ table: conversation, as: "general", row: { space_id: ref("home.id"), kind: c.text("channel"), name: c.text("general"), purpose: c.text("For anything the whole team should see."), created_by: ref("admin.id"), is_demo: c.bool(false),
          unique_key: withFilters(c.text("channel-"), fl.concat(ref("home.id")), fl.concat(c.text("-general"))) } }),
        s.db.query({ table: pipeline_stage, returnType: "count", as: "stages" }),
        s.conditional({ when: expr(ref("stages"), "=", c.int(0)), then: DEFAULT_STAGES.map((stage, i) =>
          s.db.add({ table: pipeline_stage, as: `stage_${i + 1}`, row: { name: c.text(stage.name), kind: c.text(stage.kind), rank: c.int(i + 1), is_demo: c.bool(false) } })) }),
        s.update_var("admin_id", ref("admin.id")),
        s.update_var("space_id", ref("home.id")),
      ] })],
      catch: [s.precondition({ expr: expr(c.bool(true), "=", c.bool(false)), error_type: "accessdenied", error: c.text(ALREADY_SET_UP) })],
    }),
    changed({ entity: "space", id: ref("space_id"), op: "created", verb: "created", actor: ref("admin_id"), space: ref("space_id"), link: "/",
      title: withFilters(c.text(`set up ${APP.name} as `), fl.concat(inp("workspace_name"))) }),
  ],
  response: obj({ user_id: ref("admin_id") }),
});

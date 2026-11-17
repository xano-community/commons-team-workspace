import { c, expr, guard, inp, input, obj, query, ref, s } from "@xano/sdk";
import { SIGNUP_ROLE } from "../../app.js";
import { Getting_Started_Template_create_event_log } from "../../_shared.js";
import { user } from "../../table/user.js";
import { workspace_setting } from "../../base/tables.js";
import { PERSON_EXTRAS } from "../../function/members/gate.js";
import { Authentication } from "../authentication.js";

// query "auth/signup": an open sign-up while the workspace allows one.
export const auth_signup = query({
  name: "auth/signup",
  guid: "ad508f9d25b77a54e415db5c45d0d8d0",
  verb: "POST",
  description: "Sign up while sign-up is open.",
  apiGroup: Authentication,
  tags: [
    "xano:quick-start",
  ],
  input: {
    name: input.text({ required: true }),
    email: input.email({
      required: true,
      methods: [
        "trim",
        "lower",
      ],
    }),
    password: input.text({ required: true }),
  },
  response: {
    authToken: ref("authToken"),
    user_id: ref("user.id"),
  },
  stack: [
    s.db.get({ table: workspace_setting, fieldName: "singleton", fieldValue: c.int(1), output: ["signup_open"], as: "ws" }),
    guard.require(expr(ref("ws.signup_open", { safe: true }), "=", c.bool(true)), { errorType: "accessdenied", message: "Sign-up is closed. Ask an admin for an invite." }),
    s.db.get({ table: user, fieldName: "email", fieldValue: inp("email"), output: ["id"], as: "taken" }),
    s.precondition({
      expr: expr(ref("taken"), "=", c.null()),
      error_type: "accessdenied",
      error: c.text("This account is already in use."),
    }),
    s.db.add({ table: user, as: "joined", row: {
      name: inp("name"), email: inp("email"), password: inp("password"), role: c.text(SIGNUP_ROLE),
      kind: c.text("human"), status: c.text("active"), is_demo: c.bool(false),
    } }),
    s.db.get({ table: user, fieldValue: ref("joined.id"), output: ["id", "created_at", "name", "email", "account_id", "role"], as: "user" }),
    guard.found("user"),
    s.security.create_auth_token({
      table: user,
      id: ref("user.id"),
      extras: obj({ kind: c.text(PERSON_EXTRAS.kind) }),
      expiration: c.int(86400),
      as: "authToken",
    }),
    s.function.run({
      fn: Getting_Started_Template_create_event_log,
      as: "event_log",
      input: {
        user_id: ref("user.id"),
        account_id: c.int(0),
        action: c.text("signup"),
        metadata: obj({
          id: ref("user.id"),
          created_at: ref("user.created_at"),
          name: ref("user.name"),
          email: ref("user.email"),
          account_id: ref("user.account_id"),
          role: ref("user.role"),
        }),
      },
    }),
  ],
});

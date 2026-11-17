import { c, expr, fl, guard, inp, input, obj, query, ref, s, withFilters } from "@xano/sdk";
import { Getting_Started_Template_create_event_log } from "../../_shared.js";
import { PERSON_EXTRAS, requireActivePerson } from "../../function/members/gate.js";
import { user } from "../../table/user.js";
import { Authentication } from "../authentication.js";

// query "auth/login" — generated from a Xano bundle.
export const auth_login = query({
  name: "auth/login",
  guid: "35b7bbd1552626fbc8b7b6c1115c70df",
  verb: "POST",
  description: "Login and retrieve an authentication token",
  apiGroup: Authentication,
  tags: [
    "xano:quick-start",
  ],
  input: {
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
    s.redis.ratelimit({ key: withFilters(c.text("rl:login:"), fl.concat(inp("email"))), max: c.int(10), ttl: c.int(300),
      error: c.text("Too many sign-in attempts. Wait a few minutes and try again.") }),
    s.db.get({
      table: user,
      fieldName: "email",
      fieldValue: inp("email"),
      output: [
        "id",
        "created_at",
        "name",
        "email",
        "password",
        "account_id",
        "role",
        "kind",
        "status",
      ],
      as: "user",
    }),
    guard.found("user", {
      errorType: "accessdenied",
      message: "Invalid Credentials.",
    }),
    ...requireActivePerson("user", { message: "Invalid Credentials." }),
    // Demo people and removed members have no password, and check_password throws on an empty hash.
    guard.require(expr(ref("user.password"), "!=", c.null()), { errorType: "accessdenied", message: "Invalid Credentials." }),
    s.security.check_password({
      as: "pass_result",
      text_password: inp("password"),
      hash_password: ref("user.password"),
    }),
    s.precondition({
      expr: expr(ref("pass_result"), "=", c.bool(true)),
      error_type: "accessdenied",
      error: c.text("Invalid Credentials."),
    }),
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
        account_id: ref("user.account_id"),
        action: c.text("login"),
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

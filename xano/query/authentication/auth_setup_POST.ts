import { c, env, expr, fl, guard, inp, input, obj, query, ref, s, sys, withFilters } from "@xano/sdk";
import { Getting_Started_Template_create_event_log } from "../../_shared.js";
import { user } from "../../table/user.js";
import { PERSON_EXTRAS } from "../../function/members/gate.js";
import { runSetup } from "../../function/members/setup.js";
import { Authentication } from "../authentication.js";

/**
 * POST auth/setup: the first admin of an empty backend, signed in. Public, because nobody has an account yet.
 * Only a wrong token counts against the limit, and each address has its own count, so a stranger guessing can't
 * lock out the person who holds the token.
 */
export const auth_setup = query({
  name: "auth/setup", verb: "POST", apiGroup: Authentication,
  description: "Set up an empty backend with its setup token: creates the first admin and signs them in.",
  input: {
    setup_token: input.text({ required: true }), workspace_name: input.text({ required: true }), name: input.text({ required: true }),
    email: input.email({ required: true, methods: ["trim", "lower"] }), password: input.text({ required: true }),
  },
  stack: [
    s.conditional({ when: expr(inp("setup_token"), "!=", env("SETUP_TOKEN")), then: [
      s.redis.ratelimit({ key: withFilters(c.text("rl:setup:"), fl.concat(sys.remoteIp())), max: c.int(10), ttl: c.int(300),
        error: c.text("Too many setup attempts. Wait a few minutes and try again.") }),
    ] }),
    s.function.run({ fn: runSetup, as: "setup_result", input: {
      submitted_token: inp("setup_token"), expected_token: env("SETUP_TOKEN"), workspace_name: inp("workspace_name"),
      name: inp("name"), email: inp("email"), password: inp("password"),
    } }),
    s.db.get({ table: user, fieldValue: ref("setup_result.user_id"), output: ["id", "created_at", "name", "email", "account_id", "role"], as: "user" }),
    guard.found("user"),
    s.security.create_auth_token({ table: user, id: ref("user.id"), extras: obj({ kind: c.text(PERSON_EXTRAS.kind) }), expiration: c.int(86400), as: "authToken" }),
    s.function.run({ fn: Getting_Started_Template_create_event_log, as: "event_log", input: {
      user_id: ref("user.id"), account_id: c.int(0), action: c.text("setup"),
      metadata: obj({ id: ref("user.id"), created_at: ref("user.created_at"), name: ref("user.name"), email: ref("user.email"), role: ref("user.role") }),
    } }),
  ],
  response: { authToken: ref("authToken"), user_id: ref("user.id") },
  responseShape: {} as { authToken: string; user_id: number },
});

// The checks every sign-in door and signed-in route shares: who may hold a person's session, and what the workspace's
// settings row allows. A token stays valid until it expires, so a removed person is refused here on every call.
import { auth, c, expr, fl, guard, inp, middleware, ref, s, statements, withFilters } from "@xano/sdk";
import { user } from "../../table/user.js";

const PASSWORD_RULE = "Use at least 8 characters, with a letter and a number.";
/** The same rules as the profile page: 8+ characters, a letter and a digit. */
export const passwordRules = (name: string) => statements(
  guard.require(expr(withFilters(inp(name), fl.strlen()), ">=", c.int(8)), { errorType: "badrequest", message: PASSWORD_RULE }),
  guard.require(expr(withFilters(c.regex(/[A-Za-z]/), fl.regex_test(inp(name))), "=", c.bool(true)), { errorType: "badrequest", message: PASSWORD_RULE }),
  guard.require(expr(withFilters(c.regex(/[0-9]/), fl.regex_test(inp(name))), "=", c.bool(true)), { errorType: "badrequest", message: PASSWORD_RULE }),
);

/** What a person token carries. The realtime connect trigger admits only tokens with this marker. */
export const PERSON_EXTRAS = { kind: "person" } as const;

/**
 * Answers 401 for a signed-in caller whose row isn't active. It reads auth(), so it attaches to a signed-in route or
 * a group with no public routes: on a public route the request fails with a 403.
 */
export const gateActive = middleware({
  name: "members/gate_active",
  exceptionPolicy: "rethrow",
  description: "Refuses a signed-in caller whose member row is not active.",
  stack: [
    s.db.get({ table: user, fieldValue: auth("id"), output: ["id", "status"], as: "gate_me" }),
    guard.require(expr(ref("gate_me.status", { safe: true }), "=", c.text("active")), { errorType: "unauthorized", message: "Your access to this workspace has ended." }),
  ],
});

/** Refuses a guest, on the groups a guest has no part in: agent keys and approvals. Runs after gateActive. */
export const gateNotGuest = middleware({
  name: "members/gate_not_guest",
  exceptionPolicy: "rethrow",
  description: "Refuses a signed-in guest.",
  stack: [
    s.db.get({ table: user, fieldValue: auth("id"), output: ["role"], as: "gate_role" }),
    guard.require(expr(ref("gate_role.role", { safe: true }), "!=", c.text("guest")), { errorType: "accessdenied", message: "Guests don't have access to this." }),
  ],
});

/** Refuses a loaded row unless it is an active person. `row` needs `kind` and `status` in its output. */
export const requireActivePerson = (row: string, opts: { errorType?: "accessdenied" | "badrequest" | "notfound"; message: string }) => statements(
  guard.require(expr(ref(`${row}.kind`), "=", c.text("human")), { errorType: opts.errorType ?? "accessdenied", message: opts.message }),
  guard.require(expr(ref(`${row}.status`), "=", c.text("active")), { errorType: opts.errorType ?? "accessdenied", message: opts.message }),
);

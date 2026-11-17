// The rbac module's client, for the two screens built on its provider. Only they load it, so the shell doesn't carry the module.
import { createRbacClient } from "@xano-sdk/rbac/react";
import { XANO_HOST, token } from "./request";

export const rbacClient = createRbacClient({ apiBaseUrl: `${XANO_HOST}/api:rbac`, getToken: () => token.get() });

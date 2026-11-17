// Everything the agents module brings, in its own chunk: the shell shows a count and needs none of it. A screen that
// uses the module wraps itself in <WithAgents>, and while one is mounted it keeps the sidebar's count exact.
import { useEffect, useMemo, type ReactNode } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AgentsPage, AgentsProvider, createAgentsClient, usePendingCount } from "@xano-sdk/agents/react";
import { pendingApprovalsKey } from "./approvals-count";
import { useMe } from "./session";
import { XANO_HOST, token } from "./request";

const client = createAgentsClient({ agentApiBaseUrl: `${XANO_HOST}/api:agent`, approvalsApiBaseUrl: `${XANO_HOST}/api:approvals`, getToken: () => token.get() });

/** The module updates its own count the moment an approval is decided; the sidebar reads the same number. */
function PendingCountBridge() {
  const count = usePendingCount();
  const queries = useQueryClient();
  useEffect(() => { queries.setQueryData(pendingApprovalsKey, { itemsTotal: count, items: [] }); }, [count, queries]);
  return null;
}

export function WithAgents({ children }: { children: ReactNode }) {
  const me = useMe();
  const renderLink = useMemo(() => (href: string, body: ReactNode) => <Link to={href}>{body}</Link>, []);
  return (
    <AgentsProvider client={client} currentUserId={me.id} backendUrl={XANO_HOST} renderLink={renderLink}>
      <PendingCountBridge />
      {children}
    </AgentsProvider>
  );
}

export const AgentsRoute = ({ appName }: { appName: string }) => <WithAgents><AgentsPage appName={appName} /></WithAgents>;

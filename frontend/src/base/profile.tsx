// /profile (AUTH.md §7): the kit's ProfilePage, plus what your role lets you do (in the app's words) and your agents.
import type { ReactNode } from "react";
import { Link } from "react-router";
import { RbacProvider, useRbac } from "@xano-sdk/rbac/react";
import { useAgents } from "@xano-sdk/agents/react";
import { ProfilePage, ProfileSection, useLoad } from "@/components/kit";
import { WithAgents } from "./agents";
import { baseApi } from "./api";
import { rbacClient } from "./rbac-client";
import { isGuest, useMe, useSession } from "./session";

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function ProfileRoute({ labels }: { labels: Record<string, string> }) {
  const me = useMe();
  return <RbacProvider client={rbacClient} userKey={me.id}>{isGuest(me) ? <Profile labels={labels} /> : <WithAgents><Profile labels={labels} agents={<YourAgents />} /></WithAgents>}</RbacProvider>;
}

/** Agents are a member's: a guest has no keys to manage. */
function YourAgents() {
  const { client } = useAgents();
  const agents = useLoad(() => client.connections(), [client]);
  const live = (agents.data ?? []).filter((a) => !a.revoked);
  return (
    <ProfileSection title="Your agents" description="Keys you've given agents, and agents you signed in to.">
      {agents.data === null ? <p className="text-muted-foreground">Loading…</p> : live.length === 0
        ? <p className="text-muted-foreground">No agents yet. <Link to="/agents" className="font-medium text-foreground underline underline-offset-4">Connect one</Link>.</p>
        : <p>{live.length} connected · <Link to="/agents" className="font-medium underline underline-offset-4">Manage on Agents</Link></p>}
    </ProfileSection>
  );
}

function Profile({ labels, agents }: { labels: Record<string, string>; agents?: ReactNode }) {
  const me = useMe();
  const { refresh } = useSession();
  const { me: access } = useRbac();
  return (
    <ProfilePage user={me} onSaveName={async (name) => { await baseApi.updateMe(name); await refresh(); }}
      onChangePassword={me.is_demo ? undefined : (current, next) => baseApi.changePassword(current, next)}>
      <ProfileSection title="What you can do" description={`What the ${me.role} role allows. Someone who manages the team changes roles on Team.`}>
        {!access ? <p className="text-muted-foreground">Loading…</p> : access.permissions.length === 0
          ? <p className="text-muted-foreground">You can see and change your own work.</p>
          : <ul className="list-disc space-y-1 pl-5" data-testid="profile-permissions">{access.permissions.map((p) => <li key={p}>{sentence(labels[p] ?? p)}</li>)}</ul>}
      </ProfileSection>
      {agents}
    </ProfilePage>
  );
}

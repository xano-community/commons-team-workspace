// /approvals: what agents are waiting on this person for, each as the same card the inbox and the record show, at a reading width.
// Decided ones stay a tab away, and an admin also sees, read-only, what waits on someone else.
import { useState } from "react";
import { Link } from "react-router";
import { CheckCheck, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadError, PageHeader, Segmented } from "@/components/kit";
import { ApprovalCardSkeleton, InboxApproval } from "@/components/workspace/approval-card";
import { OverseenApprovals } from "@/components/workspace/overseen-approvals";
import { useApprovalIds } from "@/lib/agents/client";

type View = "pending" | "decided";

export function ApprovalsPage() {
  const [view, setView] = useState<View>("pending");
  const list = useApprovalIds(view);
  const ids = (list.data?.items ?? []).map((a) => a.id);
  return (
    <div data-testid="approvals-page" className="flex max-w-3xl flex-col gap-6">
      <PageHeader title="Approvals" description="Agents can suggest actions, and anything that reaches outside the team waits here for your OK. Read it, change a word if you like, then decide." />
      <div className="flex flex-col gap-3">
        <Segmented label="Show" value={view} onChange={setView} options={[{ value: "pending", label: "Waiting for you" }, { value: "decided", label: "Decided" }]} className="max-md:[&_button]:min-h-11" />
        {list.error ? <LoadError title="Your approvals didn't load" error={list.error} onRetry={() => void list.refetch()} />
          : !list.data ? <><ApprovalCardSkeleton /><ApprovalCardSkeleton /></>
          : !ids.length ? (view === "pending"
            ? <EmptyState icon={CheckCheck} title="Nothing is waiting for you" description="When an agent wants to do something that reaches outside the team, it asks here first, and nothing happens until you say yes."
                action={<Button asChild size="sm" variant="outline" className="max-md:min-h-11"><Link to="/agents"><Plug />Connect an agent</Link></Button>} />
            : <EmptyState title="Nothing decided yet" description="Requests you approve or decline stay here, with what happened." />)
          : <ul data-testid="approvals-list" className="flex flex-col gap-3">{ids.map((id) => <li key={id}><InboxApproval id={id} /></li>)}</ul>}
      </div>
      <OverseenApprovals />
    </div>
  );
}

// For an admin on Approvals: what agents are asking teammates to approve. Read-only, with who decides on each card, so the
// approvals page, the record and the overview all tell the same story. Nothing from a DM ever shows: admins never read DMs.
import { Eye } from "lucide-react";
import { useCan } from "@/base/access";
import { useOverseenApprovals } from "@/lib/agents/client";
import { ApprovalCard } from "./approval-card";

export function OverseenApprovals() {
  const admin = useCan("team.manage");
  const list = useOverseenApprovals(admin);
  const items = list.data?.items ?? [];
  if (!admin || !items.length) return null;
  return (
    <section aria-labelledby="approvals-overseen" data-testid="approvals-overseen" className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 id="approvals-overseen" className="flex items-center gap-2 text-heading"><Eye aria-hidden className="size-4 text-muted-foreground" />Waiting on someone else<span className="text-caption font-normal text-muted-foreground tabular-nums">{items.length}</span></h2>
        <p className="max-w-prose text-body text-pretty text-muted-foreground">What agents are asking teammates to approve. You can read them here, and the person named on each one decides. Requests in direct messages stay private to the people in them.</p>
      </div>
      {items.map((v) => <ApprovalCard key={v.id} view={v} />)}
    </section>
  );
}

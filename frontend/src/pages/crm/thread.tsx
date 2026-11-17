// A customer's thread, beside its record. It's a conversation like any other, reached by crm.read, so an agent named here works on
// the record it's about.
import { Conversation } from "../chat/conversation";
import { FirstComment } from "@/components/workspace/first-comment";
import type { ChatPerson } from "@/lib/api";
import { useCrmSetup } from "@/lib/crm/client";
import { Skeleton } from "@/components/ui/skeleton";
import { taskRecordOptions } from "../tasks/records";

export function RecordThread({ record, threadId, seq, canStart }: { record: { type: "company" | "deal"; id: number }; threadId: number; seq: number | null; canStart: boolean }) {
  const setup = useCrmSetup(threadId === 0);
  if (threadId > 0) return <Conversation key={threadId} id={threadId} panel embedded seq={seq} />;
  if (!canStart) return <p className="p-4 text-body text-muted-foreground">No comments, and this record is in the trash.</p>;
  if (!setup.data) return <Skeleton className="m-4 h-10" />;
  return <FirstComment record={record} spaceId={0} customers={setup.data.people as unknown as ChatPerson[]} refresh={[record.type, "details", record.id]} searchRecords={taskRecordOptions} testId="crm-thread-empty" />;
}

import { useMemo, useRef } from "react";
import { MessagesSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { Composer, type ComposerHandle, type RecordOption } from "@/components/workspace/composer";
import { useMe } from "@/base/session";
import { useWorkspace } from "@/base/workspace";
import { api, type ChatPerson } from "@/lib/api";
import { useConversations } from "@/lib/chat/client";
import { chatOutboxFor } from "@/lib/chat/outgoing";
import { saveDraft } from "@/lib/data";
import { useSpacePeople } from "@/lib/tasks/client";
import { useHostedAgents } from "@/lib/agents/client";
import { shellToast } from "@/lib/toast";

/** A thread starts with its first comment, so a record nobody talks about leaves nothing behind. */
export function FirstComment({ record, spaceId, refresh, searchRecords, testId, customers }: {
  record: { type: string; id: number }; spaceId: number; refresh: readonly unknown[]; searchRecords: (q: string) => Promise<RecordOption[]>; testId: string;
  /** A customer lives in no space: these are who can read it. */
  customers?: ChatPerson[];
}) {
  const me = useMe()!;
  const { nameOf } = useWorkspace();
  const client = useQueryClient();
  const people = useSpacePeople(customers ? null : spaceId);
  const conversations = useConversations();
  const names = useMemo(() => ({ person: (id: number) => nameOf(id), record: () => null }), [nameOf]);
  const draftId = `${record.type}-${record.id}-comment`;
  const box = useRef<ComposerHandle>(null);
  const reader = customers ?? ((people.data?.people ?? []) as ChatPerson[]);
  // The agent worth naming is one that works here on its own (a hosted one), else any agent in reach.
  const hosted = useHostedAgents().data?.items ?? [];
  const agents = reader.filter((p) => (p as { kind?: string }).kind === "agent");
  const agent = agents.find((p) => hosted.some((h) => h.id === p.id)) ?? agents[0];
  const send = async (body: string) => {
    try {
      const thread = await api.openThread(record.type, record.id);
      chatOutboxFor(me.id, me.name).send(thread.id, body, spaceId);
      await client.invalidateQueries({ queryKey: refresh });
    } catch (e) {
      saveDraft(me.id, draftId, body, spaceId);
      shellToast.error(`Couldn't post that comment. ${e instanceof Error ? e.message : "Try again."} Your words are back in the box.`);
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid={testId}>
      {/* An empty rail says what it's for and how to start, at the top where the eye lands, not as one grey line at the bottom. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-3">
        <div data-testid="comments-empty" className="flex flex-col items-start gap-1">
          <p className="flex items-center gap-2 text-body font-medium"><MessagesSquare aria-hidden className="size-4 text-muted-foreground" />No comments yet</p>
          <p className="text-caption text-pretty text-muted-foreground">Questions, decisions and replies about this {record.type === "doc" ? "doc" : record.type === "task" ? "task" : "record"} stay here, beside it. Type @ to bring someone in{agent ? `, or ask ${agent.name} to review it` : ""}.</p>
          <Button size="sm" variant="outline" onClick={() => box.current?.focus()} className="mt-2 max-md:min-h-11">Write the first comment</Button>
        </div>
      </div>
      <div className="px-3 pb-3 max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <Composer ref={box} draftId={draftId} spaceId={spaceId} placeholder="Add a comment" audience={customers ? { type: "crm", id: 0 } : { type: "space", id: spaceId }} people={reader} channels={conversations.data ?? []} names={names} userId={me.id} searchRecords={searchRecords} onSubmit={(b) => void send(b)} />
      </div>
    </div>
  );
}

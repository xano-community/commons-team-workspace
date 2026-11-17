// A record's notes: the words a team keeps about a customer. The mention warning sits above the box, and while it shows Enter does
// nothing, so nobody sends a guest's name by accident. A refused note puts its words back in the box.
import { useMemo, useState } from "react";
import { MoreHorizontal, Pencil, StickyNote, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Ago, Avatar } from "@/components/kit";
import { AgentMark } from "@/components/workspace/agent-mark";
import { BodyText } from "@/components/workspace/body-text";
import { Composer } from "@/components/workspace/composer";
import { useMe } from "@/base/session";
import { useWorkspace } from "@/base/workspace";
import type { ChatPerson } from "@/lib/api";
import { useConversations } from "@/lib/chat/client";
import { useNoteActions } from "@/lib/crm/client";
import type { NoteView } from "@/lib/crm/model";
import { saveDraft } from "@/lib/data";
import { cn } from "@/lib/utils";
import { taskRecordOptions } from "../tasks/records";

export function Notes({ subject, companyId, notes, canAdd, detailsKey, showWhere }: {
  subject: { type: "company" | "deal"; id: number }; companyId: number; notes: NoteView[]; canAdd: boolean; detailsKey: readonly unknown[]; showWhere?: (note: NoteView) => string | null;
}) {
  const me = useMe()!;
  const { nameOf, isAgent, people } = useWorkspace();
  const conversations = useConversations();
  const actions = useNoteActions(detailsKey);
  const [editing, setEditing] = useState<number | null>(null);
  const names = useMemo(() => ({ person: (id: number) => nameOf(id), record: () => null }), [nameOf]);
  const draftId = `note-${subject.type}-${subject.id}`;
  const box = { audience: { type: "crm" as const, id: 0 }, people: people as unknown as ChatPerson[], channels: conversations.data ?? [], names, userId: me.id, searchRecords: taskRecordOptions };
  return (
    <section aria-label="Notes" data-testid="crm-notes" className="flex flex-col gap-2">
      <h2 className="text-caption font-medium text-muted-foreground">Notes</h2>
      {canAdd && <Composer {...box} draftId={draftId} placeholder="Add a note. @ names someone, # links a record." submitLabel="Add note" onSubmit={(body) => { void actions.add(subject, companyId, body).then((ok) => { if (!ok) saveDraft(me.id, draftId, body); }); }} />}
      {!notes.length && <p data-testid="crm-notes-empty" className="flex items-center gap-2 py-1 text-body text-muted-foreground"><StickyNote aria-hidden className="size-4" />{canAdd ? "No notes yet. Keep what the team should remember here." : "No notes."}</p>}
      <ul className="flex flex-col">
        {notes.map((n) => (
          <li key={n.id} data-testid="crm-note" className={cn("group flex min-w-0 gap-2.5 border-t border-border/60 py-2.5 first:border-t-0", n.id < 0 && "opacity-60")}>
            <Avatar name={n.author_name ?? "Someone"} kind={n.author_kind} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-caption text-muted-foreground">
                <span className="font-medium text-foreground">{n.author_name ?? "Someone"}</span>{n.author_kind === "agent" && <AgentMark />}
                <Ago value={n.created_at} />{n.edited_at && <span>edited</span>}{showWhere?.(n) && <span className="truncate">on {showWhere(n)}</span>}
              </p>
              {editing === n.id
                ? <div className="mt-1"><Composer {...box} autoFocus initial={n.body} placeholder="Edit note" submitLabel="Save" onCancel={() => setEditing(null)} onSubmit={(body) => { setEditing(null); if (body !== n.body) void actions.edit(n, body); }} /></div>
                : <div className="mt-0.5"><BodyText body={n.body} me={me.id} nameOf={nameOf} isAgent={isAgent} /></div>}
            </div>
            {canAdd && n.id > 0 && editing !== n.id && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Note actions" data-testid="note-menu" className="shrink-0 text-muted-foreground md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 md:data-[state=open]:opacity-100 max-md:size-11"><MoreHorizontal /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {n.author_id === me.id && <DropdownMenuItem onSelect={() => setEditing(n.id)}><Pencil />Edit</DropdownMenuItem>}
                  <DropdownMenuItem variant="destructive" data-testid="note-delete" onSelect={() => void actions.remove(n)}><Trash2 />Delete</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

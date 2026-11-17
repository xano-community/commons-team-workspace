// Starting a channel or a DM. It loads the first time someone asks. Each ends in the new conversation, and a name already
// taken, or anyone it can't reach, is said beside the field with the dialog still open.
import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { Person } from "@/components/workspace/person";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMe } from "@/base/session";
import { useWorkspace } from "@/base/workspace";
import { api } from "@/lib/api";
import type { NewConversation } from "@/lib/chat/client";
import { mySpaces, useEntityQuery } from "@/lib/data";
import { cn } from "@/lib/utils";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : "That didn't work. Try again.");

function NewChannel({ spaceId, onClose }: { spaceId?: number; onClose: () => void }) {
  const spaces = useEntityQuery("space", ["list"], api.spaces);
  const mine = useMemo(() => (spaces.data ? mySpaces(spaces.data) : []), [spaces.data]);
  const [space, setSpace] = useState<number | null>(spaceId ?? null);
  const chosen = space ?? mine[0]?.id ?? null;
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const navigate = useNavigate();
  const client = useQueryClient();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!chosen || busy) return;
    setBusy(true);
    setProblem("");
    try {
      const made = await api.createChannel(chosen, name);
      await client.invalidateQueries({ queryKey: ["conversation", "list"] });
      onClose();
      navigate(`/chat/${made.id}`);
    } catch (err) { setProblem(messageOf(err)); setBusy(false); }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-4" data-testid="new-channel">
      <DialogHeader>
        <DialogTitle>New channel</DialogTitle>
        <DialogDescription>Everyone in the space can read it.</DialogDescription>
      </DialogHeader>
      {!spaces.isPending && !mine.length ? <p className="text-body text-muted-foreground">You're not in a space yet, so there's nowhere to add a channel.</p> : (
        <>
          {mine.length > 1 && !spaceId && (
            <div className="grid gap-1.5">
              <Label htmlFor="channel-space">Space</Label>
              <select id="channel-space" value={chosen ?? ""} onChange={(e) => setSpace(Number(e.target.value))} className="focus-ring h-9 rounded-md border border-input bg-background px-2 text-body max-sm:h-11">
                {mine.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="channel-name">Name</Label>
            <Input id="channel-name" autoFocus required maxLength={40} value={name} onChange={(e) => { setName(e.target.value); setProblem(""); }} placeholder="launch-plans" aria-invalid={!!problem} aria-describedby={problem ? "channel-problem" : undefined} className="max-sm:h-11" />
            {problem && <p id="channel-problem" role="alert" className="text-caption text-destructive">{problem}</p>}
          </div>
        </>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} className="max-sm:min-h-11">Cancel</Button>
        <Button type="submit" disabled={!name.trim() || !chosen || busy} className="max-sm:min-h-11">Create channel</Button>
      </DialogFooter>
    </form>
  );
}

function NewDm({ onClose }: { onClose: () => void }) {
  const me = useMe()!;
  const { people } = useWorkspace();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const navigate = useNavigate();
  const client = useQueryClient();
  const options = useMemo(() => people.filter((p) => p.id !== me.id && p.status === "active" && p.name.toLowerCase().includes(q.trim().toLowerCase())), [people, me.id, q]);
  const toggle = (id: number) => { setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])); setProblem(""); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!picked.length || busy) return;
    setBusy(true);
    setProblem("");
    try {
      const dm = await api.openDm(picked);
      await client.invalidateQueries({ queryKey: ["conversation", "list"] });
      onClose();
      navigate(`/chat/${dm.id}`);
    } catch (err) { setProblem(messageOf(err)); setBusy(false); }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-3" data-testid="new-dm">
      <DialogHeader>
        <DialogTitle>New message</DialogTitle>
        <DialogDescription>Only the people you choose can read it. Admins can't.</DialogDescription>
      </DialogHeader>
      <Input autoFocus aria-label="Find someone" placeholder="Find someone" value={q} onChange={(e) => setQ(e.target.value)} className="max-sm:h-11" />
      <ul className="max-h-64 overflow-y-auto rounded-md border" aria-label="People">
        {options.map((p) => {
          const on = picked.includes(p.id);
          return (
            <li key={p.id}>
              <button type="button" aria-pressed={on} data-testid="dm-person" onClick={() => toggle(p.id)} className={cn("focus-ring-inset flex min-h-9 w-full min-w-0 items-center gap-2 px-2 text-left text-body hover:bg-muted/50 max-sm:min-h-11", on && "bg-selected")}>
                <Person name={p.name} kind={p.kind} className="flex-1" />
                {on && <Check aria-hidden className="size-4 shrink-0" />}
              </button>
            </li>
          );
        })}
        {!options.length && <li className="px-2 py-3 text-body text-muted-foreground">{q ? "Nobody matches that name." : "There's nobody else here yet."}</li>}
      </ul>
      {problem && <p role="alert" className="text-caption text-destructive">{problem}</p>}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} className="max-sm:min-h-11">Cancel</Button>
        <Button type="submit" disabled={!picked.length || busy} className="max-sm:min-h-11">Start conversation</Button>
      </DialogFooter>
    </form>
  );
}

export default function NewConversationDialog({ asked, onClose }: { asked: NewConversation; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        {asked.kind === "channel" ? <NewChannel spaceId={asked.spaceId} onClose={onClose} /> : <NewDm onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

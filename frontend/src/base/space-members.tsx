// Who's in a space, and adding someone. Opened from the space's row in the sidebar. A private space says plainly that
// admins can see it; adding a guest stops on the server's history warning until someone has read it.
import { useRef, useState } from "react";
import { Lock, Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/kit";
import { Person } from "@/components/workspace/person";
import { api } from "@/lib/api";
import { PRIVATE_SPACE_LABEL, addSpaceMember, useEntityQuery } from "@/lib/data";
import { useWorkspace } from "./workspace";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : "That didn't work. Try again.");

export default function SpaceMembersDialog({ spaceId, onClose }: { spaceId: number; onClose: () => void }) {
  const client = useQueryClient();
  const { people } = useWorkspace();
  const space = useEntityQuery("space", [spaceId], () => api.space(spaceId));
  const members = useEntityQuery("space", [spaceId, "members"], () => api.spaceMembers(spaceId));
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const answer = useRef<(yes: boolean) => void>(() => {});

  const inSpace = new Set(members.data?.people.map((p) => p.id));
  const candidates = people.filter((p) => p.status === "active" && !inSpace.has(p.id));
  const add = async () => {
    const id = Number(picked);
    setBusy(true); setError(null);
    try {
      const added = await addSpaceMember(
        (historyOk) => api.addSpaceMember(spaceId, id, historyOk),
        (text) => new Promise((resolve) => { answer.current = resolve; setWarning(text); }),
      );
      if (added) { toast.success("Added to the space"); setPicked(""); await client.invalidateQueries({ queryKey: ["space"] }); }
    } catch (e) { setError(messageOf(e)); }
    finally { setBusy(false); }
  };
  const decide = (yes: boolean) => { setWarning(null); answer.current(yes); };

  return (
    <>
      <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent data-kit="space-members" className="max-w-md">
          <DialogHeader>
            <DialogTitle>{space.data?.space.name ?? "Space"}</DialogTitle>
            <DialogDescription>Who's in this space.</DialogDescription>
          </DialogHeader>
          {space.data?.space.visibility === "private" && (
            <p data-testid="private-space-label" className="flex items-center gap-1.5 text-caption text-muted-foreground"><Lock aria-hidden className="size-3" />{PRIVATE_SPACE_LABEL}</p>
          )}
          {members.error ? <LoadError error={members.error} onRetry={() => void members.refetch()} />
            : !members.data ? <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={`skeleton-${i}`} className="h-8 w-full" />)}</div>
            : (
              <ul className="max-h-64 min-h-0 divide-y overflow-y-auto">
                {members.data.people.map((p) => (
                  <li key={p.id} className="flex h-(--row-height) items-center gap-2 text-body">
                    <Person name={p.name} kind={p.kind} size="sm" className="flex-1" />
                    <span className="text-caption text-muted-foreground">{p.role === "guest" ? "Guest" : members.data.members.find((m) => m.user_id === p.id)?.role === "manager" ? "Manager" : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          {space.data?.can_manage && candidates.length > 0 && (
            <div className="grid gap-1.5">
              <Label htmlFor="space-add">Add someone</Label>
              <div className="flex gap-2">
                <Select value={picked} onValueChange={setPicked}>
                  <SelectTrigger id="space-add" className="min-w-0 flex-1"><SelectValue placeholder="Pick a person or agent" /></SelectTrigger>
                  <SelectContent>{candidates.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}{p.role === "guest" ? " (guest)" : ""}</SelectItem>)}</SelectContent>
                </Select>
                <Button size="sm" disabled={!picked || busy} data-testid="space-add-member" onClick={() => void add()}><Plus />{busy ? "Adding…" : "Add"}</Button>
              </div>
            </div>
          )}
          {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
        </DialogContent>
      </Dialog>
      <AlertDialog open={warning !== null}>
        <AlertDialogContent data-testid="guest-history-warning">
          <AlertDialogHeader>
            <AlertDialogTitle>Add this guest?</AlertDialogTitle>
            <AlertDialogDescription>{warning}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => decide(false)}>Don't add</AlertDialogCancel>
            <AlertDialogAction onClick={() => decide(true)}>Add them</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

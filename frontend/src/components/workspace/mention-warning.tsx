import { useRef, useState } from "react";
import { Bot, TriangleAlert, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MentionCheck } from "@/lib/api";
import { addMissing, missingNames, type AddMember } from "@/lib/links/mentions";
import { askToAdd } from "@/lib/agents/model";
import type { AgentMentionCheck } from "../../../../xano/query/agents.js";

/**
 * The one mention warning. Above a composer it holds the send: `onProceed` is Send anyway. In a doc or task body the
 * mention is already in, so `variant="notice"` makes that Keep mention. Add to space shows only to someone who manages the
 * space, and nobody gains access unless they press it. Nothing here animates: it's the answer to a key press.
 */
export function MentionWarning({ check, variant = "composer", crm = false, addMember, onProceed, onRemove, onAdded }: {
  check: MentionCheck;
  variant?: "composer" | "notice";
  /** It's a CRM note or thread, which nothing can add them to: they simply won't hear. */
  crm?: boolean;
  addMember: AddMember;
  onProceed: () => void;
  onRemove: () => void;
  onAdded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [held, setHeld] = useState("");
  const answer = useRef<((yes: boolean) => void) | null>(null);
  const reply = (yes: boolean) => { setHeld(""); answer.current?.(yes); answer.current = null; };

  const add = async () => {
    setBusy(true);
    setProblem("");
    try {
      await addMissing(check.add, addMember, (warning) => new Promise((resolve) => { answer.current = resolve; setHeld(warning); }));
      onAdded();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="status" data-kit="mention-warning" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border bg-muted/50 px-3 py-2 text-body">
      <TriangleAlert aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 basis-48 text-pretty">
        <span className="font-medium">{missingNames(check.missing)}</span> {crm ? "can't open customers, so won't be told. None of this reaches them." : "can't open this, and will see a locked link."}
        {held && <span className="mt-0.5 block text-muted-foreground">{held}</span>}
        {problem && <span role="alert" className="mt-0.5 block text-destructive">{problem}</span>}
      </p>
      <div className="flex max-w-full min-w-0 flex-wrap items-center gap-1.5 max-sm:[&_button]:min-h-11">
        {held ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => reply(false)}>Skip them</Button>
            <Button size="sm" onClick={() => reply(true)}>Add anyway</Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={onRemove} disabled={busy}>Remove mention</Button>
            <Button size="sm" variant={check.add.length ? "ghost" : "outline"} onClick={onProceed} disabled={busy}>{variant === "composer" ? "Send anyway" : "Keep mention"}</Button>
            {check.add.length > 0 && <Button size="sm" variant="outline" onClick={() => void add()} disabled={busy}><UserPlus />Add to space</Button>}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Naming an agent that isn't in this conversation's space (KTD7). Nothing starts for it until it's in, so the message waits here with
 * its text kept. Someone who manages the space can add it and send; anyone else sends without it, and is told who can add it.
 */
export function AgentMentionWarning({ check, onAddAndSend, onSendWithout }: {
  check: AgentMentionCheck;
  onAddAndSend: () => Promise<void>;
  onSendWithout: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const names = check.missing.map((a) => a.name);
  const who = missingNames(check.missing);
  const one = names.length === 1;
  const add = async () => {
    setBusy(true);
    setProblem("");
    try { await onAddAndSend(); }
    catch (e) { setProblem(e instanceof Error ? e.message : "That didn't go through. Try again."); }
    finally { setBusy(false); }
  };
  return (
    <div role="status" data-kit="agent-mention-warning" data-testid="agent-mention-warning" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-agent/30 bg-agent-wash/40 px-3 py-2 text-body">
      <Bot aria-hidden className="size-4 shrink-0 text-agent-text" />
      <p className="min-w-0 flex-1 basis-48 text-pretty">
        <span className="font-medium">{who} {one ? "isn't" : "aren't"} in {check.in_dm ? "this DM" : "this space"}.</span>{" "}
        <span className="text-muted-foreground">{one ? "It" : "They"} won't see this or start on it{check.can_add ? ". Add it?" : "."}</span>
        {!check.can_add && <span data-testid="agent-mention-who" className="mt-0.5 block text-muted-foreground">{check.in_dm ? "A DM keeps the people it started with. Start a new one to include an agent." : askToAdd(names, check.managers)}</span>}
        {problem && <span role="alert" className="mt-0.5 block text-destructive">{problem}</span>}
      </p>
      <div className="flex max-w-full min-w-0 flex-wrap items-center gap-1.5 max-sm:[&_button]:min-h-11">
        <Button size="sm" variant={check.can_add ? "ghost" : "outline"} data-testid="agent-send-without" onClick={onSendWithout} disabled={busy}>Send without {one ? "agent" : "agents"}</Button>
        {check.can_add && <Button size="sm" variant="outline" data-testid="agent-add-send" onClick={() => void add()} disabled={busy}><UserPlus />{busy ? "Adding…" : "Add and send"}</Button>}
      </div>
    </div>
  );
}

// The one composer: a channel, a DM, a thread, and an edit in place. It's a plain textarea, so typing, IME and a phone's
// keyboard all behave natively, and it holds names; `<@5>` tokens exist only from the moment of sending. The text lives in
// the textarea and a ref, not in state: a key press runs no render unless it changes something on screen.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Bot, Hash, Paperclip, User, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KeyHint } from "@/components/kit";
import { AgentMentionWarning, MentionWarning } from "@/components/workspace/mention-warning";
import { useAgentMentionCheck } from "@/lib/agents/client";
import { withoutAgents } from "@/lib/agents/model";
import { FileCard } from "@/components/workspace/file-tile";
import { UploadRows, pastedFiles, usePicker } from "@/components/workspace/uploader";
import { api, type ChatPerson, type ConversationRow } from "@/lib/api";
import { activeTrigger, applyPick, decodeBody, encodeBody, peopleIn, recordsIn, stripNames, stripRecords, type Pick, type Trigger } from "@/lib/chat/tokens";
import { CATALOG, matchesStep } from "@/lib/commands";
import { clearDraft, readDraft, saveDraft } from "@/lib/data";
import { filesApi } from "@/lib/files/api";
import { useUploads } from "@/lib/files/client";
import type { Place } from "@/lib/files/model";
import { gateSend, recordKey, useMentionCheck, type Audience } from "@/lib/links/mentions";
import type { RecordRef } from "@/lib/links/resolver";
import { perf } from "@/lib/perf";
import { cn } from "@/lib/utils";

const LONGEST = 8000;
const WARN_AT = 7600;
const DRAFT_SAVE_MS = 300;
const MOST_OPTIONS = 8;
const NO_RECORDS: RecordRef[] = [];
const NO_OUTSIDERS: { id: number; name: string }[] = [];
const shortcut = (id: "composer.send" | "composer.edit-last") => CATALOG[id].shortcut;
/** A phone's Return makes a new line: there's a Send button under the thumb. */
const coarse = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

type Option = { key: string; label: string; display: string; token: string; icon: LucideIcon; agent?: boolean; hint?: string };
export type ComposerHandle = { focus: () => void; text: () => string; addFiles: (files: File[]) => void };
export type RecordOption = { type: string; id: number; title: string; icon: LucideIcon };

export const Composer = forwardRef<ComposerHandle, {
  placeholder: string;
  /** Where unsent text is kept. An edit has none: its text is the message's. */
  draftId?: string;
  spaceId?: number;
  audience: Audience | null;
  people: ChatPerson[];
  channels: ConversationRow[];
  names: { person: (id: number) => string | null; record: (type: string, id: number) => string | null };
  userId: number;
  /** The text to start from, as a body. */
  initial?: string;
  submitLabel?: string;
  onSubmit: (body: string, fileIds?: number[]) => void;
  /** Where a file sent from here lives. Without it, this composer takes words alone. */
  attach?: Place | null;
  onCancel?: () => void;
  onInput?: () => void;
  onEditLast?: () => void;
  autoFocus?: boolean;
  /** Records a "#" can name besides channels. */
  searchRecords?: (q: string) => Promise<RecordOption[]>;
  /** A body, not a message: the mention warning is a notice once it's in, and holds nothing back. */
  notice?: boolean;
  /** Agents who can't read this conversation. "@" still offers them, and naming one asks "Add it?" before anything sends (KTD7). */
  outsiders?: { id: number; name: string }[];
}>(function Composer({ placeholder, draftId, spaceId, audience, people, channels, names, userId, initial, submitLabel = "Send", onSubmit, attach = null, onCancel, onInput, onEditLast, autoFocus, searchRecords, notice = false, outsiders = NO_OUTSIDERS }, handle) {
  const start = useMemo(() => decodeBody(initial ?? (draftId ? readDraft(userId, draftId)?.text ?? "" : ""), names), [draftId, userId]); // eslint-disable-line react-hooks/exhaustive-deps
  const text = useRef(start.text);
  const picks = useRef<Pick[]>(start.picks);
  const [hasText, setHasText] = useState(!!start.text.trim());
  /** The placeholder is drawn here, not by the textarea: Chrome restyles its own placeholder on every key, even while hidden. */
  const [empty, setEmpty] = useState(!start.text);
  const [records, setRecords] = useState<RecordRef[]>(() => recordsIn(encodeBody(start.text, start.picks)));
  /** Who's named, where that's what the warning is about. */
  const [named, setNamed] = useState<number[]>([]);
  const crm = audience?.type === "crm";
  /** The body's length, once it's near the limit. Below that nothing shows, so nothing needs to render. */
  const [nearLimit, setNearLimit] = useState(0);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [active, setActive] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const saving = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sendWhenChecked = useRef(false);

  const bodyNow = useCallback(() => encodeBody(text.current, picks.current).trim(), []);
  const check = useMentionCheck(audience, records, named);
  /** Agents named here who can't read it. Only a message in a conversation asks: a body or a CRM note just names them. */
  const [namedOut, setNamedOut] = useState<number[]>([]);
  const agentsAsk = !notice && audience?.type === "conversation" && outsiders.length > 0;
  const agentCheck = useAgentMentionCheck(agentsAsk ? audience!.id : 0, namedOut);
  const agentWarning = agentsAsk && namedOut.length > 0 && agentCheck.data?.missing.length ? agentCheck.data : null;
  const agentChecking = agentsAsk && namedOut.length > 0 && agentCheck.isFetching;
  const tooLong = nearLimit > LONGEST;

  /**
   * What's on screen now. A key press compares against it and sets only what changed: a set state that changes nothing can
   * still render the composer, and that render would land on every key.
   */
  const shown = useRef({ empty, hasText, nearLimit, records, named, namedOut, trigger });
  shown.current = { empty, hasText, nearLimit, records, named, namedOut, trigger };

  /** What a change of text may show: each only renders when its answer differs. */
  const noticed = useCallback(() => {
    const body = bodyNow();
    const now = shown.current;
    if (now.empty !== !text.current) setEmpty(!text.current);
    if (now.hasText !== !!body) setHasText(!!body);
    const near = body.length > WARN_AT ? body.length : 0;
    if (now.nearLimit !== near) setNearLimit(near);
    const found = body.includes("<#") ? recordsIn(body) : NO_RECORDS;
    if (recordKey(now.records) !== recordKey(found)) setRecords((was) => (recordKey(was) === recordKey(found) ? was : found));
    if (crm) { const people = body.includes("<@") ? peopleIn(body) : []; if (now.named.join() !== people.join()) setNamed((was) => (was.join() === people.join() ? was : people)); }
    if (outsiders.length) { const out = body.includes("<@") ? peopleIn(body).filter((id) => outsiders.some((a) => a.id === id)) : []; if (now.namedOut.join() !== out.join()) setNamedOut((was) => (was.join() === out.join() ? was : out)); }
  }, [bodyNow, crm, outsiders]);
  /** Puts text in from outside the keyboard: a pick, a send, a removed mention. */
  const setValue = useCallback((next: string) => {
    text.current = next;
    if (area.current) area.current.value = next;
    noticed();
  }, [noticed]);

  const { set: uploads, list: uploading } = useUploads(attach);
  const picker = usePicker((files) => uploads?.add(files));
  /** How many a person is waiting on, and what went wrong with the rest. */
  const pending = uploading.filter((u) => u.state === "queued" || u.state === "uploading").length;
  const stuck = uploading.filter((u) => u.state !== "done" && u.state !== "queued" && u.state !== "uploading").length;
  const ready = uploading.filter((u) => u.state === "done");
  /** Send was pressed with a file still going: the message waits for it. */
  const [waiting, setWaiting] = useState(false);

  useImperativeHandle(handle, () => ({ focus: () => area.current?.focus(), text: () => text.current, addFiles: (files) => uploads?.add(files) }), [uploads]);
  // Not on a phone, where focus would throw the keyboard over what someone came to read.
  useEffect(() => { if (autoFocus && !coarse()) area.current?.focus(); }, [autoFocus, draftId]);

  // A switch of conversation brings that one's own draft.
  useEffect(() => {
    if (!draftId) return;
    picks.current = start.picks;
    setValue(start.text);
    setTrigger(null);
  }, [draftId, start, setValue]);

  // A draft can open before the names it holds have loaded, and then shows a raw <@7>. Once they load, it reads as names again.
  useEffect(() => {
    if (!/<[@#]/.test(text.current)) return;
    const again = decodeBody(encodeBody(text.current, picks.current), names);
    if (again.text === text.current) return;
    picks.current = again.picks;
    setValue(again.text);
  }, [names, setValue]);

  const persist = useCallback((next: string) => {
    if (!draftId) return;
    clearTimeout(saving.current);
    saving.current = setTimeout(() => saveDraft(userId, draftId, encodeBody(next, picks.current), spaceId), DRAFT_SAVE_MS);
  }, [draftId, userId, spaceId]);
  useEffect(() => () => clearTimeout(saving.current), [draftId]);
  // Leaving before the timer fires must not lose the last words.
  useEffect(() => () => { if (draftId) saveDraft(userId, draftId, encodeBody(text.current, picks.current), spaceId); }, [draftId, userId, spaceId]);

  const [found, setFound] = useState<RecordOption[]>([]);
  const looking = trigger?.char === "#" ? trigger.query : null;
  useEffect(() => {
    if (looking === null || !searchRecords || looking.length < 2) { setFound([]); return; }
    let current = true;
    const t = setTimeout(() => void searchRecords(looking).then((rows) => { if (current) setFound(rows); }, () => {}), 120);
    return () => { current = false; clearTimeout(t); };
  }, [looking, searchRecords]);

  const options = useMemo<Option[]>(() => {
    if (!trigger) return [];
    const q = trigger.query.toLowerCase();
    if (trigger.char === "@") {
      const here = people.filter((p) => p.id !== userId && p.name.toLowerCase().includes(q))
        .map((p): Option => ({ key: `p${p.id}`, label: p.name, display: `@${p.name}`, token: `<@${p.id}>`, icon: p.kind === "agent" ? Bot : User, agent: p.kind === "agent" }));
      const away = outsiders.filter((a) => a.name.toLowerCase().includes(q) && !people.some((p) => p.id === a.id))
        .map((a): Option => ({ key: `p${a.id}`, label: a.name, display: `@${a.name}`, token: `<@${a.id}>`, icon: Bot, agent: true, hint: "Not in this space" }));
      return [...here, ...away].slice(0, MOST_OPTIONS);
    }
    return [
      ...channels.filter((c) => c.kind === "channel" && c.name.toLowerCase().includes(q)).map((c) => ({ key: `c${c.id}`, label: c.name, display: `#${c.name}`, token: `<#conversation:${c.id}>`, icon: Hash })),
      ...found.map((r) => ({ key: `${r.type}${r.id}`, label: r.title, display: `#${r.title}`, token: `<#${r.type}:${r.id}>`, icon: r.icon })),
    ].slice(0, MOST_OPTIONS);
  }, [trigger, people, channels, userId, found, outsiders]);
  const menuOpen = options.length > 0;

  const change = (next: string, caret: number) => {
    text.current = next;
    noticed();
    persist(next);
    onInput?.();
    // Only a word starting @ or # can open the menu, so most keys leave it alone.
    const found = activeTrigger(next, caret);
    if (found || shown.current.trigger) setTrigger((was) => (!was && !found ? was : found));
    if (found) setActive(0);
  };

  const pick = (o: Option) => {
    const el = area.current;
    if (!el || !trigger) return;
    picks.current = [...picks.current.filter((p) => p.token !== o.token), { display: o.display, token: o.token }];
    const placed = applyPick(text.current, trigger, el.selectionStart, o.display);
    setValue(placed.text);
    persist(placed.text);
    setTrigger(null);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(placed.caret, placed.caret); });
  };

  const finish = useCallback(() => {
    perf.start("optimistic");
    const ids = uploads?.fileIds() ?? [];
    onSubmit(bodyNow(), ids.length ? ids : undefined);
    perf.endAfterPaint("optimistic");
    uploads?.clear();
    setWaiting(false);
    picks.current = [];
    setValue("");
    setTrigger(null);
    clearTimeout(saving.current);
    if (draftId) clearDraft(userId, draftId);
  }, [bodyNow, draftId, onSubmit, setValue, uploads, userId]);

  const send = useCallback(() => {
    if ((!bodyNow() && !uploads?.list().length) || tooLong) return;
    // A message doesn't leave without what it was sent with, and doesn't leave quietly short of it either.
    if (uploads && (uploads.pending() > 0 || uploads.problems() > 0)) { setWaiting(true); return; }
    if (!bodyNow() && !uploads?.fileIds().length) return;
    // The check for a mention may still be out, and a warning that arrives after the message has left is no warning.
    if (notice) { finish(); return; }
    if (check.checking || agentChecking) { sendWhenChecked.current = true; return; }
    gateSend(!!check.warning || !!agentWarning, finish);
  }, [bodyNow, tooLong, check.checking, check.warning, finish, notice, uploads, agentChecking, agentWarning]);

  // Everything's in, so a message that was waiting goes. One with a failure stays here until someone decides.
  useEffect(() => {
    if (waiting && !pending && !stuck) { setWaiting(false); send(); }
  }, [waiting, pending, stuck, send]);
  const sendWithout = () => uploading.filter((u) => u.state !== "done").forEach((u) => uploads?.remove(u.key));
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = attach ? pastedFiles(e) : [];
    if (!files.length) return;
    e.preventDefault();
    uploads?.add(files);
  };
  const dropReady = (key: string, id: number) => {
    uploads?.remove(key);
    void filesApi.remove(id).catch(() => {});
  };

  useEffect(() => {
    if (check.checking || agentChecking || !sendWhenChecked.current) return;
    sendWhenChecked.current = false;
    gateSend(!!check.warning || !!agentWarning, finish);
  }, [check.checking, check.warning, finish, agentChecking, agentWarning]);

  /** "Send without agent": their mentions become plain names, so the message goes and asks nothing of them. */
  const sendWithoutAgents = () => {
    if (!agentWarning) return;
    const next = decodeBody(withoutAgents(bodyNow(), agentWarning.missing), names);
    picks.current = next.picks;
    setValue(next.text);
    gateSend(!!check.warning, finish);
  };
  /** "Add and send": they join the space first, so the mention reaches them and starts their work. */
  const addAgentsAndSend = async () => {
    if (!agentWarning) return;
    for (const a of agentWarning.missing) {
      const added = await api.addSpaceMember(agentWarning.space_id, a.id);
      if (!added.added) throw new Error(added.warning ?? `${a.name} couldn't be added. Try again.`);
    }
    setNamedOut([]);
    gateSend(!!check.warning, finish);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (menuOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % options.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + options.length) % options.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(options[active]); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setTrigger(null); return; }
    }
    if (e.key === "Escape" && onCancel) { e.preventDefault(); e.stopPropagation(); onCancel(); return; }
    if (matchesStep(e.nativeEvent, shortcut("composer.send")) && !coarse()) { e.preventDefault(); send(); return; }
    if (matchesStep(e.nativeEvent, shortcut("composer.edit-last")) && !text.current && onEditLast) { e.preventDefault(); onEditLast(); }
  };

  const canSend = (hasText || uploading.length > 0) && !tooLong;
  return (
    <div className="relative flex flex-col gap-2" data-kit="composer">
      {agentWarning && <AgentMentionWarning check={agentWarning} onAddAndSend={addAgentsAndSend} onSendWithout={sendWithoutAgents} />}
      {check.warning && audience && (
        <MentionWarning check={check.warning} variant={notice ? "notice" : "composer"} crm={crm} addMember={api.addSpaceMember} onAdded={check.recheck} onProceed={() => { check.dismiss(); if (!notice) finish(); }}
          onRemove={() => { const next = decodeBody(crm ? stripNames(bodyNow(), check.warning!.missing.map((p) => p.id)) : stripRecords(bodyNow()), names); picks.current = next.picks; setValue(next.text); persist(next.text); area.current?.focus(); }} />
      )}
      {menuOpen && (
        <ul role="listbox" id="composer-options" aria-label={trigger?.char === "@" ? "People" : "Channels and tasks"} className="absolute bottom-full z-20 mb-1 max-h-64 w-72 max-w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
          {options.map((o, i) => (
            <li key={o.key} id={`composer-option-${o.key}`} role="option" aria-selected={i === active}>
              <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)}
                className={cn("flex min-h-8 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left text-body max-sm:min-h-11", i === active && "bg-muted")}>
                <o.icon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", o.agent && "text-agent-text")} />
                <span className="truncate">{o.label}</span>
                {o.hint && <span className="ml-auto shrink-0 text-caption text-muted-foreground">{o.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {uploading.length > 0 && (
        <div data-testid="composer-files" className="flex flex-col gap-1">
          {ready.length > 0 && <ul aria-label="Ready to send" className="flex flex-wrap gap-1">{ready.map((u) => <li key={u.key} className="max-w-full min-w-0 sm:w-56"><FileCard file={u.file!} removeLabel={`Take ${u.name} off this message`} onRemove={() => dropReady(u.key, u.file!.id)} /></li>)}</ul>}
          <UploadRows uploads={uploading} set={uploads} />
          {waiting && pending > 0 && <p role="status" data-testid="composer-waiting" className="px-1 text-caption text-muted-foreground">Your message will send when {pending === 1 ? "this file is" : "these files are"} in.</p>}
          {waiting && !pending && stuck > 0 && <p role="alert" data-testid="composer-file-warning" className="flex flex-wrap items-center gap-2 px-1 text-caption text-destructive">{stuck === 1 ? "A file didn't make it." : `${stuck} files didn't make it.`} Your message hasn't been sent.<Button type="button" size="xs" variant="outline" data-testid="composer-send-without" onClick={sendWithout} className="max-sm:min-h-11">Leave {stuck === 1 ? "it" : "them"} out</Button></p>}
        </div>
      )}
      <div className="flex items-end gap-1 rounded-lg border bg-card p-1 transition-colors focus-within:border-control">
        {attach && <>{picker.element}<Button type="button" size="icon-sm" variant="ghost" aria-label="Attach a file" data-testid="composer-attach" onClick={picker.open} className="text-muted-foreground max-sm:size-11"><Paperclip /></Button></>}
        <div className="relative flex min-w-0 flex-1">
          {empty && <span aria-hidden data-testid="composer-placeholder" className="pointer-events-none absolute inset-x-0 top-0 truncate px-2 py-1.5 text-body text-muted-foreground max-sm:py-3">{placeholder}</span>}
          <textarea ref={area} rows={1} defaultValue={start.text} aria-label={placeholder} data-testid="composer-input"
            role="combobox" aria-expanded={menuOpen} aria-controls="composer-options" aria-autocomplete="list" aria-activedescendant={menuOpen ? `composer-option-${options[active]?.key}` : undefined}
            onChange={(e) => change(e.target.value, e.target.selectionStart)} onKeyDown={onKeyDown} onPaste={onPaste}
            onSelect={(e) => { const found = activeTrigger(e.currentTarget.value, e.currentTarget.selectionStart); if (found || shown.current.trigger) setTrigger((was) => (!was && !found ? was : found)); }}
            className="max-h-48 min-h-8 min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-body [field-sizing:content] outline-none max-sm:min-h-11 max-sm:py-3" />
        </div>
        {onCancel && <Button type="button" size="sm" variant="ghost" onClick={onCancel} className="max-sm:min-h-11">Cancel</Button>}
        <Button type="button" size={onCancel ? "sm" : "icon-sm"} variant={canSend ? "default" : "ghost"} disabled={!canSend} aria-label={submitLabel} data-testid="composer-send" onClick={send} className={cn(!onCancel && "max-sm:size-11", onCancel && "max-sm:min-h-11")}>
          {onCancel ? submitLabel : <ArrowUp />}
        </Button>
      </div>
      {nearLimit > 0 && <p className={cn("px-1 text-caption tabular-nums", tooLong ? "text-destructive" : "text-muted-foreground")} role={tooLong ? "alert" : undefined}>{tooLong ? `${(nearLimit - LONGEST).toLocaleString()} characters over. Shorten this to send it.` : `${(LONGEST - nearLimit).toLocaleString()} characters left`}</p>}
      {onCancel && <p className="hidden items-center gap-1 px-1 text-caption text-muted-foreground md:flex"><KeyHint shortcut={shortcut("composer.send")} />to save, <KeyHint shortcut="escape" />to cancel</p>}
    </div>
  );
});

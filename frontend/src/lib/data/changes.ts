// Catching up. Frames are fire-and-forget, so each channel keeps the last sequence number this tab applied. A frame that
// skips a number, a reconnect, a return to the tab and a slow timer all ask the server what came after it. Numbers commit
// in order, so reading up to N means nothing below N can still turn up.
export type ChangeEntry = { seq: number; entity: string; entity_id: number; op: string; actor_id: number; at?: number };
export type ChangeRead = (channel: string, after: number) => Promise<{ seq: number; items: ChangeEntry[] }>;

export function createChangeFollower({ read, apply, started }: {
  read: ChangeRead;
  apply: (channel: string, entry: ChangeEntry) => void;
  /** The starting point is known. Something from just before it may have no frame coming, so refresh what can't wait. */
  started?: (channel: string) => void;
}) {
  const last = new Map<string, number>();
  const reading = new Map<string, Promise<void>>();
  const again = new Set<string>();

  const pull = async (channel: string) => {
    const from = last.get(channel);
    if (from === undefined) {
      const { seq } = await read(channel, -1);
      if (!last.has(channel)) last.set(channel, seq);
      started?.(channel);
      return;
    }
    for (;;) {
      const after = last.get(channel);
      if (after === undefined) return;   // left while reading
      const { seq, items } = await read(channel, after);
      for (const e of items) {
        if (e.seq <= (last.get(channel) ?? Infinity)) continue;
        last.set(channel, e.seq);
        apply(channel, e);
      }
      if (!items.length || (last.get(channel) ?? seq) >= seq) return;
    }
  };

  /**
   * One read per channel at a time. A failure waits for the next catch-up, and the number hasn't moved, so nothing is lost.
   * Asking while a read is out reads once more after it: that read may have been answered before what prompted this
   * committed, and a frame that showed a gap was dropped on the promise that a catch-up would fetch it.
   */
  const catchUpOn = (channel: string) => {
    const running = reading.get(channel);
    if (running) { again.add(channel); return running; }
    const run = (async () => {
      do {
        again.delete(channel);
        await pull(channel).catch(() => {});
      } while (again.has(channel));
      reading.delete(channel);
    })();
    reading.set(channel, run);
    return run;
  };

  return {
    /**
     * Call once the channel is joined, so nothing can slip between the starting point and the first frame. A new channel
     * starts from where it is now; one joined again asks what it missed while it was off.
     */
    follow(channel: string) { void catchUpOn(channel); },
    forget(channel: string) { last.delete(channel); },
    /** A frame arrived. True when it's the next one, for the caller to apply. Otherwise it's a repeat, or the catch-up has it. */
    saw(channel: string, seq: number): boolean {
      const at = last.get(channel);
      if (at === undefined || seq === at + 1) { last.set(channel, seq); return true; }
      if (seq > at) void catchUpOn(channel);
      return false;
    },
    catchUp() { return Promise.all([...last.keys()].map(catchUpOn)).then(() => {}); },
  };
}

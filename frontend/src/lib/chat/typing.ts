// Who's typing, at a rate the cloud carries easily: one frame every 3 seconds at most. Frames ride their own channel and
// are never stored, so anything lost only means a name shows late, and each name expires by itself.
const RESEND_MS = 3000;
const IDLE_MS = 5000;
const EXPIRE_MS = 6000;
/** Above this, "typing" is noise, and the frames cost more than they tell anyone. */
export const TYPING_MOST_MEMBERS = 100;

export function createTypingSender(send: (state: "on" | "off") => void) {
  let lastOn = -Infinity;
  let active = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(idle);
    if (!active) return;
    active = false;
    lastOn = -Infinity;
    send("off");
  };
  return {
    input() {
      const now = Date.now();
      if (now - lastOn >= RESEND_MS) { lastOn = now; active = true; send("on"); }
      clearTimeout(idle);
      idle = setTimeout(stop, IDLE_MS);
    },
    stop,
  };
}

export function createTypingList(me: number, changed: () => void) {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const drop = (id: number) => {
    const t = timers.get(id);
    if (t === undefined) return;
    clearTimeout(t);
    timers.delete(id);
    changed();
  };
  return {
    /** `others` leaves out the socket, not the person: this person's other tab is heard too, and dropped here. */
    frame(from: number, state: string) {
      if (from === me || !from) return;
      if (state !== "on") { drop(from); return; }
      const fresh = !timers.has(from);
      clearTimeout(timers.get(from));
      timers.set(from, setTimeout(() => drop(from), EXPIRE_MS));
      if (fresh) changed();
    },
    /** Their message arrived, so they've stopped. */
    sent: drop,
    ids: () => [...timers.keys()],
    clear() { for (const t of timers.values()) clearTimeout(t); timers.clear(); },
  };
}

export function typingLine(names: string[]): string {
  if (!names.length) return "";
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are typing`;
  return "Several people are typing";
}

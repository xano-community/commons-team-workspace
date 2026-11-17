// Opens the "?" sheet, which loads the first time someone asks for it.
import { Suspense, lazy, useEffect, useState } from "react";

const ShortcutsSheet = lazy(() => import("./shortcuts-sheet"));
const OPEN = "base:shortcuts";
export const openShortcuts = () => window.dispatchEvent(new Event(OPEN));

/** Mount once in the shell. */
export function Shortcuts() {
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    const on = () => { setAsked(true); setOpen(true); };
    window.addEventListener(OPEN, on);
    return () => window.removeEventListener(OPEN, on);
  }, []);
  return asked ? <Suspense fallback={null}><ShortcutsSheet open={open} setOpen={setOpen} /></Suspense> : null;
}

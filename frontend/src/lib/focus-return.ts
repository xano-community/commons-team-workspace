// Where focus goes when a dialog closes. Radix hands it back to a DialogTrigger, but this app opens its dialogs from state:
// a button's click, a menu item, a key. With no trigger, Radix drops focus on the page body, and a keyboard or screen reader
// user starts again from the top (R39).
//
// The dialog can't always ask where focus was when it opened. A field with autoFocus inside it takes focus while React mounts
// it, and Radix then skips its open handler altogether. A menu item that opened it is already on its way out. So this keeps
// the last element focused outside any overlay, and a dialog with nothing better returns there.
import { useRef } from "react";

const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]';
let lastOutside: HTMLElement | null = null;

const outside = (el: EventTarget | null): el is HTMLElement => el instanceof HTMLElement && el !== document.body && !el.closest(OVERLAY);

if (typeof document !== "undefined") {
  document.addEventListener("focusin", (e) => { if (outside(e.target)) lastOutside = e.target; }, true);
  // Focus left for nowhere, such as a click on the page itself: nothing outside holds it any more. Checked a moment later,
  // because focus can pass through the body on its way into a dialog that's mounting.
  document.addEventListener("focusout", (e) => {
    const left = e.target;
    if (outside(left)) setTimeout(() => { if (lastOutside === left && (!document.activeElement || document.activeElement === document.body)) lastOutside = null; }, 0);
  }, true);
}

type Handler = ((event: Event) => void) | undefined;

/** Handlers for a dialog's content: remember the opener as it opens, and hand focus back to it as it closes. */
export function useFocusReturn(onOpenAutoFocus: Handler, onCloseAutoFocus: Handler) {
  const from = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: (event: Event) => {
      const active = document.activeElement;
      const container = event.currentTarget instanceof Node ? event.currentTarget : null;
      // A dialog opened from inside another dialog returns to the button in that dialog.
      from.current = active instanceof HTMLElement && active !== document.body && !container?.contains(active) && !active.closest('[role="menu"], [role="listbox"]') ? active : lastOutside;
      onOpenAutoFocus?.(event);
    },
    onCloseAutoFocus: (event: Event) => {
      onCloseAutoFocus?.(event);
      const to = from.current ?? lastOutside;
      from.current = null;
      if (event.defaultPrevented || !to?.isConnected) return;
      event.preventDefault();
      to.focus();
    },
  };
}

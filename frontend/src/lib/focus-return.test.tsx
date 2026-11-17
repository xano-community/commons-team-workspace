import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog";

afterEach(cleanup);

/** A dialog opened from state, as the app opens them: no DialogTrigger for Radix to return to. */
function FromState({ alert = false, autoFocus = false }: { alert?: boolean; autoFocus?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open it</button>
      <button type="button">Somewhere else</button>
      {alert ? (
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogContent>
            <AlertDialogTitle>Sure?</AlertDialogTitle>
            <AlertDialogDescription>It can't be undone.</AlertDialogDescription>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
          </AlertDialogContent>
        </AlertDialog>
      ) : (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogTitle>Invite someone</DialogTitle>
            <DialogDescription>They get a link.</DialogDescription>
            <input aria-label="Email" autoFocus={autoFocus} />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

const openAndEscape = async () => {
  const opener = screen.getByRole("button", { name: "Open it" });
  act(() => opener.focus());
  await act(async () => { fireEvent.click(opener); });
  const dialog = await waitFor(() => { const d = document.querySelector('[role="dialog"], [role="alertdialog"]'); if (!d) throw new Error("no dialog"); return d; });
  expect(dialog.contains(document.activeElement)).toBe(true);
  await act(async () => { fireEvent.keyDown(document.activeElement!, { key: "Escape" }); });
  return opener;
};

describe("closing a dialog with no trigger", () => {
  it("hands focus back to the button that opened it", async () => {
    render(<FromState />);
    const opener = await openAndEscape();
    await waitFor(() => expect(document.activeElement).toBe(opener), { timeout: 500 });
  });

  it("does so even when a field inside took focus as it mounted", async () => {
    render(<FromState autoFocus />);
    const opener = await openAndEscape();
    await waitFor(() => expect(document.activeElement).toBe(opener), { timeout: 500 });
  });

  it("does so for a confirmation too", async () => {
    render(<FromState alert />);
    const opener = await openAndEscape();
    await waitFor(() => expect(document.activeElement).toBe(opener), { timeout: 500 });
  });

  it("doesn't send focus to an old element once focus has left for nowhere", async () => {
    render(<FromState autoFocus />);
    const elsewhere = screen.getByRole("button", { name: "Somewhere else" });
    act(() => elsewhere.focus());
    act(() => elsewhere.blur());
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open it" })); });
    await screen.findByRole("dialog");
    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: "Escape" }); });
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(document.activeElement).not.toBe(elsewhere);
  });
});

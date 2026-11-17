// The "?" sheet: every shortcut, straight from the command registry, so what it lists is what the keys do.
import { useMemo } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { KeyHint } from "@/components/kit";
import { catalogCommands, useCommandList } from "@/lib/commands";

export default function ShortcutsSheet({ open, setOpen }: { open: boolean; setOpen: (open: boolean) => void }) {
  const live = useCommandList();
  const rows = useMemo(() => {
    // Live commands, and the keys a list answers to on its own screens. Screens that don't exist yet stay out.
    const rest = catalogCommands().filter((c) => !c.id.startsWith("nav.") && c.scope !== "modal" && !live.some((l) => l.id === c.id));
    return [...live, ...rest].filter((c) => c.shortcut && c.label && c.scope !== "modal");
  }, [live]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md" data-kit="shortcuts">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Single keys work anywhere except while you're typing.</DialogDescription>
        </DialogHeader>
        <dl tabIndex={0} aria-label="Shortcuts" className="focus-ring-inset max-h-[60vh] divide-y overflow-y-auto text-body">
          {rows.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-4 py-1.5">
              <dt className="text-muted-foreground">{c.label}</dt>
              <dd className="shrink-0"><KeyHint shortcut={c.shortcut!} /></dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}

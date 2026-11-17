// The header bell (BASELINE.md): the inbox's unread count. What it opens loads on first use (notifications-panel.tsx). A new
// item arrives live, as a toast with Open, unless the person is looking at it already.
import { Suspense, lazy, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useEntityQuery } from "@/lib/data";
import { shellToast } from "@/lib/toast";
import { baseApi } from "./api";
import { useInboxPush } from "./live";

const NotificationPanel = lazy(() => import("./notifications-panel"));

/** A toast names what arrived, not what it's about: frames carry ids, so no record's name passes through here. */
const ARRIVED: Record<string, string> = {
  mention: "You were mentioned", dm: "New direct message", assigned: "A task was assigned to you", approval: "An approval is waiting",
  agent_question: "An agent has a question", agent_result: "An agent finished", agent_failure: "An agent's run failed",
};

/** The bell's number, as a record: a write can move it with the rows it changes, and roll both back together. */
export const UNREAD = "notification-count";

/**
 * How many unread notifications the signed-in person has, kept current: a new one arriving live, or one read
 * anywhere in the app, updates every place that shows the number (the bell, the overview).
 */
export function useUnreadCount() {
  const unread = useEntityQuery(UNREAD, ["count"], async () => ({ id: "unread", ...(await baseApi.unread()) }));
  return { count: unread.data?.count ?? 0, loading: !unread.data };
}

/** The header bell: the unread count, and the latest few when it's opened. */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const unread = useUnreadCount();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useInboxPush((n) => {
    const looking = pathname === "/inbox" || pathname === n.link.split("?")[0];
    if (n.op !== "created" || looking) return;
    shellToast.show(ARRIVED[n.kind] ?? "New in your inbox", n.link ? { label: "Open", onClick: () => navigate(n.link) } : undefined);
  });
  const count = unread.count;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="relative" data-kit="notification-bell" aria-label={count ? `Inbox, ${count} unread` : "Inbox"}>
              <Bell />
              {count > 0 && <span data-kit="notification-count" className="pointer-events-none absolute top-0.5 right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-micro leading-none font-medium text-primary-foreground tabular-nums ring-2 ring-background">{count > 99 ? "99+" : count}</span>}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Inbox</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" collisionPadding={8} className="w-[min(20rem,calc(100vw-1rem))] p-0">
        <Suspense fallback={<div className="h-24" />}>{open && <NotificationPanel onClose={() => setOpen(false)} />}</Suspense>
      </PopoverContent>
    </Popover>
  );
}

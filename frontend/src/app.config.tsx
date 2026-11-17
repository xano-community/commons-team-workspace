// The app's frontend config (BASELINE.md): its name and icon, its screens, its nav, its ⌘K actions and record
// search, its permissions in plain words, and its assistant. The base app (src/base) builds everything else from it:
// sign-in, the shell, notifications, activity, settings, profile, team + invites, agents, approvals, live updates.
import { Building2, CircleCheck, FileText, Files, Inbox, Layers, LayoutDashboard, MessagesSquare, Plus } from "lucide-react";
import { Navigate, useLocation } from "react-router";
import { page, type AppConfig } from "@/base/app";
import { useCan } from "@/base/access";
import { useUnreadCount } from "@/base/notifications";
import { NAV_KEYS } from "@/lib/commands";
import { useDmSection, useSpacesSection } from "@/lib/data";
import { useChatPalette, useChatUnread } from "@/lib/chat/client";
import { useCrmPalette } from "@/lib/crm/palette";
import { useDocPalette } from "@/lib/docs/palette";
import { recentItems, searchAll } from "@/lib/search/palette";
import { useTaskPalette } from "@/lib/tasks/palette";

/** The nav says Customers, so an address that says so too lands there, with the rest of it kept. */
function CustomersAlias() {
  const { pathname, search, hash } = useLocation();
  return <Navigate replace to={`${pathname.replace(/^\/customers/, "/crm")}${search}${hash}`} />;
}

export const config: AppConfig = {
  name: "Commons",
  icon: Layers,
  tagline: "Pick a person to try it as, or sign in with your account.",
  pitch: "Chat, tasks, docs and customers for a small team, with AI agents that work beside you and ask before they act.",

  // The domain's screens. "/" is the overview (pages/overview.tsx). Each is lazy, so it loads on its own.
  routes: [
    { path: "/", lazy: page(() => import("./pages/overview"), "OverviewPage") },
    { path: "/inbox", handle: { bleed: true }, lazy: page(() => import("./pages/inbox"), "InboxPage") },
    { path: "/notifications", handle: { bleed: true }, lazy: page(() => import("./pages/inbox"), "NotificationsRoute") },
    { path: "/chat", handle: { bleed: true }, lazy: page(() => import("./pages/chat"), "ChatIndexPage") },
    { path: "/chat/:id", handle: { bleed: true }, lazy: page(() => import("./pages/chat"), "ChatPage") },
    // A task opens over its list, which stays mounted behind it.
    { path: "/tasks", handle: { bleed: true }, lazy: page(() => import("./pages/tasks"), "TasksPage"), children: [{ path: ":id", lazy: page(() => import("./pages/tasks/detail"), "TaskSheet") }] },
    { path: "/docs", handle: { bleed: true }, lazy: page(() => import("./pages/docs"), "DocsPage") },
    { path: "/docs/:id", handle: { bleed: true }, lazy: page(() => import("./pages/docs/doc"), "DocPage") },
    { path: "/customers/*", element: <CustomersAlias /> },
    { path: "/crm", handle: { bleed: true }, lazy: page(() => import("./pages/crm"), "PipelinePage") },
    { path: "/crm/companies", handle: { bleed: true }, lazy: page(() => import("./pages/crm/lists"), "CompaniesPage") },
    { path: "/crm/companies/:id", handle: { bleed: true }, lazy: page(() => import("./pages/crm/company"), "CompanyPage") },
    { path: "/crm/contacts", handle: { bleed: true }, lazy: page(() => import("./pages/crm/lists"), "ContactsPage") },
    { path: "/crm/deals/:id", handle: { bleed: true }, lazy: page(() => import("./pages/crm/deal"), "DealPage") },
    { path: "/files", handle: { bleed: true }, lazy: page(() => import("./pages/files"), "FilesPage") },
    { path: "/files/:id", handle: { bleed: true }, lazy: page(() => import("./pages/files/file"), "FilePage") },
    { path: "/team/agents/:id", lazy: page(() => import("./pages/team/agent"), "AgentPage") },
  ],

  // The sidebar's first groups: the tools, then Spaces from the server. `primary: true` puts an item in the phone's
  // bottom bar (3 at most, then More). `key` is the item's pinned "g then …" letter.
  useNav: () => [
    { items: [
      { href: "/inbox", label: "Inbox", icon: Inbox, badge: useUnreadCount().count, primary: true, key: NAV_KEYS["/inbox"] },
      { href: "/chat", label: "Chat", icon: MessagesSquare, badge: useChatUnread(), primary: true, phoneOnly: true, key: NAV_KEYS["/chat"] },
      { href: "/", label: "Overview", icon: LayoutDashboard, exact: true, key: NAV_KEYS["/"] },
      { href: "/tasks", label: "Tasks", icon: CircleCheck, primary: true, key: NAV_KEYS["/tasks"] },
      { href: "/docs", label: "Docs", icon: FileText, key: NAV_KEYS["/docs"] },
      ...(useCan("crm.read") ? [{ href: "/crm", label: "Customers", icon: Building2, key: NAV_KEYS["/crm"] }] : []),
      { href: "/files", label: "Files", icon: Files, key: NAV_KEYS["/files"] },
    ] },
    useSpacesSection(),
    useDmSection(),
  ],

  // ⌘K: the domain's actions ("New job"), and the records found as you type.
  usePaletteActions: () => [...useTaskPalette(), ...useDocPalette(), ...useCrmPalette(), ...useChatPalette()],
  search: searchAll,
  recents: recentItems,
  noMatch: (q, go) => [{ id: "nomatch.task", label: `Add “${q}” as a task`, group: "Actions", icon: Plus, run: () => go(`/tasks?new=1&title=${encodeURIComponent(q)}`) }],

  // Each permission in xano/rbac.ts, in the app's words: Team and Profile say "Admins can manage the team".
  permissionLabels: {
    "team.manage": "manage the team",
    "crm.read": "open customers",
    "crm.manage": "change the pipeline's stages",
  },

  assistant: {
    name: "Assistant",
    welcome: "Ask what changed, or what's waiting for you.",
    suggestions: ["What changed today?", "What's waiting for me?"],
  },
};

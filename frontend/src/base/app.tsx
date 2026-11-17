// The app frame (BASELINE.md): every route, provider and piece of chrome a template has, built from one config
// (frontend/src/app.config.tsx). A template writes its screens and that config; this file wires the rest:
//   - signed out: sign-in (demo people + email), sign-up, /setup (the first admin), /join/<token> (invites and resets);
//   - signed in: the kit's AppShell (left sidebar, user menu with Profile · Settings · Shortcuts · Theme · Sign out),
//     the header (⌘K, who's online, the notification bell, Ask), ⌘K with the nav, actions and record search,
//     "?" and g-shortcuts, the assistant, live updates, and the base screens: /activity, /settings,
//     /profile, /team, /agents, /approvals, and a 404 for anything else.
import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Link, Navigate, Outlet, RouterProvider, useLocation, useMatches, useNavigate, type RouteObject } from "react-router";
import { Bot, History, Keyboard, MessageCircle, Moon, Settings as SettingsIcon, ShieldCheck, UserPlus, UserRound, Users, type LucideIcon } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AppShell, CommandPalette, EmptyState, LoadError, closeCommandPalette, isCommandPaletteOpen, setThemeMode, toggleCommandPalette, type NavGroup, type PaletteItem,
} from "@/components/kit";
import { NAV_KEYS, SHELL_CATALOG, listenForCommands, navCommandId, useCommandList, useCommands, type Command } from "@/lib/commands";
import { queryClient, useFlushOutbox, useMySpaceIds } from "@/lib/data";
import { loadInTurn, perf, whenIdle } from "@/lib/perf";
import type { Brand } from "./auth-pages";
import type { AssistantConfig } from "./assistant";
import { AccessProvider, useCan } from "./access";
import { usePendingApprovals } from "./approvals-count";
import { onOpenSpaceMembers } from "@/lib/data";
import { onNewConversation, resumeOutbox, type NewConversation } from "@/lib/chat/client";
import { DemoBanner } from "./demo-banner";
import { CrmChannel, LiveProvider, SpaceChannels } from "./live";
import { NotificationBell } from "./notifications";
import { OnlineNow } from "./presence";
import { SessionProvider, isGuest, useSession } from "./session";
import { SessionDialog } from "./session-dialog";
import { Shortcuts, openShortcuts } from "./shortcuts";
import { WorkspaceProvider, useWorkspace } from "./workspace";
import { XANO_HOST } from "./request";
import { useOpenAsItems } from "@/lib/first-run";

export type AppConfig = {
  /** The product's name (the workspace's Settings name replaces it once signed in), icon, and sign-in line. */
  name: string;
  icon: LucideIcon;
  tagline: string;
  /** One line under the app's name on sign-in: what it is and why it's worth a look. */
  pitch?: string;
  /**
   * The domain's screens, inside the signed-in shell, each lazy: `{ path: "/jobs", lazy: page(() => import("./pages/jobs"), "JobsPage") }`.
   * "/" is the overview. Add `handle: { wide: true }` to a board or schedule that needs the full width, or
   * `handle: { bleed: true }` to a screen that fills the pane edge to edge and scrolls itself (chat, a split view).
   */
  routes: RouteObject[];
  /** The domain's nav groups (a hook, so it can call useCan). The base adds Approvals, Agents and Team after them. */
  useNav: () => NavGroup[];
  /** The domain's ⌘K actions ("New job"), a hook too. Nav items, settings and the base's actions are added. */
  usePaletteActions?: () => PaletteItem[];
  /** Records found as the person types in ⌘K. `go(href)` navigates. */
  search?: (q: string, go: (href: string) => void) => Promise<PaletteItem[]>;
  /** ⌘K before anything's typed: what this person opened last. */
  recents?: (go: (href: string) => void) => Promise<PaletteItem[]>;
  /** ⌘K when nothing matched: what can still be done with those words. */
  noMatch?: (q: string, go: (href: string) => void) => PaletteItem[];
  /** Each permission in the app's words ("jobs.assign": "assign jobs"), for Team and Profile. */
  permissionLabels: Record<string, string>;
  /** The assistant (CHATBOT.md): always on, opened from the header's Ask. */
  assistant: AssistantConfig;
};

/** A lazy route's loader: `lazy: page(() => import("./pages/jobs"), "JobsPage")`. Each screen is its own chunk. */
export const page = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  async () => ({ Component: (await load())[name] });

const Assistant = lazy(() => import("./assistant"));
const SpaceMembersDialog = lazy(() => import("./space-members"));
const NewConversationDialog = lazy(() => import("@/pages/chat/new-conversation"));

/** The dialog loads the first time someone opens a space's members. */
function SpaceMembersHost() {
  const [id, setId] = useState<number | null>(null);
  useEffect(() => onOpenSpaceMembers(setId), []);
  return id === null ? null : <Suspense fallback={null}><SpaceMembersDialog spaceId={id} onClose={() => setId(null)} /></Suspense>;
}

/** Starting a channel or a DM can come from the sidebar on any screen, so its dialog sits in the frame. */
function NewConversationHost() {
  const [asked, setAsked] = useState<NewConversation | null>(null);
  useEffect(() => onNewConversation(setAsked), []);
  return asked ? <Suspense fallback={null}><NewConversationDialog asked={asked} onClose={() => setAsked(null)} /></Suspense> : null;
}
const Toaster = lazy(() => import("@/components/ui/sonner").then((m) => ({ default: m.Toaster })));

/** Toasts answer an action, so the toaster can arrive just after the first paint. */
function LateToaster() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 0);
    return () => clearTimeout(t);
  }, []);
  return ready ? <Suspense fallback={null}><Toaster /></Suspense> : null;
}

const EXTRA_SCREENS = [
  { href: "/activity", label: "Activity", icon: History },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
  { href: "/profile", label: "Profile", icon: UserRound },
] as const;

const toPaletteItem = (c: Command): PaletteItem => ({ id: c.id, label: c.label, group: c.group!, icon: c.icon, hint: c.hint, keywords: c.keywords, shortcut: c.shortcut, run: c.run });

/** Every signed-in screen's loader, set once by createApp, so the frame can load their code ahead of a click. */
let screenLoaders: (() => unknown)[] = [];

/**
 * Once the first screen has settled, each screen's code loads in the browser's idle time, one at a time. Going to any of them
 * later then waits only for its data, not for its code to arrive and start.
 */
function useWarmScreens() {
  useEffect(() => loadInTurn(screenLoaders, whenIdle), []);
}

function Frame({ config }: { config: AppConfig }) {
  const { me, signOut } = useSession();
  useWarmScreens();
  const navigate = useNavigate();
  const { name: workspaceName } = useWorkspace();
  const guest = !!me && isGuest(me);
  const pending = usePendingApprovals(!guest);
  // A demo person can open another beside them, in a window of its own (F1).
  const openAs = useOpenAsItems(me);
  const canManage = useCan("team.manage");
  const domainNav = config.useNav();
  const domainActions = config.usePaletteActions?.() ?? [];
  const matches = useMatches();
  const handle = (flag: "wide" | "bleed") => matches.some((m) => (m.handle as Record<string, boolean> | undefined)?.[flag]);
  const name = workspaceName || config.name;
  if (typeof document !== "undefined" && document.title !== name) document.title = name;

  // The assistant loads the first time someone asks, and after that Ask only toggles it.
  const [asked, setAsked] = useState(false);
  const openAssistant = useCallback(() => {
    if (asked) void import("./assistant").then((m) => m.openChatWidget());
    else setAsked(true);
  }, [asked]);

  const nav: NavGroup[] = [
    ...domainNav,
    ...(guest ? [] : [{ label: "Workspace", items: [
      { href: "/approvals", label: "Approvals", icon: ShieldCheck, badge: pending, primary: true, key: NAV_KEYS["/approvals"] },
      { href: "/agents", label: "Agents", icon: Bot, key: NAV_KEYS["/agents"] },
      ...(canManage ? [{ href: "/team", label: "Team", icon: Users, key: NAV_KEYS["/team"] }] : []),
    ] }]),
  ];
  // A space isn't a screen: it narrows the one you're on, so it has no "Go to".
  const screens = [...nav.flatMap((g) => g.items).filter((i) => i.active === undefined), ...EXTRA_SCREENS.map((s) => ({ ...s, key: NAV_KEYS[s.href] }))];
  // One list: the keys, ⌘K and the "?" sheet all read it.
  const commands: Command[] = [
    ...screens.map((i): Command => ({
      id: navCommandId(i.href), label: `Go to ${i.label}`, shortcut: i.key ? `g ${i.key}` : undefined, scope: "global",
      group: "Go to", icon: i.icon, run: () => navigate(i.href),
    })),
    ...domainActions.map((a): Command => ({ ...a, scope: "global" })),
    { id: "palette.toggle", ...SHELL_CATALOG["palette.toggle"], run: toggleCommandPalette },
    { id: "palette.close", ...SHELL_CATALOG["palette.close"], when: isCommandPaletteOpen, run: closeCommandPalette },
    ...(canManage ? [{ id: "team.invite", label: "Invite someone", scope: "global" as const, group: "Actions", icon: UserPlus, run: () => navigate("/team?invite=1") }] : []),
    // A guest has no assistant: it reads across the workspace, and a guest's spaces are all they may see. The route refuses them too.
    ...(guest ? [] : [{ id: "assistant.ask", ...SHELL_CATALOG["assistant.ask"], label: `Ask ${config.assistant.name}`, group: "Actions", icon: MessageCircle, run: openAssistant }]),
    ...openAs.map((o): Command => ({ id: o.kit, label: o.longLabel, scope: "global", group: "Actions", icon: o.icon, run: o.onSelect })),
    { id: "theme.toggle", ...SHELL_CATALOG["theme.toggle"], group: "Actions", icon: Moon, run: () => setThemeMode(document.documentElement.classList.contains("dark") ? "light" : "dark") },
    { id: "shortcuts.open", ...SHELL_CATALOG["shortcuts.open"], group: "Actions", icon: Keyboard, run: openShortcuts },
  ];
  useCommands(commands, commands.map((c) => c.id + c.label).join("|"));
  useEffect(() => listenForCommands(), []);
  const live = useCommandList();
  const recents = useCallback(() => config.recents?.((href) => navigate(href)) ?? Promise.resolve([]), [config, navigate]);
  const noMatch = useCallback((q: string) => config.noMatch?.(q, (href) => navigate(href)) ?? [], [config, navigate]);
  const items = useMemo(() => live.filter((c) => c.group && (c.when?.() ?? true)).map(toPaletteItem), [live]);
  const search = useCallback((q: string) => (config.search ? config.search(q, (href) => navigate(href)) : Promise.resolve([])), [config, navigate]);

  // Anything held comes back on screen and goes out: on arrival, and when the connection returns.
  const flush = useFlushOutbox(me?.id ?? 0);
  const userId = me?.id ?? 0;
  const userName = me?.name;
  useEffect(() => {
    // A message keeps going whichever screen its sender is on.
    const resume = () => { void flush(); if (userId) resumeOutbox(userId, userName ?? ""); };
    resume();
    window.addEventListener("online", resume);
    return () => window.removeEventListener("online", resume);
  }, [flush, userId, userName]);

  if (!me) return null;
  return (
    <AppShell brand={{ name, icon: config.icon }} nav={nav} wide={handle("wide")} bleed={handle("bleed")} banner={<DemoBanner />}
      user={{ name: me.name, email: me.email, detail: me.role.charAt(0).toUpperCase() + me.role.slice(1) }} onSignOut={signOut}
      menu={[
        ...openAs.map(({ longLabel: _, ...item }) => item),
        { label: "Settings", icon: SettingsIcon, onSelect: () => navigate("/settings"), kit: "user-menu-settings" },
        { label: "Keyboard shortcuts", icon: Keyboard, onSelect: openShortcuts, kit: "user-menu-shortcuts", shortcut: SHELL_CATALOG["shortcuts.open"].shortcut },
      ]}
      headerEnd={<>
        <OnlineNow />
        <NotificationBell />
        {!guest && <Button variant="ghost" size="sm" data-testid="ask-assistant" className="max-sm:min-w-11" aria-label={`Ask ${config.assistant.name}`} onClick={openAssistant}><MessageCircle className="text-agent-text" /><span className="max-sm:sr-only">Ask</span></Button>}
      </>}>
      <Outlet />
      <CommandPalette items={items} search={config.search ? search : undefined} recents={recents} noMatch={noMatch} />
      <Shortcuts />
      <SessionDialog />
      <SpaceMembersHost />
      <NewConversationHost />
      {asked && !guest && <Suspense fallback={null}><Assistant config={config.assistant} /></Suspense>}
    </AppShell>
  );
}

/** A resumed session has been away: bring back what was held, and refresh what may have changed meanwhile. */
function ResumeWork() {
  const { me, epoch } = useSession();
  const flush = useFlushOutbox(me?.id ?? 0);
  useEffect(() => {
    if (!epoch) return;
    void flush();
    if (me) resumeOutbox(me.id, me.name);
    void queryClient.invalidateQueries();
  }, [epoch, flush]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function MySpaceChannels() {
  const crm = useCan("crm.read");
  return <><SpaceChannels ids={useMySpaceIds()} />{crm && <CrmChannel />}</>;
}

function Shell({ config }: { config: AppConfig }) {
  const { me, epoch } = useSession();
  const location = useLocation();
  if (!me) return <Navigate to="/sign-in" replace state={{ from: location.pathname + location.search }} />;
  return (
    <AccessProvider userKey={me.id}>
      <LiveProvider userId={me.id} guest={isGuest(me)} epoch={epoch}>
        <WorkspaceProvider>
          <ResumeWork />
          <MySpaceChannels />
          <Frame config={config} />
        </WorkspaceProvider>
      </LiveProvider>
    </AccessProvider>
  );
}

/** What a cold load shows while the first screen's chunk arrives: the shell's outline, not a blank page. */
function FirstPaint() {
  return (
    <div className="flex h-svh" aria-busy="true">
      <div className="hidden w-64 shrink-0 space-y-2 border-r bg-sidebar p-3 md:block">{[0, 1, 2, 3].map((i) => <Skeleton key={`skeleton-${i}`} className="h-7 w-full" />)}</div>
      <div className="min-w-0 flex-1">
        <div className="h-12 border-b" />
        <div className="mx-auto max-w-6xl space-y-3 p-4 sm:p-6"><Skeleton className="h-6 w-56" /><Skeleton className="h-24 w-full" /></div>
      </div>
    </div>
  );
}

/** A guest has only their spaces. The server refuses these screens anyway; this sends them somewhere useful. */
function MembersOnly({ children }: { children: ReactNode }) {
  const { me } = useSession();
  return me && isGuest(me) ? <Navigate to="/" replace /> : children;
}

function NotFound() {
  return (
    <div className="py-12" data-testid="not-found">
      <EmptyState title="This page doesn't exist" description="The link may be old, or the address has a typo."
        action={<Button asChild size="sm"><Link to="/">Go to the overview</Link></Button>} />
    </div>
  );
}

function RouteError() {
  return (
    <main className="grid min-h-svh place-items-center p-6">
      <LoadError title="This page broke" error="Something on this screen failed. Reload, or go back to the overview." onRetry={() => location.assign("/")} />
    </main>
  );
}

/** The whole app from its config: `export default createApp(config)` in App.tsx. */
export function createApp(config: AppConfig) {
  const brand: Brand = { name: config.name, icon: config.icon, tagline: config.tagline, pitch: config.pitch };
  const base = (load: () => Promise<Record<string, unknown>>, pick: (m: Record<string, unknown>) => React.ComponentType) =>
    async () => ({ Component: pick(await load()) });
  const signedOut = (pick: (m: typeof import("./auth-pages")) => React.ComponentType<{ brand: Brand }>) =>
    async () => { const Page = pick(await import("./auth-pages")); return { Component: () => <Page brand={brand} /> }; };
  const screens = [
    ...config.routes,
    { path: "/activity", lazy: base(() => import("./activity"), (m) => m.ActivityPage as React.ComponentType) },
    { path: "/settings", lazy: base(() => import("./settings"), (m) => m.SettingsPage as React.ComponentType) },
    { path: "/profile", lazy: async () => { const { ProfileRoute } = await import("./profile"); return { Component: () => <ProfileRoute labels={config.permissionLabels} /> }; } },
    { path: "/team", lazy: async () => { const { TeamRoute } = await import("./team"); return { Component: () => <MembersOnly><TeamRoute labels={config.permissionLabels} /></MembersOnly> }; } },
    { path: "/approvals", lazy: async () => { const { ApprovalsPage } = await import("./approvals"); return { Component: () => <MembersOnly><ApprovalsPage /></MembersOnly> }; } },
    { path: "/agents", lazy: async () => { const { AgentsRoute } = await import("./agents"); return { Component: () => <MembersOnly><AgentsRoute appName={config.name} /></MembersOnly> }; } },
  ];
  screenLoaders = screens.flatMap((r) => (typeof r.lazy === "function" ? [r.lazy as () => unknown] : []));
  const router = createBrowserRouter([{
    hydrateFallbackElement: <FirstPaint />,
    children: [
      { path: "/sign-in", lazy: signedOut((m) => m.SignInPage) },
      { path: "/sign-up", lazy: signedOut((m) => m.SignUpPage) },
      { path: "/join/:token", lazy: signedOut((m) => m.JoinPage) },
      { path: "/setup", lazy: signedOut((m) => m.SetupPage) },
      {
        element: <Shell config={config} />,
        errorElement: <RouteError />,
        children: [
          ...screens,
          { path: "*", element: <NotFound /> },
        ],
      },
    ],
  }]);
  // A route that's already loaded changes location with no loading state between, so both are watched.
  let at = router.state.location.key, timing = false;
  router.subscribe((state) => {
    if (state.navigation.state === "loading" && !timing) { perf.start("navigation"); timing = true; }
    if (state.location.key === at) return;
    at = state.location.key;
    if (!timing) perf.start("navigation");
    timing = false;
    perf.endAfterPaint("navigation");
  });
  return function App() {
    return (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <SessionProvider><RouterProvider router={router} /></SessionProvider>
          <LateToaster />
        </TooltipProvider>
      </QueryClientProvider>
    );
  };
}

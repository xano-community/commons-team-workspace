import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { ChevronsUpDown, Menu, Moon, Sun, type LucideIcon } from "lucide-react";
import { Avatar, initialsOf } from "./avatar";
import { Button } from "@/components/ui/button";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset,
  SidebarGroupAction, SidebarMenu, SidebarMenuAction, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, SidebarProvider, SidebarTrigger, useSidebar,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SHELL_CATALOG, useCommands, useShortcut } from "@/lib/commands";
import { cn } from "@/lib/utils";
import { PaletteButton } from "./command-palette";
import { KeyHint } from "./key-hint";
import { useTheme } from "./theme";
import { rememberedHref } from "./url-state";
import type { UserMenuProps } from "./user-menu";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** A count that needs attention (approvals waiting). Hidden at 0. */
  badge?: number;
  /** Show in the phone's bottom bar (pick the 3 or 4 most-used; the rest stay in the menu). */
  primary?: boolean;
  /** Match only this exact path (an overview at "/"). */
  exact?: boolean;
  /** The pinned letter of its "g then …" shortcut (NAV_KEYS). Pinned, so adding a screen never moves another's key. */
  key?: string;
  /** A small control at the row's end. */
  action?: { label: string; icon: LucideIcon; onClick: () => void };
  /** A second one, beside it. */
  extra?: { label: string; icon: LucideIcon; onClick: () => void };
  /** Rows under this one: a space's channels. */
  children?: NavItem[];
  /** There's something here this person hasn't read. */
  unread?: boolean;
  /** Belongs to an agent, so its icon takes the agents' colour. */
  agent?: boolean;
  /** Only in the phone's bottom bar, for a screen the sidebar reaches some other way. */
  phoneOnly?: boolean;
  /** A mark beside the label, and what it means on hover: a private space's lock. */
  mark?: { icon: LucideIcon; label: string };
  /** A toggle, not a place: it narrows the screen you're on instead of going somewhere. Rendered as a pressed button. */
  onSelect?: () => void;
  /** Says for itself whether it's the current one, for an item the path can't decide: a space is a URL parameter. */
  active?: boolean;
}
/**
 * A sidebar section. One built from live data (Spaces) has a `key`, says when it's `loading`, and is hidden when it has
 * nothing to show.
 */
export interface NavGroup { key?: string; label?: string; items: NavItem[]; loading?: boolean; action?: { label: string; icon: LucideIcon; onClick: () => void } }
/** One more entry in the user menu, under Profile (Settings, Keyboard shortcuts). */
export interface MenuItem { label: string; icon: LucideIcon; onSelect: () => void; kit?: string; shortcut?: string }

export { useTheme } from "./theme";

export { initialsOf } from "./avatar";

const isActive = (pathname: string, item: NavItem) => item.active
  ?? (item.exact || item.href === "/" ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + "/"));

/** The scroll pane and the column inside it: a reading column, the full width, or the whole pane. */
export function shellContent({ wide = false, bleed = false }: { wide?: boolean; bleed?: boolean }) {
  return bleed
    ? { pane: "min-h-0 flex-1 overflow-hidden", column: "h-full w-full" }
    : { pane: "min-h-0 flex-1 overflow-y-auto", column: cn("mx-auto w-full space-y-6 p-4 sm:p-6", wide ? "max-w-none" : "max-w-6xl") };
}

function NavRow({ item: it }: { item: NavItem }) {
  return (
    <>
      <it.icon className={it.agent ? "text-agent-text" : undefined} />
      <span className={cn("truncate", it.unread && "font-medium text-foreground")}>{it.label}</span>
      {it.mark && <span title={it.mark.label} className="ml-auto grid place-items-center text-muted-foreground"><it.mark.icon aria-hidden className="size-3" /><span className="sr-only">{it.mark.label}</span></span>}
    </>
  );
}

function NavLinks({ groups }: { groups: NavGroup[] }) {
  const { pathname } = useLocation();
  const { setOpenMobile } = useSidebar();
  return (
    <>
      {groups.map((g) => ({ ...g, items: g.items.filter((i) => !i.phoneOnly) })).filter((g) => g.loading || g.items.length || g.action).map((g, gi) => (
        <SidebarGroup key={g.key ?? g.label ?? gi} data-nav-section={g.key}>
          {g.label && <SidebarGroupLabel>{g.label}</SidebarGroupLabel>}
          {g.action && <SidebarGroupAction aria-label={g.action.label} title={g.action.label} onClick={() => { setOpenMobile(false); g.action!.onClick(); }}><g.action.icon /></SidebarGroupAction>}
          <SidebarGroupContent>
            <SidebarMenu>
              {g.loading && !g.items.length && [0, 1].map((i) => <Skeleton key={`skeleton-${i}`} className="mx-2 my-1.5 h-5" />)}
              {g.items.map((it) => (
                <SidebarMenuItem key={it.href}>
                  <SidebarMenuButton asChild isActive={isActive(pathname, it)} tooltip={it.label}
                    className="data-[active=true]:[&>svg]:text-primary-text">
                    {/* Tapping a nav item on a phone navigates AND closes the drawer. */}
                    {it.onSelect ? (
                      <button type="button" aria-pressed={!!it.active} data-nav={it.href} onClick={() => { setOpenMobile(false); it.onSelect!(); }}><NavRow item={it} /></button>
                    ) : (
                      <Link to={rememberedHref(it.href)} data-nav={it.href} onClick={() => setOpenMobile(false)}><NavRow item={it} /></Link>
                    )}
                  </SidebarMenuButton>
                  {it.extra && <SidebarMenuAction showOnHover className="right-7" aria-label={`${it.extra.label}: ${it.label}`} title={it.extra.label} onClick={() => { setOpenMobile(false); it.extra!.onClick(); }}><it.extra.icon /></SidebarMenuAction>}
                  {it.action && <SidebarMenuAction showOnHover aria-label={`${it.action.label}: ${it.label}`} title={it.action.label} onClick={() => { setOpenMobile(false); it.action!.onClick(); }}><it.action.icon /></SidebarMenuAction>}
                  {!!it.badge && <SidebarMenuBadge data-nav-badge={it.href} className="tabular-nums">{it.badge}</SidebarMenuBadge>}
                  {!!it.children?.length && (
                    <SidebarMenuSub className="mr-0 pr-0">
                      {it.children.map((child) => (
                        <SidebarMenuSubItem key={child.href} className="relative">
                          <SidebarMenuSubButton asChild isActive={isActive(pathname, child)}>
                            <Link to={child.href} data-nav={child.href} data-unread={child.unread || undefined} onClick={() => setOpenMobile(false)}><NavRow item={child} /></Link>
                          </SidebarMenuSubButton>
                          {!!child.badge && <SidebarMenuBadge data-nav-badge={child.href} className="top-1 tabular-nums">{child.badge}</SidebarMenuBadge>}
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  );
}

const TAB = "focus-ring-inset relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-micro";

/** The phone's bottom tab bar: the primary nav items, one tap away, and More, which opens the drawer with the rest. */
function BottomNav({ items }: { items: NavItem[] }) {
  const { pathname } = useLocation();
  const { setOpenMobile } = useSidebar();
  return (
    <nav aria-label="Primary" data-kit="bottom-nav" className="grid shrink-0 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
      style={{ gridTemplateColumns: `repeat(${items.length + 1}, minmax(0, 1fr))` }}>
      {items.map((it) => {
        const active = isActive(pathname, it);
        return (
          <Link key={it.href} to={rememberedHref(it.href)} aria-current={active ? "page" : undefined}
            className={cn(TAB, active ? "font-medium text-primary-text" : "text-muted-foreground")}>
            <it.icon aria-hidden className="size-5" />
            <span className="max-w-full truncate px-1">{it.label}</span>
            {!!it.badge && <span className="absolute top-1.5 left-1/2 ml-2 rounded-full bg-primary px-1.5 text-micro font-medium text-primary-foreground tabular-nums">{it.badge}</span>}
          </Link>
        );
      })}
      <button type="button" data-kit="bottom-nav-more" onClick={() => setOpenMobile(true)} className={cn(TAB, "text-muted-foreground")}>
        <Menu aria-hidden className="size-5" />
        <span>More</span>
      </button>
    </nav>
  );
}

/** The sidebar's own command, and the tooltip's key: both have to sit inside the SidebarProvider. */
function SidebarToggle() {
  const { toggleSidebar } = useSidebar();
  const shortcut = useShortcut("sidebar.toggle");
  useCommands([{ id: "sidebar.toggle", ...SHELL_CATALOG["sidebar.toggle"], group: "Actions", icon: Menu, run: toggleSidebar }], "sidebar");
  return (
    <Tooltip>
      <TooltipTrigger asChild><SidebarTrigger aria-label="Menu" /></TooltipTrigger>
      <TooltipContent className="flex items-center gap-2">Menu{shortcut && <KeyHint shortcut={shortcut} />}</TooltipContent>
    </Tooltip>
  );
}

/** The menu's trigger, which is on screen from the first paint. The menu itself loads when the browser is idle, or on a press. */
function UserMenuDoor({ user, compact = false, ...rest }: UserMenuProps) {
  const [Menu, setMenu] = useState<typeof import("./user-menu").UserMenu | null>(null);
  const [pressed, setPressed] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const load = () => void import("./user-menu").then((m) => setMenu(() => m.UserMenu));
    if (pressed) { load(); return; }
    const later = window.requestIdleCallback?.(load) ?? window.setTimeout(load, 200);
    return () => { window.cancelIdleCallback?.(later); clearTimeout(later); };
  }, [pressed]);
  const trigger = compact ? (
    <button ref={button} type="button" data-kit="user-menu-compact" aria-label={`${initialsOf(user.name)}, ${user.name}: profile and settings`} aria-haspopup="menu" onClick={() => setPressed(true)}
      className="focus-ring grid size-11 place-items-center rounded-full">
      <Avatar name={user.name} size="md" decorative />
    </button>
  ) : (
    <button ref={button} type="button" data-kit="user-menu" aria-haspopup="menu" onClick={() => setPressed(true)}
      className="focus-ring-inset flex w-full min-w-0 items-center gap-2 rounded-md p-2 text-left text-body transition-colors hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0">
      <Avatar name={user.name} size="md" decorative />
      <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
        <span className="block truncate font-medium" title={user.name}>{user.name}</span>
        {(user.detail || user.email) && <span className="block truncate text-caption text-muted-foreground" title={user.detail ?? user.email}>{user.detail ?? user.email}</span>}
      </span>
      <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" />
    </button>
  );
  return Menu ? <Menu user={user} compact={compact} {...rest} trigger={trigger} openAtOnce={pressed} /> : trigger;
}

/**
 * The signed-in frame (CRAFT.md §5, §16): sidebar (off-canvas on a phone), a header with the page's
 * search (⌘K) and the theme toggle, a bottom tab bar on a phone, and the one scrolling <main>.
 * Mount <CommandPalette> once inside it.
 */
export function AppShell({ brand, nav, user, onSignOut, profileHref = "/profile", menu, headerEnd, wide = false, bleed = false, banner, children }: {
  brand: { name: string; icon: LucideIcon; href?: string };
  nav: NavGroup[];
  /** Who's signed in: the sidebar's user menu shows them. `detail` is their role or team. */
  user: { name: string; email?: string; detail?: string };
  /** The profile page the user menu opens (ProfilePage). `null`: no profile item. */
  profileHref?: string | null;
  onSignOut: () => void;
  /** More user-menu entries, under Profile. */
  menu?: MenuItem[];
  /** Extra header controls, right-aligned before the theme toggle. */
  headerEnd?: ReactNode;
  /** Use the full width (a board or a schedule), not the reading column. */
  wide?: boolean;
  /** Give the screen the whole pane, edge to edge, and let it do its own scrolling: chat, a board, a split view. */
  bleed?: boolean;
  /** One quiet line across the top of the content. */
  banner?: ReactNode;
  children: ReactNode;
}) {
  const { dark, toggle } = useTheme();
  const themeKey = useShortcut("theme.toggle");
  // Four tabs on a phone: three screens, and More.
  const primary = nav.flatMap((g) => g.items).filter((i) => i.primary).slice(0, 3);
  const content = shellContent({ wide, bleed });
  return (
    <SidebarProvider className="h-svh overflow-hidden">
      {/* Desktop: collapses to an icon rail (labels become tooltips); a phone: an off-canvas drawer. */}
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <Link to={brand.href ?? "/"} className="focus-ring-inset flex items-center gap-2 rounded-md px-2 py-1.5 group-data-[collapsible=icon]:px-0.5">
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground"><brand.icon className="size-4" /></span>
            <span className="truncate text-heading group-data-[collapsible=icon]:hidden">{brand.name}</span>
          </Link>
        </SidebarHeader>
        {/* A tighter rhythm than shadcn's default, so a full workspace's nav fits above the footer on a laptop; past that it
            scrolls under a hairline, never half-hidden behind the footer. */}
        <SidebarContent className="gap-0 [&_[data-slot=sidebar-group]]:py-1 [&_[data-slot=sidebar-menu]]:gap-0.5"><NavLinks groups={nav} /></SidebarContent>
        <SidebarFooter className="border-t border-sidebar-border">
          <UserMenuDoor user={user} profileHref={profileHref} onSignOut={onSignOut} menu={menu} />
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="flex min-h-0 min-w-0 flex-col">
        {banner}
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
          <SidebarToggle />
          <PaletteButton />
          <div className="ml-auto flex items-center gap-1">
            {headerEnd}
            {/* On a phone the header is tight: Theme lives in the avatar's menu there. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="max-sm:hidden" aria-label={dark ? "Use light theme" : "Use dark theme"} onClick={toggle}>{dark ? <Sun /> : <Moon />}</Button>
              </TooltipTrigger>
              <TooltipContent className="flex items-center gap-2">{dark ? "Light theme" : "Dark theme"}{themeKey && <KeyHint shortcut={themeKey} />}</TooltipContent>
            </Tooltip>
            {/* On a phone the sidebar is a drawer: the avatar here is the way to your profile. */}
            <div className="md:hidden"><UserMenuDoor compact user={user} profileHref={profileHref} onSignOut={onSignOut} menu={menu} /></div>
          </div>
        </header>
        <div className={content.pane} data-kit="scroll-pane">
          {/* Block flow, not flex: a page root with mx-auto keeps the full width instead of shrinking to its content. */}
          <div className={content.column} data-kit-wide={wide || undefined} data-kit-bleed={bleed || undefined}>{children}</div>
        </div>
        <BottomNav items={primary} />
      </SidebarInset>
    </SidebarProvider>
  );
}

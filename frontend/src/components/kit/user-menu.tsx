// The sidebar's user menu. It holds the shell's only dropdown, so it loads apart from the shell, once the page is up.
import { useRef, type ReactElement } from "react";
import { useNavigate } from "react-router";
import { LogOut, Monitor, Moon, Sun, UserRound } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSidebar } from "@/components/ui/sidebar";
import { KeyHint } from "./key-hint";
import { useTheme, type ThemeMode } from "./theme";
import type { MenuItem } from "./app-shell";

export type UserMenuProps = {
  user: { name: string; email?: string; detail?: string };
  profileHref: string | null;
  onSignOut: () => void;
  menu?: MenuItem[];
  /** Just the avatar: the phone header's way to the same menu. */
  compact?: boolean;
};

/**
 * Who's signed in, at the foot of the sidebar: their avatar, name and role, and a menu with their profile,
 * the theme, and Sign out (the standard place people look for all three).
 */
export function UserMenu({ user, profileHref, onSignOut, menu = [], compact = false, trigger, openAtOnce = false }: UserMenuProps & { trigger: ReactElement; openAtOnce?: boolean }) {
  const { mode, setMode } = useTheme();
  const navigate = useNavigate();
  const { setOpenMobile } = useSidebar();
  // An item that goes somewhere new shouldn't hand focus back to the trigger (a stuck-looking ring on arrival);
  // Escape or a click away still does, so a keyboard user is right back where they were.
  const went = useRef(false);
  return (
    <DropdownMenu defaultOpen={openAtOnce} onOpenChange={(o) => { if (o) went.current = false; }}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent side={compact ? "bottom" : "top"} align={compact ? "end" : "start"} onCloseAutoFocus={(e) => { if (went.current) e.preventDefault(); }} className={compact ? "min-w-56" : "w-(--radix-dropdown-menu-trigger-width) min-w-56"}>
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate text-body font-medium">{user.name}</span>
          {user.email && <span className="block truncate text-caption text-muted-foreground">{user.email}</span>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {profileHref && (
          <DropdownMenuItem data-kit="user-menu-profile" onSelect={() => { went.current = true; setOpenMobile(false); navigate(profileHref); }}>
            <UserRound />Profile
          </DropdownMenuItem>
        )}
        {menu.map((m) => (
          <DropdownMenuItem key={m.label} data-kit={m.kit} onSelect={() => { went.current = true; setOpenMobile(false); m.onSelect(); }}><m.icon />{m.label}{m.shortcut && <KeyHint shortcut={m.shortcut} className="ml-auto" />}</DropdownMenuItem>
        ))}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{mode === "dark" ? <Moon /> : mode === "light" ? <Sun /> : <Monitor />}Theme</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={mode} onValueChange={(v) => setMode(v as ThemeMode)}>
              <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem data-kit="user-menu-sign-out" onSelect={() => { went.current = true; onSignOut(); }}><LogOut />Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}


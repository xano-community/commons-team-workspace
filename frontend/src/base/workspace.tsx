// What every screen shares about the workspace: its settings (name, time zone, week start) and its people. Both come
// from the query cache, which a live event refreshes: an admin's rename shows in every open tab at once.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { WeekStartProvider } from "@/components/kit";
import { useEntityQuery } from "@/lib/data";
import { baseApi, type Person, type Settings } from "./api";
import { isGuest, useMe } from "./session";

type Ctx = {
  /** The workspace's name, for everyone. `settings` is null for a guest, who can't read them. */
  name: string | null;
  settings: Settings | null;
  /** Why the settings didn't load, once they've failed with nothing to show. */
  settingsError: unknown;
  people: Person[];
  nameOf: (id: number | null | undefined) => string;
  isAgent: (id: number | null | undefined) => boolean;
  reload: () => void;
};
const WorkspaceContext = createContext<Ctx | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const guest = isGuest(useMe());
  const settings = useEntityQuery("settings", [], () => baseApi.settings(), { enabled: !guest });
  const status = useEntityQuery("settings", ["status"], () => baseApi.status(), { enabled: guest });
  const people = useEntityQuery("user", ["people"], () => baseApi.people());
  const value = useMemo<Ctx>(() => {
    const byId = new Map((people.data ?? []).map((p) => [p.id, p]));
    return {
      name: settings.data?.name ?? status.data?.name ?? null,
      settings: settings.data ?? null,
      settingsError: settings.data ? null : settings.error,
      people: people.data ?? [],
      nameOf: (id) => (id ? byId.get(id)?.name ?? "Someone" : "Someone"),
      isAgent: (id) => !!id && byId.get(id)?.kind === "agent",
      reload: () => { void client.invalidateQueries({ queryKey: ["settings"] }); void client.invalidateQueries({ queryKey: ["user"] }); },
    };
  }, [settings.data, settings.error, status.data, people.data, client]);
  // Every calendar and schedule starts its week where Settings says.
  return (
    <WorkspaceContext.Provider value={value}>
      <WeekStartProvider value={settings.data?.week_start ?? "monday"}>{children}</WeekStartProvider>
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): Ctx {
  const w = useContext(WorkspaceContext);
  if (!w) throw new Error("useWorkspace outside the signed-in shell");
  return w;
}

// Starting a task from ⌘K, on any screen. It stays small, because the shell carries it.
import { useMemo } from "react";
import { useNavigate } from "react-router";
import { Plus } from "lucide-react";
import type { PaletteItem } from "@/components/kit";

export function useTaskPalette(): PaletteItem[] {
  const navigate = useNavigate();
  return useMemo(() => [{ id: "tasks.new-anywhere", label: "New task", group: "Actions", icon: Plus, keywords: ["add", "create", "todo"], run: () => navigate("/tasks?new=1") }], [navigate]);
}

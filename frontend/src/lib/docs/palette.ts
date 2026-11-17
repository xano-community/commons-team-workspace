// Starting a doc from ⌘K, on any screen. It stays small, because the shell carries it.
import { useMemo } from "react";
import { useNavigate } from "react-router";
import { Plus } from "lucide-react";
import type { PaletteItem } from "@/components/kit";

export function useDocPalette(): PaletteItem[] {
  const navigate = useNavigate();
  return useMemo(() => [{ id: "docs.new-anywhere", label: "New doc", group: "Actions", icon: Plus, keywords: ["add", "create", "write", "page"], run: () => navigate("/docs?new=1") }], [navigate]);
}

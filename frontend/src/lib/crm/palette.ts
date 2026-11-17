// Starting a customer record from ⌘K, on any screen. It stays small, because the shell carries it.
import { useMemo } from "react";
import { useNavigate } from "react-router";
import { Building2, CircleDollarSign, Plus, User, type LucideIcon } from "lucide-react";
import type { PaletteItem } from "@/components/kit";
import { useCan } from "@/base/access";

export const CRM_ICONS: Record<string, LucideIcon> = { company: Building2, deal: CircleDollarSign, contact: User };

export function useCrmPalette(): PaletteItem[] {
  const navigate = useNavigate();
  const allowed = useCan("crm.read");
  return useMemo(() => (allowed ? [
    { id: "crm.new-deal-anywhere", label: "New deal", group: "Actions", icon: Plus, keywords: ["add", "create", "opportunity", "pipeline"], run: () => navigate("/crm?new=deal") },
    { id: "crm.new-company-anywhere", label: "New company", group: "Actions", icon: Plus, keywords: ["add", "create", "customer", "client"], run: () => navigate("/crm/companies?new=company") },
  ] : []), [allowed, navigate]);
}

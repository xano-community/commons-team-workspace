// What every customer screen stands in: its header, its tabs, and the one answer for someone who can't open customers. The CRM is
// company-wide, so a chosen space doesn't narrow it, and the screen says so rather than quietly showing everything.
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { Building2, Columns3, Lock, Users } from "lucide-react";
import { EmptyState, Segmented } from "@/components/kit";
import { useCan } from "@/base/access";
import { useIsMobile } from "@/hooks/use-mobile";
import { CATALOG, useCommands, type Command } from "@/lib/commands";
import { useSpaceScope } from "@/lib/data";

export type Tab = "pipeline" | "companies" | "contacts";
const HREFS: Record<Tab, string> = { pipeline: "/crm", companies: "/crm/companies", contacts: "/crm/contacts" };
const ORDER: Tab[] = ["pipeline", "companies", "contacts"];

export const Wrap = ({ id, children }: { id: string; children: ReactNode }) => <div data-testid={id} className="flex min-h-0 flex-1 items-center justify-center p-4">{children}</div>;

export function NoCustomers() {
  return <Wrap id="crm-no-access"><EmptyState icon={Lock} className="border-0" title="Customers aren't open to you" description="Your role doesn't include customers. An admin can change that from Team." /></Wrap>;
}

export function CrmFrame({ tab, actions, filters, children }: { tab: Tab; actions?: ReactNode; filters?: ReactNode; children: ReactNode }) {
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const allowed = useCan("crm.read");
  const space = useSpaceScope();
  const go = (t: string) => navigate(HREFS[t as Tab]);
  const commands: Command[] = [{ id: "tasks.toggle-view", ...CATALOG["tasks.toggle-view"], label: "Next customer view", group: "Customers", icon: Columns3, when: () => allowed, run: () => go(ORDER[(ORDER.indexOf(tab) + 1) % ORDER.length]) }];
  useCommands(commands, `crm-frame-${tab}`);
  return (
    <section aria-label="Customers" data-testid="crm-page" className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5">
        <h1 className="min-w-0 truncate text-title max-md:flex-1">Customers</h1>
        {allowed && (
          <Segmented size="sm" label="Show" value={tab} onChange={go} className="max-md:order-last max-md:w-full max-md:[&_button]:min-h-11 max-md:[&_button]:flex-1"
            options={[{ value: "pipeline", label: "Pipeline", icon: Columns3, iconOnly: false }, { value: "companies", label: "Companies", icon: Building2, iconOnly: false }, { value: "contacts", label: "Contacts", icon: Users, iconOnly: false }].map((o) => (mobile ? { ...o, icon: undefined } : o))} />
        )}
        {allowed && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </header>
      {allowed && space !== null && <p role="status" data-testid="crm-all-spaces" className="shrink-0 border-b bg-muted/50 px-4 py-1.5 text-caption text-muted-foreground">Customers are shared across the workspace, so the space you've chosen doesn't narrow them.</p>}
      {allowed && filters}
      {allowed ? children : <NoCustomers />}
    </section>
  );
}

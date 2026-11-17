// What the rest of the workspace holds about a company. The server filters each panel for this viewer and counts after that, so a
// number here can never say more than the rows do. Nothing here is locked, because nothing out of reach is here at all.
import { useState } from "react";
import { CircleCheck, FileText, Files, MessagesSquare, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/kit";
import { LinkChip } from "@/components/workspace/link-chip";
import { AddLink } from "@/components/workspace/links-panel";
import { RecordUpload } from "@/components/workspace/uploader";
import { usePanels } from "@/lib/crm/client";
import type { PanelView, Panels as PanelData } from "@/lib/crm/model";

const SHOW_ALL = 50;
type Key = keyof PanelData;
type Linkable = "conversation" | "task" | "doc" | "file";
const PANELS: { key: Key; label: string; icon: LucideIcon; link?: Linkable; none: string }[] = [
  { key: "chat", label: "Chat", icon: MessagesSquare, link: "conversation", none: "No conversations linked" },
  { key: "tasks", label: "Tasks", icon: CircleCheck, link: "task", none: "No tasks linked" },
  { key: "docs", label: "Docs", icon: FileText, link: "doc", none: "No docs linked" },
  { key: "files", label: "Files", icon: Files, link: "file", none: "No files linked" },
];

function Panel({ company, title, icon: Icon, data, link, none, canLink, onAll }: { company: number; title: string; icon: LucideIcon; data: PanelView; link?: Linkable; none: string; canLink: boolean; onAll?: () => void }) {
  const body = (rows?: React.ReactNode, attach?: React.ReactNode) => <>
      <h3 className="flex items-center gap-1.5 text-caption font-medium"><Icon aria-hidden className="size-3.5 text-muted-foreground" />{title}<span data-testid="panel-count" className="tabular-nums text-muted-foreground">{data.total}</span></h3>
      {data.items.length
        ? <ul className="flex flex-wrap gap-1.5 max-md:[&_[data-kit=link-chip]]:min-h-11">{data.items.map((v) => <li key={`${v.type}-${v.id}`} className="max-w-full min-w-0"><LinkChip view={v} /></li>)}</ul>
        : <p className="text-caption text-muted-foreground">{none}</p>}
      {rows}
      <div className="flex flex-wrap items-center gap-1 empty:hidden">
        {onAll && <Button variant="ghost" size="sm" data-testid="panel-all" onClick={onAll} className="-ml-2 text-muted-foreground max-md:min-h-11">Show all {data.total}</Button>}
        {attach}
        {canLink && link && <AddLink from={{ type: "company", id: company }} into only={link} label="Link" />}
      </div>
  </>;
  const frame = "flex min-w-0 flex-col gap-1.5 rounded-lg border bg-card p-3";
  const id = `panel-${title.toLowerCase()}`;
  if (link === "file" && canLink) return <section aria-label={title} data-testid={id}><RecordUpload place={{ type: "company", id: company }} label="Attach" className={frame}>{({ button, rows }) => body(rows, button)}</RecordUpload></section>;
  return <section aria-label={title} data-testid={id} className={frame}>{body()}</section>;
}

export function CompanyPanels({ company, panels, canLink }: { company: number; panels: PanelData; canLink: boolean }) {
  const [all, setAll] = useState(false);
  const more = usePanels(company, SHOW_ALL, all);
  const data = all && more.data ? more.data : panels;
  return (
    <section aria-label="Linked work" data-testid="crm-panels" className="flex flex-col gap-2">
      <h2 className="text-caption font-medium text-muted-foreground">Linked work</h2>
      {all && more.error && <LoadError title="That didn't load" error={more.error} onRetry={() => void more.refetch()} />}
      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        {PANELS.map((p) => <Panel key={p.key} company={company} title={p.label} icon={p.icon} data={data[p.key]} link={p.link} none={p.none} canLink={canLink} onAll={data[p.key].total > data[p.key].items.length ? () => setAll(true) : undefined} />)}
      </div>
    </section>
  );
}

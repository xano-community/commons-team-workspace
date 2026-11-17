// The files on a task, a doc or a deal. Anything out of this viewer's reach isn't here, and a file that's detached stays in Files.
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/kit";
import { useQueryClient } from "@tanstack/react-query";
import { tasksApi } from "@/lib/tasks/api";
import { useAttached } from "@/lib/files/client";
import type { Place } from "@/lib/files/model";
import { shellToast } from "@/lib/toast";
import { FileCard } from "./file-tile";
import { RecordUpload } from "./uploader";

export function Attachments({ record, className }: { record: Place; className?: string }) {
  const client = useQueryClient();
  const files = useAttached(record.type, record.id);
  if (files.error) return <LoadError title="The files on this didn't load" error={files.error} onRetry={() => void files.refetch()} />;
  if (!files.data) return <Skeleton className="h-8 w-40" />;
  const { items, can_add } = files.data;
  const detach = async (linkId: number, name: string) => {
    try {
      await tasksApi.removeLink(linkId);
      await Promise.all([client.invalidateQueries({ queryKey: ["file"] }), client.invalidateQueries({ queryKey: ["record_link"] })]);
      shellToast.show(`Took ${name} off this. It's still in Files.`);
    } catch (e) { shellToast.error(`Couldn't take that off. ${e instanceof Error ? e.message : "Try again."}`); }
  };
  if (!items.length && !can_add) return null;
  const list = (
    <>
      <h3 className="text-caption text-muted-foreground">Files{items.length > 0 && <span className="ml-1.5 tabular-nums">{items.length}</span>}</h3>
      {items.length > 0 && <ul data-testid="attached-files" className="grid gap-1 sm:grid-cols-[repeat(auto-fill,minmax(min(18rem,100%),1fr))]">{items.map((f) => <li key={f.id} className="min-w-0"><FileCard file={f} removeLabel={`Take ${f.name} off this`} onRemove={can_add ? () => void detach(f.link_id, f.name) : undefined} /></li>)}</ul>}
    </>
  );
  return (
    <section aria-label="Files" data-testid="attachments" className={className}>
      {can_add
        ? <RecordUpload place={record} className="flex flex-col gap-1.5">{({ button, rows }) => <>{list}{rows}{button}</>}</RecordUpload>
        : <div className="flex flex-col gap-1.5">{list}</div>}
    </section>
  );
}

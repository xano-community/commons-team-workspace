import { CircleCheck, FileText } from "lucide-react";
import type { RecordOption } from "@/components/workspace/composer";
import { crmApi } from "@/lib/crm/api";
import { CRM_ICONS } from "@/lib/crm/palette";
import { docsApi } from "@/lib/docs/api";
import { tasksApi } from "@/lib/tasks/api";

/** What a "#" finds besides channels, in any composer. */
export const taskRecordOptions = async (q: string): Promise<RecordOption[]> => {
  const [tasks, docs, customers] = await Promise.all([tasksApi.searchTasks(q), docsApi.search(q), crmApi.search(q)]);
  return [...tasks.map((t) => ({ type: "task", id: t.id, title: t.title, icon: CircleCheck })), ...docs.map((d) => ({ type: "doc", id: d.id, title: d.title, icon: FileText })), ...customers.map((h) => ({ type: h.type, id: h.id, title: h.title, icon: CRM_ICONS[h.type] }))];
};

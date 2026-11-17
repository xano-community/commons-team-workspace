import type { ReactNode } from "react";
import { RecordChip } from "@/components/workspace/link-chip";
import { parseBody } from "@/lib/chat/tokens";
import { cn } from "@/lib/utils";

/** A body as a reader sees it: `<@5>` as a name, `<#doc:12>` as a chip for this viewer, and links that open. An agent keeps its violet. */
export function BodyText({ body, me, nameOf, isAgent, after }: { body: string; me: number; nameOf: (id: number) => string; isAgent: (id: number) => boolean; after?: ReactNode }) {
  return (
    <p className="text-body text-pretty wrap-anywhere whitespace-pre-wrap">
      {parseBody(body).map((s, i) => {
        if (s.t === "text") return s.v;
        if (s.t === "link") return <a key={i} href={s.url} target="_blank" rel="noreferrer noopener" className="focus-ring rounded-sm underline underline-offset-2 hover:text-foreground">{s.url}</a>;
        if (s.t === "record") return <RecordChip key={i} type={s.type} id={s.id} />;
        return <span key={i} data-kit="mention" className={cn("rounded-sm px-0.5 font-medium", isAgent(s.id) ? "bg-agent-wash text-agent-text" : s.id === me ? "bg-selected" : "bg-muted")}>@{nameOf(s.id)}</span>;
      })}
      {after}
    </p>
  );
}

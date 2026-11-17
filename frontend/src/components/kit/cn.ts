// The project's `cn` (Vite and tsconfig alias the bare "cn" import here, so shadcn's primitives use it too).
// tailwind-merge's rules plus the kit's six type roles (kit.css): without them `text-body`, `text-caption`, …
// read as COLOURS, so `cn("text-body", "text-muted-foreground")` dropped the size and the text fell back to 16 px.
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const roles = { extend: { classGroups: { "font-size": [{ text: ["metric", "title", "heading", "body", "caption", "micro"] }] } } };

export const twMerge = extendTailwindMerge(roles);
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
export { clsx, type ClassValue };
export const twJoin = (...parts: (string | false | null | undefined | 0)[]) => parts.filter(Boolean).join(" ");

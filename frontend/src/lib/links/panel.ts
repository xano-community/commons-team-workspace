// What a record's Links panel lists. A record that shows its files in their own Files section doesn't list them again as links.
type View = { type: string };

/** The "Linked from" side, less the files already shown above it, and a count that matches what's left. */
export function shownBacklinks<V extends View>(backlinks: V[], total: number, filesShown: boolean): { views: V[]; total: number } {
  if (!filesShown) return { views: backlinks, total };
  const views = backlinks.filter((v) => v.type !== "file");
  return { views, total: Math.max(views.length, total - (backlinks.length - views.length)) };
}

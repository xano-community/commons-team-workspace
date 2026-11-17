// The query cache: in memory only, so no private row outlives the tab. Cached data shows at once and refreshes
// quietly behind it. The only things on disk are drafts and the outbox (store.ts).
import { QueryClient } from "@tanstack/react-query";

const status = (e: unknown) => (e as { status?: number } | null)?.status;

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        gcTime: 5 * 60_000,
        // A refusal won't change on a retry, and a 401 belongs to the sign-in dialog.
        retry: (count, error) => { const s = status(error); return !(s && s >= 400 && s < 500) && count < 2; },
      },
    },
  });
}

export const queryClient = createQueryClient();

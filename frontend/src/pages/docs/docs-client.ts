// The docs module's client, for this app: its token, the sign-in dialog on a 401, and a save that steps past an agent's edit.
import { createDocsClient } from "@xano-sdk/docs/react";
import { baseApi } from "@/base/api";
import { XANO_HOST, token } from "@/base/request";
import { docsApi } from "@/lib/docs/api";
import { yieldingSave } from "@/lib/docs/model";

const plain = createDocsClient({
  apiBaseUrl: `${XANO_HOST}/api:docs`,
  getToken: () => token.get(),
  fetch: async (...args) => {
    const answer = await fetch(...args);
    // Asking over the app's own request is what opens the sign-in dialog.
    if (answer.status === 401) baseApi.me().catch(() => {});
    return answer;
  },
});

/** The version this tab last saved, per doc, so its own frame doesn't read as someone else's change. */
export const savedHere = new Map<number, number>();

const saveWithYield = yieldingSave(plain.save, docsApi.yieldTo);
export const docsClient: typeof plain = {
  ...plain,
  save: async (id, body) => {
    const saved = await saveWithYield(id, body);
    if (!saved.conflict) savedHere.set(id, saved.doc.version);
    return saved;
  },
};

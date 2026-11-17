// The production entry: the same workspace as index.ts, with no seed rows at all (KTD9). Nothing of the demo company ships, no
// demo person exists, and with no settings row every demo door stays shut and first-admin setup is the only way in. Because the
// rows are emptied here, at build time, a `--seed` or a `--replace` deploy of this entry still lands an empty workspace.
// `npm run xano:deploy:production` deploys it. Deploy `index.ts` for the demo.
import app from "./index.js";

for (const table of app.tables()) Object.assign(table, { seed: [] });

export default app;

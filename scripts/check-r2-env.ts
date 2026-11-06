// Offline check of the upload settings: the four R2 settings and the Supabase secret key. It reads only the environment,
// makes NO network call and touches no object. It prints variable NAMES and a status (ok, missing, badFormat), never a
// value, an account id or an endpoint.
//
//   npm run r2:check          (loads .env.local, then .env.live if present)
//
// Exit code 0 only when everything is present and well formed and no NEXT_PUBLIC_ variable looks like it holds a secret.
// The Supabase secret key is judged by shape only: whether it belongs to the allowed project cannot be seen offline, so
// the app also refuses to build its Supabase clients for any project other than RIO_SUPABASE_ALLOWED_REF.
// A real connection test is a separate, approved step.

import { createR2Client, readR2Config, r2EnvReport } from "../lib/storage/object-store.ts";
import { secretKeyStatus } from "../lib/supabase/admin.ts";

const report = r2EnvReport();
for (const [name, status] of Object.entries(report.vars)) console.log(`${name.padEnd(22)} ${status}`);
const secret = secretKeyStatus();
console.log(`${"SUPABASE_SECRET_KEY".padEnd(22)} ${secret}`);
console.log(`public (browser-visible) names that look secret: ${report.publicLeaks.length === 0 ? "none" : report.publicLeaks.join(", ")}`);

const cfg = readR2Config();
if (cfg) {
  const client = createR2Client(cfg);
  console.log(`client: region ${await client.config.region()}, path-style ${client.config.forcePathStyle}, checksums ${await client.config.requestChecksumCalculation()}`);
}
// The master switch is reported but is not part of "ready": readiness is about configuration, the switch is a decision.
console.log(`${"RIO_UPLOADS_ENABLED".padEnd(22)} ${process.env.RIO_UPLOADS_ENABLED === "yes" ? "ON (exact value yes)" : "OFF"}`);
const ready = report.ok && secret === "ok";
console.log(ready ? "upload settings: ready for a connection test" : "upload settings: NOT ready");
process.exit(ready ? 0 : 1);

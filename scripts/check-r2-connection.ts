// ONE read-only connection check of the configured R2 bucket. It never uploads, downloads, copies or deletes anything, never
// changes bucket settings, and never retries. It prints fixed verdicts and counts only: no account id, endpoint, bucket name,
// credential, object key, signed URL or error message.
//
//   RIO_CONFIRM_R2_CHECK=yes npm run r2:connect
//
// Requests made (each at most once): ListObjectsV2 with MaxKeys=1, then read-only GetBucketCors and
// GetBucketLifecycleConfiguration for the configuration review. Without RIO_CONFIRM_R2_CHECK=yes nothing is sent.

import { createR2Client, readR2Config } from "../lib/storage/object-store.ts";
import { checkBucketConnection, readCorsReview, readLifecycleReview } from "../lib/storage/connectivity.ts";

if (process.env.RIO_CONFIRM_R2_CHECK !== "yes") {
  console.error("REFUSED: set RIO_CONFIRM_R2_CHECK=yes for this one command to send the read-only check.");
  process.exit(3);
}
const cfg = readR2Config();
if (!cfg) {
  console.error("REFUSED: the R2 settings are missing or malformed (run npm run r2:check).");
  process.exit(2);
}

const client = createR2Client(cfg, { maxAttempts: 1 }); // no automatic retries
const check = await checkBucketConnection(client, cfg.bucket);
console.log(`Connectivity:        ${check.connectivity}`);
console.log(`Authentication:      ${check.authentication}`);
console.log(`Bucket access:       ${check.bucketAccess}`);
console.log(`Objects returned:    ${check.objectCount ?? "n/a"} (MaxKeys=1)`);
console.log(`Error category:      ${check.category ?? "none"}`);

if (check.bucketAccess === "PASS") {
  const cors = await readCorsReview(client, cfg.bucket);
  const life = await readLifecycleReview(client, cfg.bucket);
  console.log(`CORS:                ${cors.status}`);
  console.log(`  origin http://localhost:3100: ${cors.originLocalhost3100} | no wildcard origin: ${cors.noWildcardOrigin} | method PUT: ${cors.methodPut} | header Content-Type: ${cors.headerContentType} | exposes ETag: ${cors.exposesEtag}`);
  console.log(`Lifecycle:           ${life.status}`);
  console.log(`  pending/ deleted after 1 day: ${life.pendingPrefixExpiresInOneDay}`);
}
process.exit(check.bucketAccess === "PASS" ? 0 : 1);

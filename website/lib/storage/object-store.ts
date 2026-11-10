import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// The private Cloudflare R2 bucket, through its S3-compatible API. Server-only: the access key never reaches the
// browser, and nothing here is imported by a client component (a test checks that). The bucket has no public domain;
// the only way a browser touches it is a presigned PUT URL that expires in minutes.
//
// Objects are named by random ids only. An upload lands under pending/<id>; once the server has verified it, it is
// copied to videos/<id>. The copy means the presigned URL (a temporary bearer credential that stays valid until it
// expires) can never overwrite a verified video: it only reaches pending/, which a lifecycle rule empties daily.

export type ObjectHead = { bytes: number; contentType: string | null; etag: string | null };

export type ObjectStore = {
  /** A URL the browser can PUT one object to, signed for this exact Content-Type. */
  presignPut(key: string, opts: { contentType: string; expiresInSeconds: number }): Promise<string>;
  /** Size, type and ETag of a stored object, or null if there is none. */
  head(key: string): Promise<ObjectHead | null>;
  /** Server-side copy that succeeds only if the source is still the object with this ETag. */
  copy(fromKey: string, toKey: string, ifMatchEtag: string): Promise<void>;
  remove(key: string): Promise<void>;
};

// Reading side (M4B media inspection, M5 judge playback). Kept apart from ObjectStore so the upload code and its fakes are unchanged.
export type ReadStore = {
  /** A short-lived URL a signed-in judge's browser can GET one object from. The caller has already checked the role. */
  presignGet(key: string, opts: { expiresInSeconds: number }): Promise<string>;
  /** Bytes start..endInclusive of an object (a ranged GET); never the whole file. */
  readRange(key: string, start: number, endInclusive: number): Promise<Uint8Array>;
};

export const pendingKey = (id: string) => `pending/${id}`;
export const videoKey = (id: string) => `videos/${id}`;

export type R2Config = { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string };
type Env = Record<string, string | undefined>;

// The four server-only settings. Names only ever appear in reports; values are never printed or returned.
export const R2_VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"] as const;
export type R2Var = (typeof R2_VARS)[number];
export type R2VarStatus = "ok" | "missing" | "badFormat";

// Shapes only: enough to catch a missing, truncated or mis-pasted value without assuming too much about Cloudflare's keys.
const SHAPES: Record<R2Var, RegExp> = {
  R2_ACCOUNT_ID: /^[0-9a-f]{32}$/i,
  R2_ACCESS_KEY_ID: /^\S{16,128}$/,
  R2_SECRET_ACCESS_KEY: /^\S{32,256}$/,
  R2_BUCKET_NAME: /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
};

export type R2EnvReport = {
  ok: boolean;
  vars: Record<R2Var, R2VarStatus>;
  /** Names (never values) of NEXT_PUBLIC_ variables that look like they hold an R2 or secret value. They would reach the browser. */
  publicLeaks: string[];
};

export function r2EnvReport(env: Env = process.env): R2EnvReport {
  const vars = {} as Record<R2Var, R2VarStatus>;
  for (const name of R2_VARS) {
    const value = env[name]?.trim() ?? "";
    vars[name] = value === "" ? "missing" : SHAPES[name].test(value) ? "ok" : "badFormat";
  }
  const publicLeaks = Object.keys(env).filter((k) => k.startsWith("NEXT_PUBLIC_") && /R2|SECRET|ACCESS_KEY|SERVICE_ROLE/i.test(k));
  return { ok: R2_VARS.every((n) => vars[n] === "ok") && publicLeaks.length === 0, vars, publicLeaks };
}

/** Null unless all four settings exist and look right (and no secret-looking NEXT_PUBLIC_ variable exists). */
export function readR2Config(env: Env = process.env): R2Config | null {
  if (!r2EnvReport(env).ok) return null;
  return {
    accountId: env.R2_ACCOUNT_ID!.trim(),
    bucket: env.R2_BUCKET_NAME!.trim(),
    accessKeyId: env.R2_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!.trim(),
  };
}

export const r2Endpoint = (accountId: string) => `https://${accountId}.r2.cloudflarestorage.com`;

/** `maxAttempts: 1` turns the SDK's automatic retries off (the connectivity check must never retry). */
export function createR2Client(cfg: R2Config, opts: { maxAttempts?: number } = {}): S3Client {
  return new S3Client({
    ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
    region: "auto",
    endpoint: r2Endpoint(cfg.accountId),
    forcePathStyle: true, // one host per account, so the browser's connect-src needs a single entry
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // R2 does not accept the SDK's default CRC32 checksum on a presigned PUT; compute checksums only when required
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

const isMissing = (e: unknown) => {
  const x = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return x?.name === "NotFound" || x?.name === "NoSuchKey" || x?.$metadata?.httpStatusCode === 404;
};

export function createR2Store(cfg: R2Config, client: S3Client = createR2Client(cfg)): ObjectStore & ReadStore {
  const Bucket = cfg.bucket;
  return {
    presignPut: (key, { contentType, expiresInSeconds }) =>
      getSignedUrl(client, new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }), {
        expiresIn: expiresInSeconds,
        signableHeaders: new Set(["content-type"]), // the PUT must carry exactly this Content-Type
      }),
    async head(key) {
      try {
        const r = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { bytes: r.ContentLength ?? 0, contentType: r.ContentType ?? null, etag: r.ETag ?? null };
      } catch (e) {
        if (isMissing(e)) return null;
        throw e;
      }
    },
    async copy(fromKey, toKey, ifMatchEtag) {
      await client.send(new CopyObjectCommand({ Bucket, Key: toKey, CopySource: `${Bucket}/${fromKey}`, CopySourceIfMatch: ifMatchEtag }));
    },
    presignGet: (key, { expiresInSeconds }) =>
      getSignedUrl(client, new GetObjectCommand({ Bucket, Key: key, ResponseContentDisposition: "inline" }), { expiresIn: expiresInSeconds }),
    async readRange(key, start, endInclusive) {
      const r = await client.send(new GetObjectCommand({ Bucket, Key: key, Range: `bytes=${start}-${endInclusive}` }));
      return (await r.Body?.transformToByteArray()) ?? new Uint8Array();
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key })); // deleting a missing key is not an error in S3
    },
  };
}

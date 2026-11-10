import type { LogLevel } from "./config.ts";

// One JSON object per line on stdout. Personal data and secrets must never reach a log, so every field passes through redact():
// by key name (secrets, credentials, contact details) and by value shape (URLs with a password, bearer tokens, JWTs).

export type Fields = Record<string, unknown>;
export type Logger = Record<LogLevel, (message: string, fields?: Fields) => void>;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /pass(word|wd)?|secret|token|authorization|cookie|credential|api[-_]?key|private|signature|session|otp|database_?url|(^|[-_])key($|[-_])|e-?mail|mobile|phone|child|parent/i;
const MAX_DEPTH = 6;
const MAX_STRING = 500;
export const REDACTED = "[redacted]";

function scrubString(value: string): string {
  return value
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, `$1${REDACTED}@`) // user:password@ inside a URL
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED) // JWT
    .replace(/\bsb_(secret|publishable)_[A-Za-z0-9_-]+/g, REDACTED)
    .slice(0, MAX_STRING);
}

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return typeof value === "function" || typeof value === "symbol" ? undefined : value;
  // An error carries free text (often user input), so only its type is kept.
  if (value instanceof Error) return { name: value.name, code: (value as { code?: unknown }).code };
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1)]),
  );
}

export function createLogger(options: { level: LogLevel; write?: (line: string) => void; now?: () => Date }): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const emit = (level: LogLevel) => (message: string, fields: Fields = {}) => {
    if (ORDER[level] < ORDER[options.level]) return;
    write(JSON.stringify({ time: now().toISOString(), level, message: scrubString(message), ...(redact(fields) as Fields) }));
  };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

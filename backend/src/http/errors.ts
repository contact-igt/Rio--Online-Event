import type { ErrorRequestHandler, RequestHandler } from "express";
import type { Logger } from "../logger.ts";
import { requestIdOf } from "./request-id.ts";

// The client only ever sees a fixed code and a fixed message plus the request id. The original error text is never sent and never logged
// (it can contain user input); the log keeps the error type and the request id so the event can still be traced.

export class AppError extends Error {
  override name = "AppError";
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MESSAGES: Record<string, string> = {
  not_found: "Not found.",
  bad_request: "The request could not be understood.",
  payload_too_large: "The request body is too large.",
  unsupported_media_type: "Unsupported content type.",
  internal: "Something went wrong.",
};

/** Errors raised by the JSON body parser (malformed JSON, body over the limit, unsupported encoding). */
function fromBodyParser(err: unknown): AppError | null {
  if (typeof err !== "object" || err === null) return null;
  const { type, status } = err as { type?: unknown; status?: unknown };
  if (typeof type !== "string" || typeof status !== "number" || status < 400 || status > 499) return null;
  if (type === "entity.too.large") return new AppError(413, "payload_too_large", MESSAGES.payload_too_large!);
  if (type.startsWith("encoding.") || type.startsWith("charset.")) return new AppError(415, "unsupported_media_type", MESSAGES.unsupported_media_type!);
  return new AppError(400, "bad_request", MESSAGES.bad_request!);
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, "not_found", MESSAGES.not_found!));
};

export function errorHandler(logger: Logger): ErrorRequestHandler {
  // Express identifies an error handler by its four parameters, so `_next` must stay.
  return (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const known = err instanceof AppError ? err : fromBodyParser(err);
    const requestId = requestIdOf(res);
    if (known) {
      logger.warn("request_rejected", { requestId, code: known.code, status: known.status });
      res.status(known.status).json({ error: { code: known.code, message: known.message, requestId } });
      return;
    }
    logger.error("request_failed", { requestId, error: err });
    res.status(500).json({ error: { code: "internal", message: MESSAGES.internal!, requestId } });
  };
}

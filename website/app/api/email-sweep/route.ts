import { timingSafeEqual } from "node:crypto";
import { emailAvailable } from "@/lib/email/config";
import { sweepOutbox } from "@/lib/email/outbox";
import { createEmailDeps } from "@/lib/email/server";

// The retry worker for confirmation e-mails that could not be sent the first time. Meant to be called on a schedule (Vercel Cron sends
// `Authorization: Bearer <CRON_SECRET>`). It answers a plain 404 to everyone else, whatever the reason (switched off, not configured, wrong or
// missing secret), so it reveals nothing; with the right secret it sends what is due (at most 20 per call) and returns only counts.
export const dynamic = "force-dynamic";

const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET ?? "";
  if (!emailAvailable() || secret.length < 32 || !sameSecret(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) return notFound();
  try {
    const { db, provider } = createEmailDeps();
    if (!provider) return notFound();
    return Response.json(await sweepOutbox({ db, provider }, 20), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

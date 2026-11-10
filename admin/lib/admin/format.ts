// Date and time for the administrator screens, always in Indian Standard Time so a timestamp means the same thing to everyone.

export const TIME_ZONE = "Asia/Kolkata";

const stamp = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: TIME_ZONE });

/** "7 Nov 2026, 3:30 pm" in IST, or an en dash for a missing or invalid value. */
export function formatIst(iso: string | null | undefined): string {
  if (!iso) return "–";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "–" : stamp.format(new Date(t));
}

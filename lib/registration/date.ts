// Dates are shown in both languages, Tamil first: "5 நவம்பர் 2026 / 5 Nov 2026", in Indian time.
// Built from parts because the Tamil locale puts a comma after the month, which the project's date format does not have.
export function formatDateBilingual(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const show = (locale: string, month: "long" | "short") => {
    const p = new Intl.DateTimeFormat(locale, { day: "numeric", month, year: "numeric", timeZone: "Asia/Kolkata" }).formatToParts(d);
    const get = (type: string) => p.find((x) => x.type === type)?.value ?? "";
    return `${get("day")} ${get("month")} ${get("year")}`;
  };
  return `${show("ta-IN", "long")} / ${show("en-GB", "short")}`;
}

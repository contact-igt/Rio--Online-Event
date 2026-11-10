/** A timestamp read from either dialect: a Date from MySQL, ISO-8601 UTC text from SQLite. Anything else is a bug and throws. */
export function asDate(value: unknown): Date {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new TypeError("Not a timestamp.");
  return date;
}

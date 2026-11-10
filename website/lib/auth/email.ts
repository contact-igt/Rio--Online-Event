/** "jane.doe@example.com" -> "j•••@example.com": enough for a parent to recognise it, not enough to read aloud. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}

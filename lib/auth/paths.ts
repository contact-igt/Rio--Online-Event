// Every redirect in the auth flow is built here from a validated event slug, never from request input,
// so there is no open redirect. A slug is only [a-z0-9-], so it is safe inside a path or query string.

export function signInPath(event: string | null, expired = false): string {
  const query = [event ? `event=${event}` : "", expired ? "expired=1" : ""].filter(Boolean).join("&");
  return query ? `/signin?${query}` : "/signin";
}

export function verifyPath(event: string | null, resent = false): string {
  const query = [event ? `event=${event}` : "", resent ? "resent=1" : ""].filter(Boolean).join("&");
  return query ? `/signin/verify?${query}` : "/signin/verify";
}

export const registerPath = (event: string) => `/events/${event}/register`;
export const afterSignInPath = (event: string | null) => (event ? registerPath(event) : "/account");

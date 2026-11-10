import type { AuthConfig } from "../config.ts";

// The registration cookie holds the recovery code. It is separate from the staff cookie (another name, another table), so a staff session
// opens no registration and a recovery code opens no staff route. `__Host-` forces Secure, Path=/ and no Domain wherever Secure is used.
export const codeCookieName = (auth: AuthConfig): string => (auth.cookieSecure ? "__Host-rio_reg" : "rio_reg");

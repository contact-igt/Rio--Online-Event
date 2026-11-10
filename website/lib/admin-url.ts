// The admin panel is a separate site. NEXT_PUBLIC_ADMIN_URL is its public address (for example https://admin.example.org, no trailing slash);
// left unset, links stay on this origin, which is how both apps behave behind one host in local development. It is a public address, not a secret.
export const adminUrl = (path: string) => `${process.env.NEXT_PUBLIC_ADMIN_URL ?? ""}${path}`;

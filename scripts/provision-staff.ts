// DEVELOPMENT-ONLY provisioning of a staff account (administrator or judge) through Supabase Auth. There is no public staff
// registration; this is how the first accounts are created on the DEV project.
//
//   RIO_LIVE_CONFIRM=<dev ref> RIO_CONFIRM_PROVISION=<dev ref> npm run staff:provision -- --role admin --email name@example.org
//   RIO_LIVE_CONFIRM=<dev ref> RIO_CONFIRM_PROVISION=<dev ref> npm run staff:provision -- --role judge --email name@example.org --name "Judge One"
//   ... add --reset-password to set a new password for an account that already exists
//
// The password is NEVER on the command line, in a file, in SQL or in source: it is typed at a hidden prompt (twice), or, for a
// non-interactive run, taken from RIO_STAFF_PASSWORD set for that one command. It is passed only to Supabase Auth and is never
// printed or logged. The script refuses the production project (the project in .env) and any target that does not match the typed
// confirmation. It uses the service key from .env.live, which the app itself never reads for this purpose.
// For production the same steps are done by hand in the Supabase dashboard (Authentication > Users > Add user, with the password typed
// there) followed by the SQL in DEPLOYMENT.md, which contains no password.

import { createClient } from "@supabase/supabase-js";
import { assertSafeLiveTarget, GuardError, readProductionPublishableKey, readProductionRef, type Env } from "./live-target.ts";

export type Role = "admin" | "judge";
export type Args = { role: Role; email: string; name: string | null; resetPassword: boolean };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const WEAK = new Set(["password", "password1", "password123", "123456789012", "qwertyuiop12", "administrator", "letmein12345", "welcome12345"]);

export function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? "") : null;
  };
  const role = get("--role");
  if (role !== "admin" && role !== "judge") throw new GuardError("--role must be admin or judge.");
  const email = (get("--email") ?? "").trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) throw new GuardError("--email must be a valid email address.");
  const name = get("--name")?.trim() || null;
  if (role === "judge" && (!name || name.length > 80)) throw new GuardError("A judge needs --name \"Display name\" (1 to 80 characters).");
  if (role === "admin" && name) throw new GuardError("--name is only for judges.");
  if (argv.some((a) => /^--(password|pass|pw)\b/i.test(a))) throw new GuardError("The password is never given on the command line.");
  return { role, email, name, resetPassword: argv.includes("--reset-password") };
}

/** Why a password is refused (fixed labels; the password itself is never returned). */
export function passwordProblems(password: string, email: string): string[] {
  const out: string[] = [];
  if (password.length < 12) out.push("shorter than 12 characters");
  if (password.length > 128) out.push("longer than 128 characters");
  if (new Set(password).size < 5) out.push("too few different characters");
  const local = email.split("@")[0] ?? "";
  if (local.length >= 4 && password.toLowerCase().includes(local)) out.push("contains the email name");
  if (WEAK.has(password.toLowerCase())) out.push("a commonly used password");
  if (/^\s|\s$/.test(password)) out.push("starts or ends with a space");
  return out;
}

/** The typed confirmation, and the same dev-only checks every hosted test uses. Messages are fixed strings. */
export function assertProvisionTarget(env: Env, prodRef: string | null, prodPublishableKey: string | null): { ref: string } {
  const target = assertSafeLiveTarget(env, prodRef, prodPublishableKey);
  if (target.ref === "local") throw new GuardError("Use a hosted DEV project (a local stack is not a provisioning target here).");
  if (env.RIO_CONFIRM_PROVISION !== target.ref) throw new GuardError("Set RIO_CONFIRM_PROVISION to the dev project ref to allow creating a staff account.");
  return { ref: target.ref };
}

/** Refuses a weak password and says WHICH rules failed (fixed labels; never the password or any part of it). */
function requireStrong(password: string, email: string): void {
  const problems = passwordProblems(password, email);
  if (problems.length) throw new GuardError(`The password does not meet the rules: ${problems.join("; ")}.`);
}

export type ProvisionDeps = {
  findUser(email: string): Promise<{ id: string } | null>;
  createUser(email: string, password: string): Promise<{ id: string }>;
  setPassword(id: string, password: string): Promise<void>;
  roleOf(id: string): Promise<Role | null>;
  addRole(id: string, role: Role): Promise<void>;
  hasProfile(id: string): Promise<boolean>;
  addProfile(id: string, name: string): Promise<void>;
};
export type Summary = { createdAccount: boolean; passwordSet: boolean; roleAdded: boolean; profileAdded: boolean };

export async function provision(deps: ProvisionDeps, args: Args, password: string | null): Promise<Summary> {
  const existing = await deps.findUser(args.email);
  const summary: Summary = { createdAccount: false, passwordSet: false, roleAdded: false, profileAdded: false };
  let id: string;
  if (!existing) {
    if (password === null) throw new GuardError("A new account needs a password.");
    requireStrong(password, args.email);
    id = (await deps.createUser(args.email, password)).id;
    summary.createdAccount = true;
    summary.passwordSet = true;
  } else {
    id = existing.id;
    const current = await deps.roleOf(id);
    if (current && current !== args.role) throw new GuardError("This account already holds a different staff role; refusing to change it.");
    if (args.resetPassword) {
      if (password === null) throw new GuardError("--reset-password needs a password.");
      requireStrong(password, args.email);
      await deps.setPassword(id, password);
      summary.passwordSet = true;
    }
  }
  if (!(await deps.roleOf(id))) {
    await deps.addRole(id, args.role);
    summary.roleAdded = true;
  }
  if (args.role === "judge" && args.name && !(await deps.hasProfile(id))) {
    await deps.addProfile(id, args.name);
    summary.profileAdded = true;
  }
  return summary;
}

const mask = (email: string) => `${email.slice(0, 1)}***@${email.split("@")[1] ?? ""}`;

async function promptHidden(label: string): Promise<string> {
  if (!process.stdin.isTTY) throw new GuardError("There is no terminal for a hidden prompt; set RIO_STAFF_PASSWORD for this one command instead.");
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") {
          process.stdin.setRawMode(false);
          process.stdout.write("\n");
          return reject(new GuardError("Cancelled."));
        }
        value = ch === "\u007f" || ch === "\b" ? value.slice(0, -1) : value + ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main(argv: string[]): Promise<number> {
  try {
    const args = parseArgs(argv);
    const target = assertProvisionTarget(process.env, readProductionRef(), readProductionPublishableKey());
    let password: string | null = process.env.RIO_STAFF_PASSWORD ?? null;
    const svc = createClient(process.env.RIO_LIVE_URL!, process.env.RIO_LIVE_SECRET_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

    const lookup = async (email: string) => {
      for (let page = 1; page <= 10; page++) {
        const res = await svc.auth.admin.listUsers({ page, perPage: 200 });
        if (res.error) throw new Error("could not list accounts");
        const hit = res.data.users.find((u) => (u.email ?? "").toLowerCase() === email);
        if (hit) return { id: hit.id };
        if (res.data.users.length < 200) break;
      }
      return null;
    };
    const existing = await lookup(args.email);
    if ((!existing || args.resetPassword) && password === null) {
      password = await promptHidden("New password (hidden): ");
      if (password !== (await promptHidden("Repeat the password (hidden): "))) throw new GuardError("The two passwords differ.");
    }
    const summary = await provision(
      {
        findUser: async () => existing,
        async createUser(email, pw) {
          const { data, error } = await svc.auth.admin.createUser({ email, password: pw, email_confirm: true });
          if (error || !data.user) throw new Error("could not create the account");
          return { id: data.user.id };
        },
        async setPassword(id, pw) {
          const { error } = await svc.auth.admin.updateUserById(id, { password: pw });
          if (error) throw new Error("could not set the password");
        },
        async roleOf(id) {
          const { data } = await svc.from("user_roles").select("role").eq("user_id", id).maybeSingle();
          return data?.role === "admin" || data?.role === "judge" ? data.role : null;
        },
        async addRole(id, role) {
          const { error } = await svc.from("user_roles").insert({ user_id: id, role });
          if (error) throw new Error("could not add the role");
        },
        async hasProfile(id) {
          return (await svc.from("judge_profiles").select("user_id").eq("user_id", id).maybeSingle()).data !== null;
        },
        async addProfile(id, name) {
          const { error } = await svc.from("judge_profiles").insert({ user_id: id, display_name: name });
          if (error) throw new Error("could not add the judge profile");
        },
      },
      args,
      password,
    );
    console.log(`target: dev project ${target.ref.slice(0, 4)}…${target.ref.slice(-2)} | ${args.role} ${mask(args.email)}`);
    console.log(`account created: ${summary.createdAccount} | password set: ${summary.passwordSet} | role added: ${summary.roleAdded} | judge profile added: ${summary.profileAdded}`);
    return 0;
  } catch (e) {
    console.error(e instanceof GuardError ? `REFUSED: ${e.message}` : "FAILED: the account could not be provisioned (no details are printed).");
    return e instanceof GuardError ? 3 : 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

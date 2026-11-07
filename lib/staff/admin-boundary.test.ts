import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Static guards for administrator management (judges, registrations, sidebar, staff access, password setup, development preview). They fail
// if a later change moves the secret key into a page or component, drops the role check, adds a route that leaks personal data, or makes the
// development preview reachable in production.

const ROOT = process.cwd();
const SKIP = new Set(["node_modules", ".next", ".git", "test-results", "graphify-out", "screenshots", "design-references"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
}
const files = walk(ROOT).map((p) => ({ path: relative(ROOT, p).replaceAll("\\", "/"), text: readFileSync(p, "utf8") }));
const isTest = (p: string) => /\.test\.|\.spec\.|^e2e/.test(p);
const get = (p: string) => files.find((f) => f.path === p)!.text;
const code = (p: string) => get(p).replace(/\/\/.*$/gm, "");
const adminFiles = files.filter((f) => !isTest(f.path) && /^(app\/admin|components\/admin|lib\/admin)\//.test(f.path));
const SECRET = /createAdminClient|supabase\/admin|SUPABASE_SECRET_KEY/;

describe("the secret key", () => {
  it("only lib/staff/invites.ts builds the secret-key client for staff management; admin pages, actions and components never touch it", () => {
    const staffUsers = files.filter((f) => !isTest(f.path) && /^lib\/staff\//.test(f.path) && SECRET.test(f.text));
    expect(staffUsers.map((f) => f.path)).toEqual(["lib/staff/invites.ts"]);
    for (const f of adminFiles) expect(f.text, f.path).not.toMatch(SECRET);
  });

  it("no client component imports the invitation, judge-list or admin-loader modules", () => {
    for (const f of files.filter((x) => !isTest(x.path) && /^\s*["']use client["']/.test(x.text))) {
      expect(f.text, f.path).not.toMatch(/lib\/staff\/invites|lib\/staff\/judges|lib\/admin\//);
    }
  });
});

describe("judge actions", () => {
  const actions = code("app/admin/judges/actions.ts");

  it("exports exactly the two actions, as server actions that never log", () => {
    expect(actions).toMatch(/^"use server";/);
    expect([...actions.matchAll(/^export async function (\w+)/gm)].map((m) => m[1])).toEqual(["inviteJudge", "setJudgeActive"]);
    expect(actions).not.toMatch(/console\./);
  });

  it("each verifies the administrator session FIRST, before reading a setting, building a dependency or parsing the input", () => {
    for (const fn of ["inviteJudge", "setJudgeActive"]) {
      const body = actions.slice(actions.indexOf(`export async function ${fn}`));
      const firstAwait = body.indexOf("await ");
      expect(body.slice(firstAwait, firstAwait + 40), fn).toContain('staffSession("admin")');
    }
    expect(actions.indexOf("inviteReadiness()")).toBeLessThan(actions.indexOf("createInviteDeps("));
  });

  it("deactivation requires an explicit confirmation on the server", () => {
    expect(actions).toMatch(/!parsed\.data\.active && parsed\.data\.confirmed !== true/);
  });
});

describe("admin pages and routes", () => {
  it("every admin page checks the role before it loads anything", () => {
    for (const p of ["app/admin/page.tsx", "app/admin/registrations/page.tsx", "app/admin/registrations/[id]/page.tsx", "app/admin/judges/page.tsx", "app/admin/events/[slug]/page.tsx"]) {
      const text = code(p);
      expect(text, p).toContain('requireStaff("admin")');
      const guard = text.indexOf('requireStaff("admin")');
      for (const loader of ["loadRegistrations(", "loadRegistration(", "loadJudges(", "createAuthLookup(", "supabase.from("]) {
        const at = text.indexOf(loader);
        if (at !== -1) expect(guard, `${p} ${loader}`).toBeLessThan(at);
      }
    }
  });

  it("no route handler exposes registrations or personal fields", () => {
    for (const f of files.filter((x) => !isTest(x.path) && /^app\/.*route\.ts$/.test(x.path))) {
      expect(f.text, f.path).not.toMatch(/child_name|parent_email|parent_mobile|loadRegistration|from\("submissions"\)/);
    }
  });

  it("the loaders only read, never log, and reduce the private video reference to a yes/no", () => {
    for (const p of ["lib/admin/registrations.ts", "lib/staff/judges.ts"]) expect(code(p), p).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(|createAdminClient|SUPABASE_SECRET_KEY|console\./);
    const loader = code("lib/admin/registrations.ts");
    expect([...loader.matchAll(/video_key/g)].length).toBe(3); // the column list, the row type and the yes/no
    expect(loader).toContain("hasVideo: r.video_key !== null");
  });

  it("the sidebar and layout show for a verified administrator only, and the sidebar never links outside the admin area", () => {
    const layout = code("app/admin/layout.tsx");
    expect(layout).toContain('staffSession("admin")');
    expect(layout).toMatch(/verified && <AdminNav/);
    for (const href of [...code("components/admin/admin-nav.tsx").matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]!)) expect(href).toMatch(/^\/admin/);
  });
});

describe("staff access and password setup", () => {
  it("the public Staff Access links reuse /staff/login; the role in the address only changes the heading", () => {
    expect(code("components/nav-links.ts")).toContain("/staff/login?role=admin");
    expect(code("components/nav-links.ts")).toContain("/staff/login?role=judge");
    const page = code("app/staff/login/page.tsx");
    expect([...page.matchAll(/\bwanted\b/g)].length).toBe(3); // destructured, and the two tests choosing the heading: never a redirect or a role check
    expect(page).not.toMatch(/redirect\([^)]*wanted/);
    const signIns = files.filter((f) => !isTest(f.path) && /\.signInWithPassword\(/.test(f.text)).map((f) => f.path);
    expect(signIns).toEqual(["app/staff/login/actions.ts"]); // no second authentication system
  });

  it("the password setup never logs, returns or stores a password and never creates an account or grants a role", () => {
    for (const p of ["app/staff/set-password/actions.ts", "lib/staff/password-setup.ts", "components/staff/set-password-form.tsx"]) {
      expect(code(p), p).not.toMatch(/console\.|localStorage|sessionStorage|createAdminClient|admin\.auth|\.insert\(|user_roles/);
    }
    expect(code("app/staff/set-password/page.tsx")).not.toContain("verifyOtp"); // opening the link must not use up the token
  });
});

describe("the development preview", () => {
  it("exists only behind a production check, never talks to Supabase or storage, and nothing outside it imports it", () => {
    expect(code("app/dev/layout.tsx")).toMatch(/NODE_ENV === "production"\) notFound\(\)/);
    expect(code("app/dev/registration-preview/page.tsx")).toMatch(/export default function \w+\(\) \{\s*if \(process\.env\.NODE_ENV === "production"\) notFound\(\);/);
    expect(code("components/dev/registration-preview.tsx")).not.toMatch(/supabase|createClient|lib\/upload|lib\/storage|fetch\(|"use server"/);
    for (const f of files.filter((x) => !isTest(x.path) && !/^(app\/dev|components\/dev)\//.test(x.path))) expect(f.text, f.path).not.toMatch(/components\/dev\//);
  });
});

describe("environment", () => {
  it(".env.example documents the invitation switch as off, with only the exact value yes explained", () => {
    const env = readFileSync(join(ROOT, ".env.example"), "utf8");
    expect(env).toContain("# RIO_STAFF_INVITES_ENABLED=no");
    expect(env).toMatch(/OFF unless the value is exactly "yes"/);
    expect(env).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(SECRET|INVITE)/);
  });
});

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Static guards for the upload design: secrets stay on the server, nothing logs, and nothing public exists.

const ROOT = process.cwd();
const SKIP = new Set(["node_modules", ".next", ".git", "test-results", "graphify-out"]);

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
const SERVER_ONLY = ["lib/storage/object-store", "lib/supabase/admin", "lib/upload/server", "lib/upload/service", "lib/upload/cleanup", "@aws-sdk"];

describe("server-only modules never reach the browser", () => {
  const clientFiles = files.filter((f) => !isTest(f.path) && /^\s*["']use client["']/.test(f.text));

  it("finds the client components it is meant to check", () => {
    expect(clientFiles.map((f) => f.path)).toContain("components/registration/upload-panel.tsx");
  });

  it("no client component imports the bucket client, the secret-key client, the service or the AWS SDK as a value", () => {
    for (const f of clientFiles) {
      const imports = [...f.text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)].filter((m) => !m[1]).map((m) => m[2]!);
      for (const target of imports) for (const bad of SERVER_ONLY) expect(target.includes(bad), `${f.path} imports ${target}`).toBe(false);
      expect(f.text, f.path).not.toMatch(/SUPABASE_SECRET_KEY|R2_SECRET_ACCESS_KEY|R2_ACCESS_KEY_ID|R2_ACCOUNT_ID/);
    }
  });

  it("the only way the upload panel reaches the server is through the two server actions", () => {
    const panel = files.find((f) => f.path === "components/registration/upload-panel.tsx")!;
    const targets = [...panel.text.matchAll(/^import\s+[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
    expect(targets.filter((t) => /actions|server/.test(t))).toEqual(["@/app/events/[slug]/register/video-actions"]);
    const actions = files.find((f) => f.path === "app/events/[slug]/register/video-actions.ts")!;
    expect(actions.text).toMatch(/^"use server";/);
    expect([...actions.text.matchAll(/^export (async )?function (\w+)/gm)].map((m) => m[2])).toEqual(["requestVideoUpload", "confirmVideoUpload"]);
  });

  it("the secret-key client and the bucket client are imported only by server code", () => {
    for (const f of files.filter((x) => !isTest(x.path))) {
      const imports = /from\s+["'](@\/lib\/supabase\/admin|@\/lib\/storage\/object-store|\.\.?\/(admin|object-store)(\.ts)?)["']/.test(f.text);
      if (imports) expect(f.path, "unexpected importer").toMatch(/^(lib\/(upload|submit|judging|email|storage|supabase)\/|app\/events\/\[slug\]\/register\/|scripts\/)/);
    }
  });
});

describe("the upload master switch (RIO_UPLOADS_ENABLED) is enforced on the server, not just in the UI", () => {
  const get = (p: string) => files.find((f) => f.path === p)!.text;

  it("both server actions check the switch FIRST, before they even look up the session", () => {
    const actions = get("app/events/[slug]/register/video-actions.ts");
    for (const fn of ["requestVideoUpload", "confirmVideoUpload"]) {
      const body = actions.slice(actions.indexOf(`export async function ${fn}`));
      const end = body.indexOf("\n}\n");
      const text = body.slice(0, end);
      expect(text.indexOf("uploadsAvailable()"), fn).toBeGreaterThan(-1);
      expect(text.indexOf("uploadsAvailable()"), fn).toBeLessThan(text.indexOf("await parent()"));
    }
  });

  it("the dependency builder refuses to build while the switch is off", () => {
    const server = get("lib/upload/server.ts");
    expect(server).toContain(`env.RIO_UPLOADS_ENABLED === "yes"`);
    expect(server.slice(server.indexOf("export function createUploadDeps"))).toMatch(/if \(!uploadsEnabled\(\)\) throw/);
  });

  it("only the server actions and the cleanup/check scripts ever build upload dependencies", () => {
    for (const f of files.filter((x) => !isTest(x.path))) {
      if (/createUploadDeps\(/.test(f.text) && f.path !== "lib/upload/server.ts") expect(f.path).toBe("app/events/[slug]/register/video-actions.ts");
    }
  });

  it("the page decides the upload step through uploadStep (which needs the switch) and never from the raw configuration", () => {
    const page = get("app/events/[slug]/register/page.tsx");
    expect(page).toContain("uploadStep(");
    expect(page).not.toMatch(/uploadsConfigured|uploadsAvailable|R2_/);
  });

  it("the content security policy only names the bucket host when the switch is on", () => {
    expect(get("next.config.ts")).toContain(`process.env.RIO_UPLOADS_ENABLED === "yes" &&`);
  });

  it(".env.example documents the switch as off, with only the exact value yes explained", () => {
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    expect(example).toMatch(/^# RIO_UPLOADS_ENABLED=no$/m);
    expect(example).toMatch(/exact value "yes"/);
    expect(example).not.toMatch(/NEXT_PUBLIC_[A-Z_]*UPLOAD/);
  });
});

describe("secrets and exposure", () => {
  it("no secret is ever given a NEXT_PUBLIC_ name", () => {
    for (const f of files.filter((x) => !isTest(x.path))) {
      expect(f.text, f.path).not.toMatch(/NEXT_PUBLIC_[A-Z0-9_]*(SECRET|R2_|SERVICE_ROLE|ACCESS_KEY)/);
    }
  });

  it("the upload code, the actions and the panel never log", () => {
    const watched = files.filter((f) => !isTest(f.path) && /^(lib\/(upload|storage)\/|app\/events\/\[slug\]\/register\/video-actions|components\/registration\/upload-panel)/.test(f.path));
    expect(watched.length).toBeGreaterThanOrEqual(7);
    for (const f of watched) expect(f.text, f.path).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });

  it("no public bucket address, public R2 domain or permanent video URL exists in the app", () => {
    for (const f of files.filter((x) => !isTest(x.path))) {
      expect(f.text, f.path).not.toMatch(/r2\.dev|pub-[0-9a-f]{32}|getPublicUrl|public-read|\bacl\s*:\s*["']public/i);
    }
  });

  it("object names are built from an id only", () => {
    const store = files.find((f) => f.path === "lib/storage/object-store.ts")!.text;
    expect(store).toContain("pendingKey = (id: string) => `pending/${id}`");
    expect(store).toContain("videoKey = (id: string) => `videos/${id}`");
  });

  it("the content security policy lets the browser reach only the one validated R2 host", () => {
    const cfg = files.find((f) => f.path === "next.config.ts")!.text;
    expect(cfg).toContain("connect-src 'self'${r2Origin}");
    expect(cfg).toContain("[0-9a-f]{32}"); // the account id is validated before it is put in the header
    expect(cfg).not.toMatch(/connect-src[^`]*\*/);
  });

  it("the upload code never finalizes: only the final-submission path may set the finalized status", () => {
    for (const f of files.filter((x) => !isTest(x.path) && /^(lib\/upload|lib\/storage|components\/registration\/upload-panel|app\/events\/\[slug\]\/register\/video-actions)/.test(x.path))) {
      expect(f.text, f.path).not.toMatch(/finalize_submission|finalize_verified_submission|check_finalize|status:\s*["']finalized["']|set status = 'finalized'/);
    }
  });
});

describe("final submission (RIO_FINALIZE_ENABLED) is enforced on the server and has exactly one path", () => {
  const get = (p: string) => files.find((f) => f.path === p)!.text;

  it("the old parent-callable finalizer is gone everywhere in the app", () => {
    // the application (the guarded read-only inspection in scripts/ names the function on purpose, to confirm it stays absent in DEV)
    for (const f of files.filter((x) => !isTest(x.path) && /^(app|components|lib)\//.test(x.path))) expect(f.text, f.path).not.toMatch(/\bfinalize_submission\b/);
  });

  it("only lib/submit builds the database calls that finalize, and only the one server action uses it", () => {
    const users = files.filter((f) => !isTest(f.path) && /^(app|components|lib)\//.test(f.path) && /finalize_verified_submission|check_finalize|createFinalizeDeps|finalizeEntry/.test(f.text));
    expect(users.map((f) => f.path).sort()).toEqual(["app/events/[slug]/register/submit-actions.ts", "lib/submit/server.ts", "lib/submit/service.ts"]);
    for (const f of files.filter((x) => !isTest(x.path) && /^(app|components)\//.test(x.path) && x.path !== "app/events/[slug]/register/submit-actions.ts")) {
      expect(f.text, f.path).not.toMatch(/createFinalizeDeps|finalizeEntry|finalize_verified_submission/);
    }
  });

  it("the server action checks the switch FIRST, before it looks up the session", () => {
    const actions = get("app/events/[slug]/register/submit-actions.ts");
    expect(actions.startsWith('"use server"')).toBe(true);
    const body = actions.slice(actions.indexOf("export async function submitEntry"));
    expect(body.indexOf("finalizeAvailable()")).toBeGreaterThan(-1);
    expect(body.indexOf("finalizeAvailable()")).toBeLessThan(body.indexOf("await parent()"));
    expect(body.indexOf("await parent()")).toBeLessThan(body.indexOf("createFinalizeDeps()"));
    expect(actions).toContain("auth.getUser()"); // the parent is verified with Supabase, never read from the request
  });

  it("the dependency builder refuses to build while the switch is off", () => {
    const server = get("lib/submit/server.ts");
    expect(server).toMatch(/export function createFinalizeDeps[\s\S]*?finalizeEnabled\(/);
    expect(server).toContain('=== "yes"');
  });

  it("the page decides the submit step through submitStep (which needs the switch), not from raw configuration", () => {
    const page = get("app/events/[slug]/register/page.tsx");
    expect(page).toContain("submitStep(");
    expect(page).not.toMatch(/process\.env\.RIO_FINALIZE_ENABLED/);
  });

  it("client components import only types from the final-submission service, and never the bucket or database clients", () => {
    for (const f of files.filter((x) => !isTest(x.path) && /^components\/registration\//.test(x.path) && /"use client"/.test(x.text))) {
      expect(f.text, f.path).not.toMatch(/import\s+(?!type\b)[^;]*from\s+["']@\/lib\/submit\//);
      expect(f.text, f.path).not.toMatch(/lib\/storage\/object-store|lib\/supabase\/admin|@aws-sdk/);
    }
  });

  it("final-submission code, its action and its screens never log", () => {
    const watched = files.filter((f) => !isTest(f.path) && /^(lib\/submit\/|app\/events\/\[slug\]\/register\/submit-actions|components\/registration\/(submit-entry|submitted-panel))/.test(f.path));
    expect(watched.length).toBeGreaterThanOrEqual(5);
    for (const f of watched) expect(f.text, f.path).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });

  it("the finalized status is set nowhere in the app: only the database function does it", () => {
    for (const f of files.filter((x) => !isTest(x.path) && /^(app|components|lib)\//.test(x.path))) {
      expect(f.text, f.path).not.toMatch(/status:\s*["']finalized["']|set status = 'finalized'|\.update\(\s*\{\s*status/);
    }
  });

  it(".env.example documents the switch as off, with only the exact value yes explained and the media-inspection blocker named", () => {
    const env = readFileSync(join(ROOT, ".env.example"), "utf8");
    expect(env).toContain("# RIO_FINALIZE_ENABLED=no");
    expect(env).toMatch(/exact value "yes"/);
    expect(env).toMatch(/media inspection/);
  });
});

describe("judge and administrator areas (M5/M6)", () => {
  const get = (p: string) => files.find((f) => f.path === p)!.text;
  const app = files.filter((f) => !isTest(f.path) && /^(app|components)\//.test(f.path));

  it("only lib/judging/server.ts builds the service-role client for judging; pages, actions and components never do", () => {
    const users = files.filter((f) => !isTest(f.path) && /^(app\/(admin|judge)|components\/(admin|judge)|lib\/judging)\//.test(f.path) && /createAdminClient|supabase\/admin|SUPABASE_SECRET_KEY/.test(f.text));
    expect(users.map((f) => f.path)).toEqual(["lib/judging/server.ts"]);
  });

  it("signed playback links are minted in exactly one place, and never imported by a page or component", () => {
    const minting = files.filter((f) => !isTest(f.path) && /presignGet/.test(f.text)).map((f) => f.path).sort();
    expect(minting).toEqual(["lib/judging/playback.ts", "lib/storage/object-store.ts"]);
    for (const f of app) expect(f.text, f.path).not.toMatch(/presignGet|object-store|authorize_playback/);
  });

  it("the playback action checks its switch FIRST, then the session, before any dependency is built", () => {
    const actions = get("app/judge/actions.ts");
    const body = actions.slice(actions.indexOf("export async function getPlaybackUrl"));
    expect(body.indexOf("playbackAvailable()")).toBeGreaterThan(-1);
    expect(body.indexOf("playbackAvailable()")).toBeLessThan(body.indexOf('staffSession("judge")'));
    expect(body.indexOf('staffSession("judge")')).toBeLessThan(body.indexOf("createPlaybackDeps()"));
    expect(get("lib/judging/server.ts")).toMatch(/export function createPlaybackDeps[\s\S]*?playbackEnabled\(/);
    expect(get("lib/judging/server.ts")).toContain('=== "yes"');
  });

  it("the judge screens read entries only through the judge_entries projection and never from submissions or parents' data", () => {
    for (const path of ["app/judge/page.tsx", "app/judge/entries/[id]/page.tsx"]) {
      const text = get(path);
      expect(text, path).toContain('from("judge_entries")');
      expect(text, path).not.toMatch(/from\("(submissions|video_uploads|winners|audit_log|user_roles)"\)|child_name|parent_|owner_id/);
    }
    for (const path of ["app/judge/actions.ts", "lib/judging/scoring.ts", "lib/judging/playback.ts"]) expect(get(path), path).not.toMatch(/from\("submissions"\)|child_name|parent_/);
  });

  it("every judge and administrator page checks the role first, and the area is in the session-refresh matcher", () => {
    for (const path of ["app/judge/page.tsx", "app/judge/entries/[id]/page.tsx"]) expect(get(path), path).toContain('requireStaff("judge")');
    for (const path of ["app/admin/page.tsx", "app/admin/events/[slug]/page.tsx"]) expect(get(path), path).toContain('requireStaff("admin")');
    expect(get("proxy.ts")).toContain('"/admin/:path*"');
    expect(get("proxy.ts")).toContain('"/judge/:path*"');
  });

  it("nothing in the app publishes results, opens registration or edits the settings", () => {
    for (const f of files.filter((x) => !isTest(x.path) && /^(app|components|lib)\//.test(x.path))) {
      expect(f.text, f.path).not.toMatch(/from\("event_settings"\)\s*\.\s*(update|upsert|insert)|results_publish_at["']?\s*:/);
    }
  });

  it("staff code never logs and never puts an object key or link in a client component", () => {
    const watched = files.filter((f) => !isTest(f.path) && /^(lib\/(judging|staff)\/|app\/(admin|judge)\/|components\/(admin|judge)\/)/.test(f.path));
    expect(watched.length).toBeGreaterThanOrEqual(12);
    for (const f of watched) expect(f.text, f.path).not.toMatch(/console\.(log|info|warn|error|debug)/);
    for (const f of files.filter((x) => !isTest(x.path) && /^components\/(admin|judge)\//.test(x.path))) expect(f.text, f.path).not.toMatch(/videos\/|pending\/|video_key/);
  });

  it(".env.example documents the playback switch as off", () => {
    const env = readFileSync(join(ROOT, ".env.example"), "utf8");
    expect(env).toContain("# RIO_PLAYBACK_ENABLED=no");
  });
});

describe("public results (M7)", () => {
  const get = (p: string) => files.find((f) => f.path === p)!.text;

  it("the results code reads only the published view and the publication time, anonymously, and never writes", () => {
    for (const path of ["lib/results/public.ts", "app/results/page.tsx", "components/results/winners-list.tsx", "lib/results/messages.ts"]) {
      const text = get(path).replace(/\/\/.*$/gm, "");
      expect(text, path).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(|SUPABASE_SECRET_KEY|createAdminClient|supabase\/server|from\("(submissions|winners|scores|judge_assignments|video_uploads|audit_log|user_roles)"\)|child_name|parent_|owner_id|video_key/);
    }
  });

  it("the page is rendered on every request and the route is served with no-store", () => {
    expect(get("app/results/page.tsx")).toContain('export const dynamic = "force-dynamic"');
    expect(get("app/results/page.tsx")).toContain("export const revalidate = 0");
    expect(get("next.config.ts")).toMatch(/source: "\/results", headers: \[\{ key: "Cache-Control", value: "no-store, max-age=0" \}\]/);
  });

  it("nothing in the app schedules or triggers publication, and the page never prints the scheduled time", () => {
    expect(get("components/results/winners-list.tsx")).not.toMatch(/publishAt|results_publish_at/);
    expect(get("lib/results/messages.ts")).not.toMatch(/results_publish_at|new Date|Date\.now/);
  });

  it("the public screen is a server component with no client code or third-party reference", () => {
    for (const path of ["components/results/winners-list.tsx", "app/results/page.tsx"]) {
      expect(get(path), path).not.toMatch(/"use client"|https?:\/\//);
    }
  });
});

describe("administrator winner screen shows the optional sharing permission (M7)", () => {
  it("the competition page selects and shows it, and warns on the confirm form when it was not given", () => {
    const page = files.find((f) => f.path === "app/admin/events/[slug]/page.tsx")!.text;
    const form = files.find((f) => f.path === "components/admin/winner-controls.tsx")!.text;
    expect(page).toContain("media_consent");
    expect(page).toContain("Permission to share the first name");
    expect(page).toContain("noSharePermission={e?.media_consent !== true}");
    expect(form).toContain("did not give the optional permission");
  });
});

describe("staff email-and-password sign-in (no public staff registration, no stored passwords)", () => {
  const get = (p: string) => files.find((f) => f.path === p)!.text;
  const source = files.filter((f) => !isTest(f.path) && /^(app|components|lib|scripts|proxy\.ts|next\.config\.ts)/.test(f.path));

  it("only the staff sign-in action and the provisioning script use passwords with Supabase Auth", () => {
    const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(source.filter((f) => /signInWithPassword/.test(code(f.text))).map((f) => f.path)).toEqual(["app/staff/login/actions.ts"]);
    expect(source.filter((f) => /auth\.admin\.(createUser|updateUserById)/.test(f.text) && /password/.test(f.text)).map((f) => f.path)).toEqual(["scripts/provision-staff.ts"]);
  });

  it("nothing in the application can register a staff account or sign anyone up", () => {
    for (const f of source.filter((x) => /^(app|components|lib)\//.test(x.path))) {
      expect(f.text, f.path).not.toMatch(/\.signUp\(|auth\.admin\.createUser|inviteUserByEmail|resetPasswordForEmail|updateUser\(\s*\{\s*password/);
    }
    // parents still sign in with an e-mailed code, in exactly one place
    expect(source.filter((f) => /signInWithOtp/.test(f.text)).map((f) => f.path)).toEqual(["app/signin/actions.ts"]);
  });

  it("no password is hardcoded, stored in SQL, or written to a file anywhere in the repository sources", () => {
    for (const f of source) expect(f.text, f.path).not.toMatch(/(password|passwd|pwd)\s*[:=]\s*["'`][^"'`$\s]{6,}["'`]/i);
    const sqlDir = join(ROOT, "supabase", "migrations");
    for (const name of readdirSync(sqlDir)) expect(readFileSync(join(sqlDir, name), "utf8"), name).not.toMatch(/encrypted_password|crypt\(|gen_salt|auth\.users[^;]*password/i);
  });

  it("the sign-in action never logs, never reads the environment, and never puts the password in a redirect, URL or result", () => {
    const text = get("app/staff/login/actions.ts").replace(/\/\/.*$/gm, "");
    expect(text).not.toMatch(/console\.|process\.env/);
    expect(text).toMatch(/redirect\(staffHome\(result\.role\)\)/);
    expect(text).not.toMatch(/redirect\([^)]*password/i);
    expect(text).not.toMatch(/return\s*\{[^}]*password/i);
    for (const path of ["lib/staff/login.ts", "components/staff/login-form.tsx", "app/staff/login/page.tsx"]) expect(get(path), path).not.toMatch(/console\./);
  });

  it("the role is checked after the password (staffRole), the destinations are fixed paths, and the page tells signed-out visitors to use /staff/login", () => {
    expect(get("app/staff/login/actions.ts")).toContain("roleOf: (userId) => staffRole(supabase, userId)");
    expect(get("lib/staff/paths.ts")).toContain('"/staff/login"');
    expect(get("lib/staff/auth.ts")).toContain("redirect(staffLoginPath)");
    expect(get("proxy.ts")).toContain('"/staff/:path*"');
  });

  it("the login form keeps the password out of the page: no value attribute, no default value, only the email is put back", () => {
    const text = get("components/staff/login-form.tsx");
    expect(text).toContain('name="password"');
    expect(text).not.toMatch(/name="password"[\s\S]{0,400}(defaultValue|value=\{)/);
    expect(text).toContain("defaultValue={state?.email");
  });

  it("the sign-out button lives in one bar that renders only for a verified member of the role", () => {
    const bar = get("components/staff/staff-bar.tsx");
    expect(bar).toContain("staffSession(role)");
    expect(bar).toContain("staffSignOut");
    expect(get("app/admin/layout.tsx")).toContain('<StaffBar role="admin" />');
    expect(get("app/judge/layout.tsx")).toContain('<StaffBar role="judge" />');
  });
});

describe("participation e-mail (M7)", () => {
  const get = (p: string) => files.find((f) => f.path === p)!.text;
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const emailFiles = files.filter((f) => !isTest(f.path) && /^(lib\/email\/|app\/api\/email-sweep\/)/.test(f.path));

  it("the provider key is read in exactly one file and never reaches the browser", () => {
    expect(files.filter((f) => !isTest(f.path) && /EMAIL_API_KEY/.test(code(f.text))).map((f) => f.path)).toEqual(["lib/email/config.ts"]);
    for (const f of files.filter((x) => !isTest(x.path) && /^(app|components)\//.test(x.path) && /"use client"/.test(x.text))) expect(f.text, f.path).not.toMatch(/lib\/email\/(server|provider|outbox)|EMAIL_|CRON_SECRET/);
    for (const f of files.filter((x) => !isTest(x.path))) expect(f.text, f.path).not.toMatch(/NEXT_PUBLIC_[A-Z0-9_]*(EMAIL|CRON)/);
  });

  it("the e-mail code never logs, never touches storage, and is imported by server code only", () => {
    expect(emailFiles.length).toBeGreaterThanOrEqual(6);
    for (const f of emailFiles) {
      expect(code(f.text), f.path).not.toMatch(/console\.|object-store|presign|videos\/|R2_/);
    }
    // the only things a page may import are the boolean switch and the masked-address helper, never the sending code
    for (const f of files.filter((x) => !isTest(x.path) && /^(app|components)\//.test(x.path) && !/^app\/(api\/email-sweep|events\/\[slug\]\/register\/submit-actions)/.test(x.path))) {
      expect(f.text, f.path).not.toMatch(/lib\/email\/(server|provider|outbox|template)/);
    }
  });

  it("only the one submit action queues a confirmation, after the response, and only for the request that made the transition", () => {
    const users = files.filter((f) => !isTest(f.path) && /queueConfirmation/.test(f.text)).map((f) => f.path).sort();
    expect(users).toEqual(["app/events/[slug]/register/submit-actions.ts", "lib/email/server.ts"]);
    const actions = get("app/events/[slug]/register/submit-actions.ts");
    expect(actions).toContain("if (result.ok && !result.already) after(() => queueConfirmation(input.submissionId));");
    expect(actions.indexOf("finalizeEntry(")).toBeLessThan(actions.indexOf("queueConfirmation("));
  });

  it("the retry endpoint answers 404 unless sending is available and the secret matches, using a constant-time comparison", () => {
    const route = code(get("app/api/email-sweep/route.ts"));
    expect(route).toContain("timingSafeEqual");
    expect(route).toContain("emailAvailable()");
    expect(route).toContain("force-dynamic");
    expect(route).not.toMatch(/searchParams|\.json\(\)|request\.body/); // nothing from the request is used except the header
  });

  it(".env.example documents the switch as off, and CLAUDE.md's rule that nothing sends until configured is kept in the template", () => {
    const env = readFileSync(join(ROOT, ".env.example"), "utf8");
    expect(env).toContain("# RIO_EMAIL_ENABLED=no");
    expect(env).toMatch(/exactly "yes"/);
  });
});

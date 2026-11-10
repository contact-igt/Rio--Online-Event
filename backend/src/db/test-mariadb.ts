import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { GuardError } from "./guards.ts";
import { assertMayDrop, assertNotApplicationAccount, newDisposableName, parseTestServerUrl, testDatabaseUrl, type TestServer } from "./test-runner-guards.ts";

// npm run test:mariadb
// Runs the whole test suite against a database that exists only for this run:
//   1. signs in as a DEDICATED local test account (RIO_TEST_SERVER_URL in the git-ignored .env.test.local). Never root, never the application
//      account, never a fallback: if the account is missing or lacks the grant, the run is BLOCKED and nothing is created or run;
//   2. creates rio_<12 random hex>_test (it must not already exist) and writes a secret marker inside it;
//   3. runs vitest with only RIO_TEST_* settings pointing at that database (the application's DATABASE_URL and every other setting are removed
//      from the environment, so nothing else can be reached);
//   4. drops that database, but only after re-reading the marker and checking the name: it never drops anything it did not create.
// Exit codes: 0 tests passed | 1 tests failed | 3 BLOCKED (nothing run) | 4 refused by a safety rule | 5 tests ran but cleanup failed.
// No credential is ever printed.

const out = (line: string) => process.stdout.write(`${line}\n`);
const err = (line: string) => process.stderr.write(`${line}\n`);
const VITEST = fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url));
const MARKER_TABLE = "rio_disposable_marker";
const id = (name: string) => mysql.escapeId(name);

async function connect(server: TestServer): Promise<mysql.Connection> {
  return mysql.createConnection({ host: server.host, port: server.port, user: server.user, password: server.password, connectTimeout: 5000 });
}
const code = (e: unknown): number | string => (e as { errno?: number; code?: string }).errno ?? (e as { code?: string }).code ?? "unknown";

async function main(): Promise<number> {
  const raw = process.env.RIO_TEST_SERVER_URL;
  if (!raw) {
    err("BLOCKED: RIO_TEST_SERVER_URL is not set, so the MariaDB integration tests were NOT RUN.");
    err("Create a dedicated local test account and put its URL in backend/.env.test.local (see backend/LOCAL_DEVELOPMENT.md section 4).");
    return 3;
  }
  let server: TestServer;
  try {
    server = parseTestServerUrl(raw);
    assertNotApplicationAccount(server, process.env.DATABASE_URL);
  } catch (error) {
    err(`REFUSED: ${error instanceof GuardError ? error.message : "RIO_TEST_SERVER_URL is not acceptable."}`);
    return 4;
  }

  let admin: mysql.Connection;
  try {
    admin = await connect(server);
  } catch (e) {
    err(`BLOCKED: could not sign in as the test account (${code(e)}). The MariaDB integration tests were NOT RUN. Nothing was created.`);
    return 3;
  }

  const name = newDisposableName();
  const token = randomBytes(16).toString("hex");
  let created = false;
  let status = 0;
  try {
    const [[who]] = (await admin.query("SELECT SUBSTRING_INDEX(CURRENT_USER(), '@', 1) AS u, VERSION() AS v")) as unknown as [[{ u: string; v: string }]];
    if (who.u.toLowerCase() !== server.user.toLowerCase()) {
      err("REFUSED: the server signed the connection in as a different account than the one requested.");
      return 4;
    }
    if (!/mariadb/i.test(who.v)) {
      err("BLOCKED: this runner is for the local MariaDB server; the server is not MariaDB. Nothing was created.");
      return 3;
    }
    const [taken] = (await admin.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = ?", [name])) as unknown as [unknown[]];
    if (taken.length > 0) {
      err("REFUSED: the generated database name already exists (vanishingly unlikely). Run again; nothing was touched.");
      return 4;
    }
    try {
      await admin.query(`CREATE DATABASE ${id(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      created = true;
    } catch (e) {
      err(`BLOCKED: the test account may not create databases named rio_<hex>_test (${code(e)}). Grant it \`rio\\_%\\_test\`.* (see LOCAL_DEVELOPMENT.md). The tests were NOT RUN.`);
      return 3;
    }
    try {
      await admin.query(`CREATE TABLE ${id(name)}.${id(MARKER_TABLE)} (token CHAR(32) NOT NULL PRIMARY KEY)`);
      await admin.query(`INSERT INTO ${id(name)}.${id(MARKER_TABLE)} (token) VALUES (?)`, [token]);
    } catch (e) {
      err(`BLOCKED: could not write the run marker inside the new database (${code(e)}); the tests were NOT RUN.`);
      return 3;
    }
    out(`test database: ${name} (created for this run only)`);

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (/^(DATABASE_URL|DB_|R2_|RIO_|SQLITE_|ALLOWED_|PUBLIC_|SESSION_|ARGON2_|REGISTRATION_|TRUST_)/.test(key)) delete env[key];
    Object.assign(env, {
      RIO_TEST_DATABASE_URL: testDatabaseUrl(server, name),
      RIO_TEST_DB_ENGINE: "mariadb",
      RIO_TEST_DB_ALLOWED_HOST: server.host,
      RIO_REQUIRE_MYSQL_TESTS: "yes",
    });
    status = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [VITEST, "run"], { env, stdio: "inherit" });
      const stop = () => child.kill();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      child.on("exit", (exitCode) => resolve(exitCode ?? 1));
      child.on("error", () => resolve(1));
    });
  } finally {
    if (created) {
      try {
        const [rows] = (await admin.query(`SELECT token FROM ${id(name)}.${id(MARKER_TABLE)}`)) as unknown as [{ token: string }[]];
        assertMayDrop(name, name, token, rows[0]?.token ?? null);
        await admin.query(`DROP DATABASE ${id(name)}`);
        const [left] = (await admin.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = ?", [name])) as unknown as [unknown[]];
        if (left.length > 0) throw new GuardError("still there");
        out(`test database ${name} dropped.`);
      } catch {
        err(`WARNING: the test database ${name} could not be verified and dropped. It was created by this run; drop it by hand if you want it gone.`);
        status = status === 0 ? 5 : status;
      }
    }
    await admin.end().catch(() => undefined);
  }
  return status;
}

process.exitCode = await main().catch(() => {
  err("The runner failed before it could report. Nothing about the connection is shown.");
  return 1;
});

import { randomBytes } from "node:crypto";
import { GuardError } from "./guards.ts";

// Safety rules for `npm run test:mariadb`, which creates a throw-away database, runs the test suite in it, and drops it. Kept apart from the
// runner so every rule is tested without a database. Messages are fixed sentences: a password, a user name from a URL or a host is never in one.

/** The only shape of database this tool may create or drop: rio_ + 12 random hex digits + _test. `rio_hospital` can never match. */
export const DISPOSABLE_NAME = /^rio_[0-9a-f]{12}_test$/;
export const newDisposableName = (): string => `rio_${randomBytes(6).toString("hex")}_test`;

/** Accounts that must never run the tests: administrators, the application's own account, and the stock system accounts. */
const FORBIDDEN_ACCOUNTS = new Set(["", "root", "rio_app", "pma", "mysql", "mariadb.sys", "mysql.sys", "mysql.session", "mysql.infoschema", "debian-sys-maint"]);
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export type TestServer = { host: string; port: number; user: string; password: string };

/** `RIO_TEST_SERVER_URL`: mysql://TEST_USER:TEST_PASSWORD@127.0.0.1:3306 with NO database in it. */
export function parseTestServerUrl(raw: string): TestServer {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GuardError("RIO_TEST_SERVER_URL is not a valid URL.");
  }
  if (url.protocol !== "mysql:") throw new GuardError("RIO_TEST_SERVER_URL must start with mysql://.");
  if (url.pathname !== "" && url.pathname !== "/") throw new GuardError("RIO_TEST_SERVER_URL must not name a database: the runner creates its own.");
  if (url.search !== "" || url.hash !== "") throw new GuardError("RIO_TEST_SERVER_URL must not have a query string or fragment.");
  if (!LOCAL_HOSTS.has(url.hostname)) throw new GuardError("RIO_TEST_SERVER_URL must point at this computer (127.0.0.1 or localhost).");
  const user = decodeURIComponent(url.username);
  if (FORBIDDEN_ACCOUNTS.has(user.toLowerCase())) throw new GuardError("The test account must be a dedicated account: root, the application account and system accounts are refused.");
  const password = decodeURIComponent(url.password);
  if (password === "") throw new GuardError("The test account must have a password.");
  return { host: url.hostname, port: url.port === "" ? 3306 : Number(url.port), user, password };
}

/** The test account must not be the account the application itself uses (DATABASE_URL), whatever its name. */
export function assertNotApplicationAccount(server: TestServer, applicationUrl: string | undefined): void {
  if (!applicationUrl) return;
  try {
    if (decodeURIComponent(new URL(applicationUrl).username).toLowerCase() === server.user.toLowerCase()) {
      throw new GuardError("The test account is the same account as DATABASE_URL: use a separate one.");
    }
  } catch (error) {
    if (error instanceof GuardError) throw error; // an unparseable DATABASE_URL is not this tool's concern
  }
}

export const testDatabaseUrl = (server: TestServer, database: string): string =>
  `mysql://${encodeURIComponent(server.user)}:${encodeURIComponent(server.password)}@${server.host}:${server.port}/${database}`;

/**
 * A database may be dropped only when ALL of these hold: its name has the disposable shape; it is the very name this run generated; and the
 * marker token read back from inside it is the token this run wrote at creation. Anything else is refused and the database is left alone.
 */
export function assertMayDrop(candidate: string, createdByThisRun: string, tokenWritten: string, tokenFound: string | null): void {
  if (!DISPOSABLE_NAME.test(candidate)) throw new GuardError("Refusing to drop: the name is not a disposable test database name.");
  if (candidate !== createdByThisRun) throw new GuardError("Refusing to drop: this run did not create that database.");
  if (tokenFound === null || tokenFound !== tokenWritten) throw new GuardError("Refusing to drop: the database does not carry this run's marker.");
}

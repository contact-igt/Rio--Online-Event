# Local development without Docker

The backend runs on your own machine against the **XAMPP database** (MariaDB, port 3306). No Docker, no container, no extra server. Production is
**MySQL 8** on Railway; this file explains how the two relate and what can and cannot be checked locally.

| | Local (XAMPP) | Production |
|---|---|---|
| Server | MariaDB 10.4 (ships with XAMPP) | MySQL 8 |
| `DB_ENGINE` | `mariadb` | `mysql` (the default) |
| Migration folder | `migrations/mariadb/` | `migrations/mysql/` |
| Database | `rio_hospital` (development). There is no standing test database. | the production database |
| Registration | closed (nothing here opens it) | closed until an administrator sets a window and a consent version |

SQLite (`DB_DIALECT=sqlite`) still works for a quick start with no server at all; it is what `npm test` uses when no test database is configured.

## 1. Database set-up

XAMPP already has an empty `rio_hospital` database once you create it in phpMyAdmin (utf8mb4). The backend then builds its tables itself with
`npm run db:migrate`. For anything beyond a quick start, use a dedicated account instead of `root`. In phpMyAdmin > SQL, replace the placeholder with a long
random password of your own and run:

```sql
CREATE USER IF NOT EXISTS 'rio_app'@'localhost' IDENTIFIED BY 'REPLACE-WITH-A-LONG-RANDOM-PASSWORD';
GRANT ALL PRIVILEGES ON rio_hospital.* TO 'rio_app'@'localhost';
```
Then use that account in `DATABASE_URL` below. (On this machine the privilege tables did not keep `GRANT`s after `FLUSH PRIVILEGES` when it was tried, so check
with `SHOW GRANTS FOR 'rio_app'@'localhost';` after a restart of MySQL before relying on it.)

**Strongly recommended** (a fresh XAMPP has `root` accounts with no password, and MariaDB listens on every network interface, not only this computer):
1. phpMyAdmin > User accounts > `root` > Change password (and put the same password in `C:\xampp\phpMyAdmin\config.inc.php`).
2. In `C:\xampp\mysql\bin\my.ini`, under `[mysqld]`, add `bind-address=127.0.0.1`, then restart MySQL from the XAMPP control panel.
3. In Windows Defender Firewall, remove or disable the inbound "Allow" rules named `mysqld` (Public profile), or block inbound TCP 3306.

## 2. `backend/.env.local` (git-ignored; you create it, nobody else needs to read it)

```
NODE_ENV=development
DB_DIALECT=mysql
DB_ENGINE=mariadb
DB_ALLOWED_HOST=127.0.0.1
DATABASE_URL=mysql://rio_app:YOUR-PASSWORD@127.0.0.1:3306/rio_hospital
ALLOWED_ORIGINS=http://localhost:3001
PUBLIC_ORIGINS=http://localhost:3000
```
Percent-encode special characters in the password (`@` becomes `%40`). The backend refuses to start if the host in `DATABASE_URL` is not `DB_ALLOWED_HOST`.

## 3. Everyday commands (inside `backend/`)

| Command | What it does | Writes? |
|---|---|---|
| `npm run db:status` | Lists every migration as applied or pending. | **No** (not even the tracking table). |
| `npm run db:ready` | A real query, plus a read-only check that every migration is applied. Prints `ready` or `not ready: <reason>`. | No |
| `npm run db:migrate` | Applies pending migrations from `migrations/mariadb/`, in order, with checksums. Refuses a changed, missing or out-of-order file. | Yes |
| `npm run db:seed:events` | Adds the six competitions (names and age ranges, from `website/lib/events.ts`) to `events`. Idempotent; never overwrites; stops on a conflict; `-- --dry-run` shows the plan. Local development only. | Yes |
| `npm run db:verify` | Checks that the `mysql`, `mariadb` and `sqlite` folders define the same migrations. | No |
| `npm run dev` | Starts the API on port 4000 (reads `.env.local`). | |
| `npm run staff:create-admin -- --email you@example.org --name "Your Name"` | Creates the first administrator; the temporary password is printed once. | Yes |

`GET /api/v1/health` only says the process is up; it does **not** touch the database. Use `npm run db:ready` for that.

The tools check `SELECT VERSION()` against `DB_ENGINE` and stop with a plain message if they disagree, so MySQL 8 migrations are never run on MariaDB by
mistake (or the reverse).

## 4. Running the automated tests

**The tests never run on `rio_hospital`.** They create and drop tables, so the configuration refuses any test database whose name does not end in `_test` (and
that is not on this computer). Plain `npm test` uses SQLite only and says so on every test file: `[rio] MySQL/MariaDB integration tests were NOT RUN`. Those
results prove nothing about MariaDB or MySQL.

### `npm run test:mariadb` (no standing test database)

It creates a database named `rio_<12 random hex>_test`, runs the whole suite there, and drops that database afterwards. It needs a **dedicated** local account:
never `root`, never the application account (`rio_app`), never a fallback. If the account is missing or lacks the grant, the run is **BLOCKED** (exit code 3) and
nothing is created or run.

One-time set-up, in phpMyAdmin > SQL (replace the placeholder with a long random password of your own):

```sql
CREATE USER IF NOT EXISTS 'rio_tester'@'localhost' IDENTIFIED BY 'REPLACE-WITH-A-LONG-RANDOM-PASSWORD';
GRANT ALL PRIVILEGES ON `rio\_%\_test`.* TO 'rio_tester'@'localhost';
```
The grant covers only databases whose names match `rio_..._test` (the backslashes make the underscores literal). It gives no access to `rio_hospital` or to any other
database on the server. Check it survived with `SHOW GRANTS FOR 'rio_tester'@'localhost';` after restarting MySQL: on this machine grants once vanished after
`FLUSH PRIVILEGES`, which would make the runner report BLOCKED.

Then create `backend/.env.test.local` (git-ignored) with one line, **no database name in it**:
```
RIO_TEST_SERVER_URL=mysql://rio_tester:YOUR-TEST-PASSWORD@127.0.0.1:3306
```
What the runner guarantees:
- refuses `root`, `rio_app`, system accounts, an account without a password, a URL that names a database, a host that is not this computer, and an account equal to the one in `DATABASE_URL`;
- the test process gets only `RIO_TEST_*` settings: the application's `DATABASE_URL`, R2 keys and every other setting are removed from its environment;
- it drops a database only if the name has the shape `rio_<12 hex>_test`, is the very name this run generated, and holds a secret marker this run wrote at creation; anything else is left alone;
- no credential is printed. Exit codes: 0 passed, 1 tests failed, 3 BLOCKED (nothing run), 4 refused by a safety rule, 5 tests ran but the cleanup could not be verified (the database name is printed so you can drop it by hand).

### Manual alternative

A database you created yourself, whose name ends in `_test`, with its URL in `RIO_TEST_DATABASE_URL` (plus `RIO_TEST_DB_ENGINE=mariadb`, `RIO_TEST_DB_ALLOWED_HOST=127.0.0.1`)
in `.env.test.local`, then `npm run test:local`. The tests wipe that database. Tests read only the `RIO_TEST_*` names, never `DATABASE_URL`.

## 5. What a MariaDB run does and does not prove

The MariaDB migrations are the reviewed MySQL 8 files with only the two collation names MariaDB lacks replaced (`utf8mb4_0900_bin` ->
`utf8mb4_nopad_bin`, the same exact comparison; `utf8mb4_0900_ai_ci` -> `utf8mb4_unicode_ci`, for display text only). A test guards that nothing else
differs. Error numbers differ between the servers (a CHECK failure is 3819 on MySQL 8 and 4025 on MariaDB); the backend maps both.

A green MariaDB run proves the schema, constraints, triggers and application behave on **MariaDB 10.4**. It does not prove MySQL 8 behaviour, and the
differences that could matter are listed in `migrations/README.md` (JSON columns are plain text in MariaDB, regular-expression engines differ, the
`ICU` versus `PCRE` rules for `REGEXP`). The MySQL 8 evidence recorded in `PROJECT_BRIEF.md` was obtained earlier and is not repeated by a MariaDB run.

Checking MySQL 8 itself needs a MySQL 8 server. Without Docker there are two ways: install MySQL Community Server 8.0 natively on Windows (use a
different port, such as 3308, so it does not clash with XAMPP) and run `npm run test:local` with `RIO_TEST_DB_ENGINE=mysql`; or rely on the GitHub
Actions `backend` job, which runs the whole suite against a MySQL 8 service and makes those tests mandatory. That job has not run on GitHub yet.

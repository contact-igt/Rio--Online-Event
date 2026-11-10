import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { DatabaseError, sanitizeDatabaseError } from "./errors.ts";

// Driver error shapes are simulated, so this runs without a database. The real drivers are exercised in adapter.test.ts.
const driver = (props: Record<string, unknown>) => Object.assign(new Error("secret host db.internal user admin: SELECT * FROM children WHERE name = 'Asha'"), props);

describe("sanitizeDatabaseError", () => {
  it.each([
    [{ errno: 1062, code: "ER_DUP_ENTRY" }, "constraint", "unique", false],
    [{ errno: 1452 }, "constraint", "foreign_key", false],
    [{ errno: 1451 }, "constraint", "foreign_key", false],
    [{ errno: 3819 }, "constraint", "check", false],
    [{ errno: 1048 }, "constraint", "not_null", false],
    [{ errno: 1644 }, "constraint", "rule", false],
    [{ errno: 1406 }, "constraint", "other", false],
    [{ errno: 1213 }, "deadlock", null, true],
    [{ errno: 1205 }, "timeout", null, false],
    [{ code: "ETIMEDOUT" }, "timeout", null, false],
    [{ errno: 1045, code: "ER_ACCESS_DENIED_ERROR" }, "misconfigured", null, false],
    [{ errno: 1049 }, "misconfigured", null, false],
    [{ code: "ECONNREFUSED" }, "unavailable", null, false],
    [{ code: "PROTOCOL_CONNECTION_LOST" }, "unavailable", null, false],
    [{ code: "ENOTFOUND" }, "unavailable", null, false],
    [{ errno: 1064, code: "ER_PARSE_ERROR" }, "query_failed", null, false],
    [{}, "query_failed", null, false],
  ])("mysql %j -> %s %s", (props, kind, constraint, retryable) => {
    expect(sanitizeDatabaseError("mysql", driver(props))).toMatchObject({ kind, constraint, retryable });
  });

  it("reads the real error out of an AggregateError (several addresses tried)", () => {
    const aggregate = Object.assign(new Error(""), { errors: [driver({ code: "ECONNREFUSED" }), driver({ code: "ECONNREFUSED" })] });
    expect(sanitizeDatabaseError("mysql", aggregate).kind).toBe("unavailable");
  });

  it.each([
    [{ errcode: 2067 }, "constraint", "unique", false],
    [{ errcode: 1555 }, "constraint", "unique", false],
    [{ errcode: 787 }, "constraint", "foreign_key", false],
    [{ errcode: 275 }, "constraint", "check", false],
    [{ errcode: 1299 }, "constraint", "not_null", false],
    [{ errcode: 1811 }, "constraint", "rule", false],
    [{ errcode: 19 }, "constraint", "other", false],
    [{ errcode: 5 }, "busy", null, true],
    [{ errcode: 261 }, "busy", null, true],
    [{ errcode: 14 }, "unavailable", null, false],
    [{ errcode: 1 }, "query_failed", null, false],
    [{}, "query_failed", null, false],
  ])("sqlite %j -> %s %s", (props, kind, constraint, retryable) => {
    expect(sanitizeDatabaseError("sqlite", driver(props))).toMatchObject({ kind, constraint, retryable });
  });

  it("copes with values that are not errors", () => {
    for (const odd of [null, undefined, "text", 42, {}]) expect(sanitizeDatabaseError("mysql", odd)).toBeInstanceOf(DatabaseError);
  });

  it("returns an existing DatabaseError unchanged", () => {
    const e = new DatabaseError("deadlock");
    expect(sanitizeDatabaseError("sqlite", e)).toBe(e);
  });

  it("keeps nothing of the original: no text, no cause, nothing in the printed form", () => {
    const e = sanitizeDatabaseError("mysql", driver({ errno: 1062 }));
    expect(e.message).toBe("Database error: constraint (unique)");
    expect(e.cause).toBeUndefined();
    expect(`${inspect(e, { depth: 6 })}${JSON.stringify(e)}`).not.toMatch(/db\.internal|admin|children|Asha|SELECT/);
    expect(e.code).toBe("constraint"); // what the logger keeps
  });
});

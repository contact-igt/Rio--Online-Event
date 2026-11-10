import type { DatabaseAdapter } from "./adapter.ts";

// Drops every table in a TEST database (callers must have passed assertResetAllowed). Table names come from the database's own catalogue
// and are quoted; no name is taken from input.
export async function dropAllTables(db: DatabaseAdapter): Promise<number> {
  return db.withConnection(async (connection) => {
    if (db.dialect === "mysql") {
      // Views first: they would otherwise be left pointing at tables that no longer exist.
      const views = await connection.query<{ name: string }>("SELECT table_name AS name FROM information_schema.views WHERE table_schema = DATABASE()");
      for (const { name } of views.rows) await connection.query(`DROP VIEW IF EXISTS \`${name.replace(/`/g, "``")}\``);
      const { rows } = await connection.query<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'");
      await connection.query("SET FOREIGN_KEY_CHECKS = 0");
      try {
        for (const { name } of rows) await connection.query(`DROP TABLE IF EXISTS \`${name.replace(/`/g, "``")}\``);
      } finally {
        await connection.query("SET FOREIGN_KEY_CHECKS = 1");
      }
      return rows.length;
    }
    const views = await connection.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'view'");
    for (const { name } of views.rows) await connection.query(`DROP VIEW IF EXISTS "${name.replace(/"/g, '""')}"`);
    const { rows } = await connection.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
    await connection.query("PRAGMA foreign_keys = OFF");
    try {
      for (const { name } of rows) await connection.query(`DROP TABLE IF EXISTS "${name.replace(/"/g, '""')}"`);
    } finally {
      await connection.query("PRAGMA foreign_keys = ON");
    }
    return rows.length;
  });
}

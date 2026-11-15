import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Queryable } from "../adapters/postgres";

/** Applies docs/schema.sql. Every statement is IF NOT EXISTS, so it is safe to re-run. */
export async function migrate(db: Queryable, schemaPath = resolve(process.cwd(), "docs/schema.sql")): Promise<void> {
  const sql = readFileSync(schemaPath, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
    await db.query(statement);
  }
}

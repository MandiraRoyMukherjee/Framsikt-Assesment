/**
 * CLI:  npm run db:migrate   |   npm run db:seed   |   npm run db:setup (both)
 * Reads DATABASE_URL from the environment (Node 20: `node --env-file=.env`, see package.json).
 */
import { createPool } from "../src/db/pool";
import { migrate } from "../src/db/migrate";
import { seed } from "../src/db/seed";

const command = process.argv[2];
const pool = createPool();

try {
  if (command === "migrate" || command === "setup") {
    await migrate(pool);
    console.log("migrated: tables employees, presence, refills (+ one-active-refill-per-office index)");
  }
  if (command === "seed" || command === "setup") {
    const r = await seed(pool);
    console.log(`seeded: ${r.employees} employees, ${r.presence} presence rows`);
  }
  if (!["migrate", "seed", "setup"].includes(command ?? "")) {
    console.error("usage: tsx scripts/db.ts <migrate|seed|setup>");
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}

import { Pool } from "pg";

/** Neon needs TLS; the connection string from the Neon dashboard already carries ?sslmode=require. */
export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env and paste your Neon connection string.");
  }
  return new Pool({ connectionString, max: 5 });
}

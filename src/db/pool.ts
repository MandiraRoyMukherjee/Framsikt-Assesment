import net from "node:net";
import { Pool } from "pg";

// Node >= 20 "happy eyeballs" gives each resolved address only 250 ms to connect. Neon's pooler resolves
// to several IPv4 + IPv6 addresses and a cross-region TLS handshake often needs a bit more, so connections
// fail intermittently with ETIMEDOUT / ENETUNREACH. A generous per-address timeout fixes that.
net.setDefaultAutoSelectFamilyAttemptTimeout?.(5000);

/** Neon needs TLS; the connection string from the Neon dashboard already carries ?sslmode=require. */
export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env and paste your Neon connection string.");
  }
  return new Pool({ connectionString, max: 5 });
}

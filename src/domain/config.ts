import { major } from "./money";
import type { Office } from "./types";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** All tunable rules in one place - each one is justified in docs/DESIGN.md. */
export interface Config {
  /** How long one volunteer has to answer an offer. */
  offerTtlMs: number;
  /** How long a committed volunteer has to buy. */
  commitTtlMs: number;
  /** Reminder is sent after this fraction of the commit window. */
  reminderFraction: number;
  /** Page the manager when a refill has been active this long. */
  escalateAfterMs: number;
  /** Page the manager after this many failed hand-overs. */
  maxAttempts: number;
  /** Volunteers with this many unreimbursed claims are skipped (unless everyone is). */
  claimCap: number;
  /** Window for "recent refills" / "recent misses" fairness counters. */
  fairnessWindowMs: number;
  /** HR claim still pending after this long -> chase the manager. */
  claimSlowMs: number;
  /** Minimum gap between two chases of the same claim. */
  chaseIntervalMs: number;
}

export const DEFAULT_CONFIG: Config = {
  offerTtlMs: 2 * HOUR,
  commitTtlMs: 24 * HOUR,
  reminderFraction: 0.5,
  escalateAfterMs: 48 * HOUR,
  maxAttempts: 3,
  claimCap: 2,
  fairnessWindowMs: 30 * DAY,
  claimSlowMs: 10 * DAY,
  chaseIntervalMs: 24 * HOUR,
};

export const OSLO: Office = {
  id: "OSL",
  name: "Oslo",
  currency: "NOK",
  monthlyBudget: major(6000, "NOK"),
  typicalMin: major(300, "NOK"),
  typicalMax: major(1200, "NOK"),
  timezone: "Europe/Oslo",
  managerId: "mgr-osl",
};

export const BENGALURU: Office = {
  id: "BLR",
  name: "Bengaluru",
  currency: "INR",
  monthlyBudget: major(15000, "INR"),
  typicalMin: major(500, "INR"),
  typicalMax: major(3000, "INR"),
  timezone: "Asia/Kolkata",
  managerId: "mgr-blr",
};

export const OFFICES: Office[] = [OSLO, BENGALURU];

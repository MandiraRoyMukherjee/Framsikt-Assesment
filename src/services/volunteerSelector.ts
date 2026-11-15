/**
 * Volunteer selection ("who buys?").
 *
 * Split in two on purpose:
 *  - rankCandidates(): PURE function (no I/O) - trivially unit-testable, deterministic.
 *  - buildCandidates(): gathers presence from the directory and stats from refill history.
 *
 * Ranking (earlier rule wins, later rules break ties):
 *  1. Physically able: in the office today or tomorrow (hybrid / holiday / visitors).
 *  2. Not over the unreimbursed-claim cap (protects people who already float money).
 *  3. In the office TODAY before "tomorrow" (box is empty now).
 *  4. Fewest refills in the last 30 days.
 *  5. Fewest missed commitments in the last 30 days (reliability, not punishment: it only breaks ties).
 *  6. Longest since last refill (never refilled = first).
 *  7. Employee id (final deterministic tie-break, so results are reproducible).
 */
import type { Config } from "../domain/config";
import { localDay } from "../domain/time";
import { DAY_MS } from "../domain/time";
import type { EmployeeId, Office, Refill } from "../domain/types";
import type { DirectoryPort } from "../ports";

export type Presence = "today" | "tomorrow";

export interface VolunteerStats {
  outstandingClaims: number;
  recentRefills: number;
  recentMisses: number;
  lastRefillAt?: Date;
}

export interface Candidate extends VolunteerStats {
  id: EmployeeId;
  presence: Presence;
}

export function rankCandidates(candidates: Candidate[], excluded: ReadonlySet<EmployeeId>, config: Config): Candidate[] {
  return candidates
    .filter((c) => !excluded.has(c.id))
    .sort((a, b) => {
      const aCapped = a.outstandingClaims >= config.claimCap ? 1 : 0;
      const bCapped = b.outstandingClaims >= config.claimCap ? 1 : 0;
      if (aCapped !== bCapped) return aCapped - bCapped;

      const aToday = a.presence === "today" ? 0 : 1;
      const bToday = b.presence === "today" ? 0 : 1;
      if (aToday !== bToday) return aToday - bToday;

      if (a.recentRefills !== b.recentRefills) return a.recentRefills - b.recentRefills;
      if (a.recentMisses !== b.recentMisses) return a.recentMisses - b.recentMisses;

      const aLast = a.lastRefillAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      const bLast = b.lastRefillAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      if (aLast !== bLast) return aLast - bLast;

      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/** Derive fairness counters from refill history - nothing extra to store or keep in sync. */
export function computeStats(refills: Refill[], now: Date, config: Config): Map<EmployeeId, VolunteerStats> {
  const stats = new Map<EmployeeId, VolunteerStats>();
  const windowStart = now.getTime() - config.fairnessWindowMs;
  const get = (id: EmployeeId): VolunteerStats => {
    let s = stats.get(id);
    if (!s) {
      s = { outstandingClaims: 0, recentRefills: 0, recentMisses: 0 };
      stats.set(id, s);
    }
    return s;
  };

  for (const r of refills) {
    for (const a of r.attempts) {
      if ((a.outcome === "timeout" || a.outcome === "missed_deadline") && a.at.getTime() >= windowStart) {
        get(a.volunteerId).recentMisses++;
      }
    }
    if (r.purchase && r.status !== "CANCELLED") {
      const s = get(r.purchase.buyerId);
      const at = r.purchase.purchasedAt;
      if (at.getTime() >= windowStart) s.recentRefills++;
      if (!s.lastRefillAt || at > s.lastRefillAt) s.lastRefillAt = at;
      // Money the volunteer has fronted and not yet received back.
      if (r.status === "PURCHASED" || r.status === "CLAIM_SUBMITTED") s.outstandingClaims++;
    }
  }
  return stats;
}

export async function buildCandidates(
  office: Office,
  now: Date,
  directory: DirectoryPort,
  refills: Refill[],
  config: Config,
): Promise<Candidate[]> {
  const today = localDay(now, office.timezone);
  const tomorrow = localDay(new Date(now.getTime() + DAY_MS), office.timezone);
  const stats = computeStats(refills, now, config);
  const volunteers = await directory.listVolunteers();

  const out: Candidate[] = [];
  for (const v of volunteers) {
    // Presence is physical: a visitor from the other office counts, a home-office day does not.
    let presence: Presence | undefined;
    if ((await directory.officeOn(v.id, today)) === office.id) presence = "today";
    else if ((await directory.officeOn(v.id, tomorrow)) === office.id) presence = "tomorrow";
    if (!presence) continue;
    const s = stats.get(v.id) ?? { outstandingClaims: 0, recentRefills: 0, recentMisses: 0 };
    out.push({ id: v.id, presence, ...s });
  }
  return out;
}

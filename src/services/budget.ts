/**
 * Budget check. Everything is DERIVED from refill history (no stored counters that could drift).
 *
 *   available = monthlyBudget - spent - reserved      (all in the office's own currency)
 *
 *  - spent    = purchases made in that month (office timezone), except rejected claims
 *               (HR refused to pay, so it is not a company cost - the manager handles the rest)
 *  - reserved = money earmarked for COMMITTED refills that have not been bought yet; this is what
 *               stops two parallel refills in one month from jointly overspending.
 */
import { add, gte, lt, min, sub, zero, type Money } from "../domain/money";
import { monthKey } from "../domain/time";
import type { Office, Refill } from "../domain/types";

export interface BudgetSummary {
  officeId: string;
  month: string;
  budget: Money;
  spent: Money;
  reserved: Money;
  available: Money;
  purchaseCount: number;
}

const countsAsSpend = (r: Refill): boolean =>
  !!r.purchase && r.status !== "CLAIM_REJECTED" && r.status !== "CANCELLED";

export function summarize(office: Office, month: string, refills: Refill[]): BudgetSummary {
  let spent = zero(office.currency);
  let reserved = zero(office.currency);
  let purchaseCount = 0;

  for (const r of refills) {
    if (r.officeId !== office.id) continue;
    if (countsAsSpend(r) && r.purchase && monthKey(r.purchase.purchasedAt, office.timezone) === month) {
      spent = add(spent, r.purchase.amount);
      purchaseCount++;
    }
    if (r.status === "COMMITTED" && r.reservation && r.committedAt && monthKey(r.committedAt, office.timezone) === month) {
      reserved = add(reserved, r.reservation);
    }
  }

  const available = sub(sub(office.monthlyBudget, spent), reserved);
  return { officeId: office.id, month, budget: office.monthlyBudget, spent, reserved, available, purchaseCount };
}

/** Can a new refill be started/offered? Needs at least a minimum typical purchase left. */
export function canStartRefill(office: Office, summary: BudgetSummary): boolean {
  return gte(summary.available, office.typicalMin);
}

/**
 * How much to earmark when a volunteer commits: a full typical-max purchase if it fits,
 * otherwise whatever is left (never negative).
 */
export function reservationFor(office: Office, summary: BudgetSummary): Money {
  const left = lt(summary.available, zero(office.currency)) ? zero(office.currency) : summary.available;
  return min(office.typicalMax, left);
}

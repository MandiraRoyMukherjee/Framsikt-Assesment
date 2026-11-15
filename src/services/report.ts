/**
 * Monthly management report: one document, both offices, one comparable total.
 *
 *  - Each office is summed in its NATIVE currency first (exact integer arithmetic).
 *  - Conversion to the reporting currency happens ONCE per office total, never per purchase,
 *    so rounding error cannot accumulate and the native figures stay the source of truth.
 *  - The FX rate used is returned in the report, so the number can be audited later.
 */
import { add, convert, zero, type Currency, type Money } from "../domain/money";
import { monthKey } from "../domain/time";
import type { EmployeeId, Office, Refill } from "../domain/types";
import type { FxPort } from "../ports";
import { summarize } from "./budget";

export interface OfficeReport {
  officeId: string;
  officeName: string;
  budget: Money;
  spent: Money;
  /** spent / budget in basis points (10000 = 100%). Integer to avoid float noise. */
  budgetUsedBps: number;
  purchaseCount: number;
  spentInReportingCurrency: Money;
  fxRateMicro: number;
  topItems: { name: string; quantity: number }[];
  /** Number of purchases per buyer - shows whether a few people do most refills. */
  refillsByVolunteer: { volunteerId: EmployeeId; count: number }[];
  /** Purchases not yet reimbursed (still waiting on HR). */
  outstandingClaims: number;
  flaggedRefills: number;
}

export interface MonthlyReport {
  month: string;
  reportingCurrency: Currency;
  offices: OfficeReport[];
  total: Money;
  /** Native totals per currency, for people who distrust conversions. */
  nativeTotals: Money[];
}

export function buildMonthlyReport(
  month: string,
  offices: Office[],
  refills: Refill[],
  fx: FxPort,
  reportingCurrency: Currency = "NOK",
): MonthlyReport {
  const reports: OfficeReport[] = offices.map((office) => {
    const s = summarize(office, month, refills);
    const rate = fx.rateMicro(office.currency, reportingCurrency, month);

    const inMonth = refills.filter(
      (r) =>
        r.officeId === office.id &&
        r.purchase &&
        r.status !== "CLAIM_REJECTED" &&
        r.status !== "CANCELLED" &&
        monthKey(r.purchase.purchasedAt, office.timezone) === month,
    );

    const items = new Map<string, number>();
    const byVolunteer = new Map<EmployeeId, number>();
    let outstanding = 0;
    let flagged = 0;
    for (const r of inMonth) {
      for (const i of r.purchase!.items) items.set(i.name, (items.get(i.name) ?? 0) + i.quantity);
      byVolunteer.set(r.purchase!.buyerId, (byVolunteer.get(r.purchase!.buyerId) ?? 0) + 1);
      if (r.status === "PURCHASED" || r.status === "CLAIM_SUBMITTED") outstanding++;
      if (r.flags.some((f) => f !== "BUDGET_BLOCKED")) flagged++;
    }

    return {
      officeId: office.id,
      officeName: office.name,
      budget: office.monthlyBudget,
      spent: s.spent,
      budgetUsedBps: Math.round((s.spent.minor * 10000) / office.monthlyBudget.minor),
      purchaseCount: s.purchaseCount,
      spentInReportingCurrency: convert(s.spent, reportingCurrency, rate),
      fxRateMicro: rate,
      topItems: [...items.entries()]
        .map(([name, quantity]) => ({ name, quantity }))
        .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name)),
      refillsByVolunteer: [...byVolunteer.entries()]
        .map(([volunteerId, count]) => ({ volunteerId, count }))
        .sort((a, b) => b.count - a.count || a.volunteerId.localeCompare(b.volunteerId)),
      outstandingClaims: outstanding,
      flaggedRefills: flagged,
    };
  });

  const total = reports.reduce((acc, r) => add(acc, r.spentInReportingCurrency), zero(reportingCurrency));
  const nativeTotals = [...new Set(offices.map((o) => o.currency))].map((c) =>
    reports.filter((r) => r.spent.currency === c).reduce((acc, r) => add(acc, r.spent), zero(c)),
  );
  return { month, reportingCurrency, offices: reports, total, nativeTotals };
}

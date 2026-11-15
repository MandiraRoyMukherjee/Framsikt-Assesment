import { describe, expect, it } from "vitest";
import { FakeFx } from "../src/adapters/fakes";
import { OFFICES } from "../src/domain/config";
import { CurrencyMismatchError } from "../src/domain/errors";
import { major, money } from "../src/domain/money";
import type { Refill } from "../src/domain/types";
import { buildMonthlyReport } from "../src/services/report";

const fx = new FakeFx(); // 1 INR = 0.125 NOK

let n = 0;
const bought = (
  officeId: "OSL" | "BLR",
  amount: number,
  at: string,
  opts: { status?: Refill["status"]; buyer?: string; items?: { name: string; quantity: number }[]; flags?: Refill["flags"] } = {},
): Refill => ({
  id: `r${++n}`,
  officeId,
  status: opts.status ?? "REIMBURSED",
  version: 1,
  reportedBy: "x",
  createdAt: new Date(at),
  selfTakeOpen: false,
  attempts: [],
  flags: opts.flags ?? [],
  purchase: {
    buyerId: opts.buyer ?? "a",
    amount: major(amount, officeId === "OSL" ? "NOK" : "INR"),
    receipt: { imageRef: "i" },
    items: opts.items ?? [],
    purchasedAt: new Date(at),
  },
});

describe("monthly report across both currencies", () => {
  const refills = [
    bought("OSL", 1000, "2026-03-03T10:00:00Z", { buyer: "anna", items: [{ name: "Chips", quantity: 5 }, { name: "Nuts", quantity: 2 }] }),
    bought("OSL", 800, "2026-03-12T10:00:00Z", { buyer: "anna", status: "CLAIM_SUBMITTED", items: [{ name: "Chips", quantity: 3 }] }),
    bought("OSL", 600, "2026-03-20T10:00:00Z", { buyer: "bjorn", items: [{ name: "Fruit", quantity: 10 }] }),
    bought("BLR", 2500, "2026-03-04T10:00:00Z", { buyer: "ravi" }),
    bought("BLR", 1500, "2026-03-18T10:00:00Z", { buyer: "sita" }),
    bought("OSL", 999, "2026-02-27T10:00:00Z"), // February - excluded
    bought("OSL", 700, "2026-03-25T10:00:00Z", { status: "CLAIM_REJECTED" }), // rejected - excluded
  ];

  const report = buildMonthlyReport("2026-03", OFFICES, refills, fx);
  const oslo = report.offices.find((o) => o.officeId === "OSL")!;
  const blr = report.offices.find((o) => o.officeId === "BLR")!;

  it("totals each office in its own currency", () => {
    expect(oslo.spent).toEqual(major(2400, "NOK"));
    expect(blr.spent).toEqual(major(4000, "INR"));
    expect(oslo.purchaseCount).toBe(3);
    expect(blr.purchaseCount).toBe(2);
  });

  it("combined total = Oslo NOK + Bengaluru INR converted to NOK (4 000 INR = 500 NOK)", () => {
    expect(blr.spentInReportingCurrency).toEqual(major(500, "NOK"));
    expect(report.total).toEqual(major(2900, "NOK"));
    expect(report.reportingCurrency).toBe("NOK");
  });

  it("also exposes native totals per currency and the FX rate used", () => {
    expect(report.nativeTotals).toEqual([major(2400, "NOK"), major(4000, "INR")]);
    expect(blr.fxRateMicro).toBe(125_000);
    expect(oslo.fxRateMicro).toBe(1_000_000);
  });

  it("can report in INR instead", () => {
    const inr = buildMonthlyReport("2026-03", OFFICES, refills, fx, "INR");
    expect(inr.total).toEqual(major(2400 * 8 + 4000, "INR"));
  });

  it("computes budget usage against each office's own budget (basis points)", () => {
    expect(oslo.budgetUsedBps).toBe(4000); // 2 400 / 6 000 = 40.00%
    expect(blr.budgetUsedBps).toBe(2667); // 4 000 / 15 000 = 26.67%
  });

  it("shows what actually gets eaten: items summed and sorted by quantity", () => {
    expect(oslo.topItems).toEqual([
      { name: "Fruit", quantity: 10 },
      { name: "Chips", quantity: 8 },
      { name: "Nuts", quantity: 2 },
    ]);
  });

  it("shows who does the refills and what is still waiting on HR", () => {
    expect(oslo.refillsByVolunteer).toEqual([
      { volunteerId: "anna", count: 2 },
      { volunteerId: "bjorn", count: 1 },
    ]);
    expect(oslo.outstandingClaims).toBe(1);
  });

  it("counts flagged refills (over budget / unusual amount) for management attention", () => {
    const r = buildMonthlyReport(
      "2026-03",
      OFFICES,
      [bought("OSL", 300, "2026-03-03T10:00:00Z", { flags: ["UNUSUAL_AMOUNT"] }), bought("OSL", 500, "2026-03-04T10:00:00Z")],
      fx,
    );
    expect(r.offices.find((o) => o.officeId === "OSL")?.flaggedRefills).toBe(1);
  });

  it("an empty month is all zeros, not an error", () => {
    const r = buildMonthlyReport("2026-04", OFFICES, refills, fx);
    expect(r.total).toEqual(major(0, "NOK"));
    expect(r.offices.every((o) => o.purchaseCount === 0)).toBe(true);
  });

  it("rounds once per office, not per purchase (no accumulated drift)", () => {
    // Three purchases of 1.00 INR at 0.3333 NOK/INR.
    // Rounding each purchase gives 3 x 0.33 = 0.99 NOK; rounding the office total (3.00 INR) gives 1.00 NOK.
    const rates = new FakeFx({ "INR>NOK": 333_300, "NOK>INR": 3_000_000 });
    const three = [1, 2, 3].map((i) => bought("BLR", 1, `2026-03-0${i}T10:00:00Z`));
    const r = buildMonthlyReport("2026-03", OFFICES, three, rates);
    expect(r.offices.find((o) => o.officeId === "BLR")?.spentInReportingCurrency).toEqual(money(100, "NOK"));
  });

  it("direct arithmetic across currencies is impossible (guarded by the Money type)", async () => {
    const { add } = await import("../src/domain/money");
    expect(() => add(major(1, "NOK"), major(1, "INR"))).toThrow(CurrencyMismatchError);
  });
});

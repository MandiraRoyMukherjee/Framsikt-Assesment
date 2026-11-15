import { describe, expect, it } from "vitest";
import { BENGALURU, OSLO } from "../src/domain/config";
import { major } from "../src/domain/money";
import type { Office, Refill } from "../src/domain/types";
import { canStartRefill, reservationFor, summarize } from "../src/services/budget";

const base = (office: Office, over: Partial<Refill>): Refill => ({
  id: Math.random().toString(36).slice(2),
  officeId: office.id,
  status: "REIMBURSED",
  version: 1,
  reportedBy: "x",
  createdAt: new Date("2026-03-01T08:00:00Z"),
  selfTakeOpen: false,
  attempts: [],
  flags: [],
  ...over,
});

const bought = (office: Office, amount: number, at: string, status: Refill["status"] = "REIMBURSED"): Refill =>
  base(office, {
    status,
    purchase: { buyerId: "a", amount: major(amount, office.currency), receipt: { imageRef: "i" }, items: [], purchasedAt: new Date(at) },
  });

describe("budget check", () => {
  it("available = budget - spent - reserved, in the office's own currency", () => {
    const refills = [
      bought(OSLO, 1000, "2026-03-03T10:00:00Z"),
      bought(OSLO, 500, "2026-03-09T10:00:00Z", "CLAIM_SUBMITTED"),
      base(OSLO, { status: "COMMITTED", reservation: major(1200, "NOK"), committedAt: new Date("2026-03-10T08:00:00Z") }),
    ];
    const s = summarize(OSLO, "2026-03", refills);
    expect(s.spent).toEqual(major(1500, "NOK"));
    expect(s.reserved).toEqual(major(1200, "NOK"));
    expect(s.available).toEqual(major(3300, "NOK"));
    expect(s.purchaseCount).toBe(2);
  });

  it("keeps the two offices independent (NOK and INR never mix)", () => {
    const refills = [bought(OSLO, 1000, "2026-03-03T10:00:00Z"), bought(BENGALURU, 2500, "2026-03-04T10:00:00Z")];
    expect(summarize(OSLO, "2026-03", refills).spent).toEqual(major(1000, "NOK"));
    const blr = summarize(BENGALURU, "2026-03", refills);
    expect(blr.spent).toEqual(major(2500, "INR"));
    expect(blr.available).toEqual(major(12500, "INR"));
  });

  it("only counts purchases of the requested month", () => {
    const refills = [bought(OSLO, 800, "2026-02-27T10:00:00Z"), bought(OSLO, 400, "2026-03-02T10:00:00Z")];
    expect(summarize(OSLO, "2026-03", refills).spent).toEqual(major(400, "NOK"));
    expect(summarize(OSLO, "2026-02", refills).spent).toEqual(major(800, "NOK"));
  });

  it("uses the OFFICE timezone for the month boundary (Oslo 00:30 on the 1st is already March)", () => {
    // 2026-02-28T23:30Z == 2026-03-01 00:30 in Oslo (UTC+1)
    const r = bought(OSLO, 700, "2026-02-28T23:30:00Z");
    expect(summarize(OSLO, "2026-03", [r]).spent).toEqual(major(700, "NOK"));
    expect(summarize(OSLO, "2026-02", [r]).spent).toEqual(major(0, "NOK"));
  });

  it("does not count rejected claims or cancelled refills as spend", () => {
    const refills = [bought(OSLO, 900, "2026-03-03T10:00:00Z", "CLAIM_REJECTED")];
    expect(summarize(OSLO, "2026-03", refills).spent).toEqual(major(0, "NOK"));
  });

  it("blocks a new refill when less than the minimum typical purchase is left", () => {
    const nearlyFull = [bought(OSLO, 5800, "2026-03-03T10:00:00Z")]; // 200 NOK left < 300 min
    expect(canStartRefill(OSLO, summarize(OSLO, "2026-03", nearlyFull))).toBe(false);
    const ok = [bought(OSLO, 5700, "2026-03-03T10:00:00Z")]; // exactly 300 left
    expect(canStartRefill(OSLO, summarize(OSLO, "2026-03", ok))).toBe(true);
  });

  it("reserves a full typical-max purchase when it fits, otherwise what is left", () => {
    expect(reservationFor(OSLO, summarize(OSLO, "2026-03", []))).toEqual(major(1200, "NOK"));
    const tight = [bought(OSLO, 5300, "2026-03-03T10:00:00Z")]; // 700 left
    expect(reservationFor(OSLO, summarize(OSLO, "2026-03", tight))).toEqual(major(700, "NOK"));
    const over = [bought(OSLO, 6500, "2026-03-03T10:00:00Z")]; // already over budget
    expect(reservationFor(OSLO, summarize(OSLO, "2026-03", over))).toEqual(major(0, "NOK"));
  });

  it("reservations of one refill reduce what the next refill may reserve (no joint overspend)", () => {
    const refills = [
      base(OSLO, { status: "COMMITTED", reservation: major(1200, "NOK"), committedAt: new Date("2026-03-10T08:00:00Z") }),
    ];
    expect(summarize(OSLO, "2026-03", refills).available).toEqual(major(4800, "NOK"));
  });
});

import { describe, expect, it } from "vitest";
import { FakeDirectory } from "../src/adapters/fakes";
import { DEFAULT_CONFIG, OSLO, BENGALURU } from "../src/domain/config";
import { major } from "../src/domain/money";
import type { Refill } from "../src/domain/types";
import {
  buildCandidates,
  computeStats,
  rankCandidates,
  type Candidate,
} from "../src/services/volunteerSelector";

const NOW = new Date("2026-03-10T09:00:00Z"); // Tuesday
const cfg = DEFAULT_CONFIG;

const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id,
  presence: "today",
  outstandingClaims: 0,
  recentRefills: 0,
  recentMisses: 0,
  ...over,
});

const ids = (cs: Candidate[]) => cs.map((c) => c.id);

describe("rankCandidates (pure ranking rules)", () => {
  it("prefers the person with fewer refills in the last 30 days (spreads the load)", () => {
    const ranked = rankCandidates(
      [cand("a", { recentRefills: 3 }), cand("b", { recentRefills: 0 }), cand("c", { recentRefills: 1 })],
      new Set(),
      cfg,
    );
    expect(ids(ranked)).toEqual(["b", "c", "a"]);
  });

  it("skips people who already float money for >= claimCap unreimbursed claims", () => {
    const ranked = rankCandidates(
      [cand("a", { outstandingClaims: 2, recentRefills: 0 }), cand("b", { outstandingClaims: 0, recentRefills: 5 })],
      new Set(),
      cfg,
    );
    // b has done far more refills, but a is still waiting for money -> b goes first
    expect(ids(ranked)).toEqual(["b", "a"]);
  });

  it("still returns capped people if everyone is capped (never leaves the box empty)", () => {
    const ranked = rankCandidates(
      [cand("a", { outstandingClaims: 2 }), cand("b", { outstandingClaims: 3 })],
      new Set(),
      cfg,
    );
    expect(ranked).toHaveLength(2);
  });

  it("prefers someone in the office today over someone only there tomorrow", () => {
    const ranked = rankCandidates(
      [cand("a", { presence: "tomorrow", recentRefills: 0 }), cand("b", { presence: "today", recentRefills: 4 })],
      new Set(),
      cfg,
    );
    expect(ids(ranked)).toEqual(["b", "a"]);
  });

  it("uses missed commitments, then longest-since-last-refill as tie-breakers", () => {
    const ranked = rankCandidates(
      [
        cand("a", { recentMisses: 1 }),
        cand("b", { lastRefillAt: new Date("2026-02-20T00:00:00Z") }),
        cand("c", { lastRefillAt: new Date("2026-01-05T00:00:00Z") }),
        cand("d"), // never refilled
      ],
      new Set(),
      cfg,
    );
    expect(ids(ranked)).toEqual(["d", "c", "b", "a"]);
  });

  it("excludes people who already declined / timed out on this refill", () => {
    const ranked = rankCandidates([cand("a"), cand("b")], new Set(["a"]), cfg);
    expect(ids(ranked)).toEqual(["b"]);
  });

  it("is deterministic: identical stats are ordered by id", () => {
    const ranked = rankCandidates([cand("z"), cand("m"), cand("a")], new Set(), cfg);
    expect(ids(ranked)).toEqual(["a", "m", "z"]);
  });
});

const refill = (over: Partial<Refill>): Refill => ({
  id: "r",
  officeId: "OSL",
  status: "REIMBURSED",
  version: 1,
  reportedBy: "x",
  createdAt: NOW,
  selfTakeOpen: false,
  attempts: [],
  flags: [],
  ...over,
});

const purchase = (buyerId: string, daysAgo: number) => ({
  buyerId,
  amount: major(500, "NOK"),
  receipt: { imageRef: "img" },
  items: [],
  purchasedAt: new Date(NOW.getTime() - daysAgo * 86_400_000),
});

describe("computeStats (fairness counters derived from history)", () => {
  it("counts outstanding claims only for PURCHASED / CLAIM_SUBMITTED, not REIMBURSED", () => {
    const stats = computeStats(
      [
        refill({ id: "1", status: "CLAIM_SUBMITTED", purchase: purchase("a", 3) }),
        refill({ id: "2", status: "PURCHASED", purchase: purchase("a", 1) }),
        refill({ id: "3", status: "REIMBURSED", purchase: purchase("a", 12) }),
      ],
      NOW,
      cfg,
    );
    expect(stats.get("a")?.outstandingClaims).toBe(2);
    expect(stats.get("a")?.recentRefills).toBe(3);
  });

  it("ignores refills older than the 30-day window for the load counter", () => {
    const stats = computeStats([refill({ purchase: purchase("a", 45) })], NOW, cfg);
    expect(stats.get("a")?.recentRefills).toBe(0);
    expect(stats.get("a")?.lastRefillAt).toEqual(new Date(NOW.getTime() - 45 * 86_400_000));
  });

  it("counts timeouts and missed deadlines, but not declines (declining is allowed)", () => {
    const at = NOW;
    const stats = computeStats(
      [
        refill({
          attempts: [
            { volunteerId: "a", outcome: "timeout", at },
            { volunteerId: "a", outcome: "missed_deadline", at },
            { volunteerId: "a", outcome: "declined", at },
            { volunteerId: "a", outcome: "released", at },
          ],
        }),
      ],
      NOW,
      cfg,
    );
    expect(stats.get("a")?.recentMisses).toBe(2);
  });
});

describe("buildCandidates (presence: hybrid, holiday, visitors)", () => {
  const dir = new FakeDirectory()
    .add({ id: "osl-office", name: "O1", homeOfficeId: "OSL", payrollCurrency: "NOK", isVolunteer: true })
    .add({ id: "osl-home", name: "O2", homeOfficeId: "OSL", payrollCurrency: "NOK", isVolunteer: true })
    .add({ id: "osl-holiday", name: "O3", homeOfficeId: "OSL", payrollCurrency: "NOK", isVolunteer: true })
    .add({ id: "osl-visiting-blr", name: "O4", homeOfficeId: "OSL", payrollCurrency: "NOK", isVolunteer: true })
    .add({ id: "blr-visiting-osl", name: "B1", homeOfficeId: "BLR", payrollCurrency: "INR", isVolunteer: true })
    .add({ id: "osl-not-volunteer", name: "O5", homeOfficeId: "OSL", payrollCurrency: "NOK", isVolunteer: false });

  dir.setPresence("osl-home", "2026-03-10", null);
  dir.setPresence("osl-home", "2026-03-11", null);
  dir.setPresence("osl-holiday", "2026-03-10", null);
  dir.setPresence("osl-holiday", "2026-03-11", null);
  dir.setPresence("osl-visiting-blr", "2026-03-10", "BLR");
  dir.setPresence("osl-visiting-blr", "2026-03-11", "BLR");
  dir.setPresence("blr-visiting-osl", "2026-03-10", "OSL");
  dir.setPresence("blr-visiting-osl", "2026-03-11", "OSL");

  it("Oslo candidates = people physically in Oslo (incl. a Bengaluru visitor), not home/holiday/away", async () => {
    const out = await buildCandidates(OSLO, NOW, dir, [], cfg);
    expect(out.map((c) => c.id).sort()).toEqual(["blr-visiting-osl", "osl-office"]);
  });

  it("an Oslo employee visiting Bengaluru becomes a Bengaluru candidate", async () => {
    const out = await buildCandidates(BENGALURU, NOW, dir, [], cfg);
    expect(out.map((c) => c.id)).toEqual(["osl-visiting-blr"]);
  });

  it("someone home today but in the office tomorrow is a 'tomorrow' candidate", async () => {
    const d = new FakeDirectory()
      .add({ id: "p", name: "P", homeOfficeId: "OSL", payrollCurrency: "NOK", isVolunteer: true })
      .setPresence("p", "2026-03-10", null);
    const out = await buildCandidates(OSLO, NOW, d, [], cfg);
    expect(out).toHaveLength(1);
    expect(out[0]?.presence).toBe("tomorrow");
  });
});

import { newDb } from "pg-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { PostgresDirectory, PostgresRefillRepository } from "../src/adapters/postgres";
import { FakeChat, FakeClock, FakeFx, FakeHr } from "../src/adapters/fakes";
import { DEFAULT_CONFIG, OFFICES } from "../src/domain/config";
import { ActiveRefillExistsError, ConflictError } from "../src/domain/errors";
import { major } from "../src/domain/money";
import type { Refill } from "../src/domain/types";
import { migrate } from "../src/db/migrate";
import { seed } from "../src/db/seed";
import { SEED_EMPLOYEES } from "../src/demo/seedData";
import { buildMonthlyReport } from "../src/services/report";
import { RefillService } from "../src/services/refillService";
import { START, HOUR } from "./helpers/setup";

async function freshDb() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  await seed(pool);
  return pool;
}

const sample = (over: Partial<Refill> = {}): Refill => ({
  id: "r1",
  officeId: "OSL",
  status: "OPEN",
  version: 1,
  reportedBy: "anna",
  createdAt: START,
  selfTakeOpen: false,
  attempts: [],
  flags: [],
  ...over,
});

describe("migrate + seed", () => {
  it("creates the tables and seeds ~15 Oslo and ~20 Bengaluru volunteers", async () => {
    const pool = await freshDb();
    const dir = new PostgresDirectory(pool);
    const vols = await dir.listVolunteers();
    expect(vols.filter((v) => v.homeOfficeId === "OSL")).toHaveLength(15);
    expect(vols.filter((v) => v.homeOfficeId === "BLR")).toHaveLength(20);
    expect(vols.every((v) => v.isVolunteer)).toBe(true);
    expect(SEED_EMPLOYEES.length).toBe((await pool.query("SELECT count(*)::int AS n FROM employees")).rows[0].n);
  });

  it("seed is idempotent: running it again does not duplicate rows", async () => {
    // (migrate's CREATE ... IF NOT EXISTS re-run is a real-Postgres feature that pg-mem does not simulate.)
    const pool = await freshDb();
    await seed(pool);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM employees");
    expect(rows[0].n).toBe(SEED_EMPLOYEES.length);
  });
});

describe("PostgresDirectory (presence)", () => {
  it("default = home office; presence rows override (holiday, visiting)", async () => {
    const dir = new PostgresDirectory(await freshDb());
    expect(await dir.officeOn("chloe", "2026-03-10")).toBe("OSL"); // default
    expect(await dir.officeOn("anna", "2026-03-10")).toBeNull(); // holiday
    expect(await dir.officeOn("bjorn", "2026-03-12")).toBe("BLR"); // visiting Bengaluru
  });
});

describe("PostgresRefillRepository (same contract as the in-memory one)", () => {
  let repo: PostgresRefillRepository;
  beforeEach(async () => {
    repo = new PostgresRefillRepository(await freshDb());
  });

  it("round-trips a refill including dates, money, attempts, purchase and claim", async () => {
    const r = sample({
      status: "CLAIM_SUBMITTED",
      attempts: [{ volunteerId: "bjorn", outcome: "timeout", at: START }],
      purchase: {
        buyerId: "anna",
        amount: major(840, "NOK"),
        receipt: { imageRef: "r.jpg" },
        items: [{ name: "Chips", quantity: 3 }],
        purchasedAt: START,
      },
      claim: { hrClaimId: "HR-1", status: "PENDING", submittedAt: START },
    });
    await repo.insert(r);
    const back = (await repo.get("r1"))!;
    expect(back).toEqual(r);
    expect(back.purchase?.purchasedAt).toBeInstanceOf(Date);
  });

  it("the DATABASE rejects a second active refill for the same office (partial unique index)", async () => {
    await repo.insert(sample({ id: "a" }));
    await expect(repo.insert(sample({ id: "b" }))).rejects.toBeInstanceOf(ActiveRefillExistsError);
    await repo.insert(sample({ id: "c", officeId: "BLR" })); // other office is fine
  });

  it("a finished refill no longer blocks a new one", async () => {
    await repo.insert(sample({ id: "a", status: "REIMBURSED" }));
    await repo.insert(sample({ id: "b" }));
    expect((await repo.findActiveByOffice("OSL"))?.id).toBe("b");
  });

  it("save is compare-and-set: a stale writer gets ConflictError and the version increments", async () => {
    await repo.insert(sample());
    const a = (await repo.get("r1"))!;
    const b = (await repo.get("r1"))!;
    a.status = "OFFERED";
    await repo.save(a, a.version);
    expect(a.version).toBe(2);
    b.status = "OFFERED";
    await expect(repo.save(b, b.version)).rejects.toBeInstanceOf(ConflictError);
    expect((await repo.get("r1"))?.version).toBe(2);
  });
});

describe("RefillService running on Postgres (same behaviour as on the in-memory repo)", () => {
  it("full lifecycle: report -> accept -> purchase -> HR claim -> reimbursed, and the report is correct", async () => {
    const pool = await freshDb();
    const clock = new FakeClock(START);
    const hr = new FakeHr();
    const chat = new FakeChat();
    let n = 0;
    const service = new RefillService({
      repo: new PostgresRefillRepository(pool),
      chat,
      hr,
      directory: new PostgresDirectory(pool),
      clock,
      offices: OFFICES,
      config: DEFAULT_CONFIG,
      idGenerator: () => `pg-${++n}`,
    });

    const { refill } = await service.reportEmpty("OSL", "emma");
    const owner = refill.assigneeId!;
    await service.accept(refill.id, owner);
    clock.advance(3 * HOUR);
    await service.recordPurchase(refill.id, owner, {
      amount: major(900, "NOK"),
      receiptImageRef: "r.jpg",
      items: [{ name: "Chips", quantity: 6 }],
    });
    hr.decide([...hr.claims.keys()][0]!, "APPROVED");
    await service.tick();

    expect((await service.getRefill(refill.id)).status).toBe("REIMBURSED");
    const report = buildMonthlyReport("2026-03", OFFICES, await service.listRefills(), new FakeFx());
    expect(report.total).toEqual(major(900, "NOK"));
  });

  it("two simultaneous accepts: exactly one wins on Postgres too", async () => {
    const pool = await freshDb();
    const service = new RefillService({
      repo: new PostgresRefillRepository(pool),
      chat: new FakeChat(),
      hr: new FakeHr(),
      directory: new PostgresDirectory(pool),
      clock: new FakeClock(START),
      offices: OFFICES,
      idGenerator: () => "pg-race",
    });
    const { refill } = await service.reportEmpty("OSL", "emma");
    const owner = refill.assigneeId!;
    const results = await Promise.allSettled([service.accept(refill.id, owner), service.accept(refill.id, owner)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

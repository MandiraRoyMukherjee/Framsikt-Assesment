import { describe, expect, it } from "vitest";
import { BudgetError, ConflictError, InvalidTransitionError } from "../src/domain/errors";
import { major } from "../src/domain/money";
import { emp, HOUR, setup } from "./helpers/setup";

const team = [emp("anna", "OSL"), emp("bjorn", "OSL"), emp("chloe", "OSL"), emp("ravi", "BLR"), emp("sita", "BLR")];

let receiptSeq = 0;
const purchase = (amount: number, currency: "NOK" | "INR" = "NOK") => ({
  amount: major(amount, currency),
  receiptImageRef: `receipt-${++receiptSeq}.jpg`, // every real receipt is a different image
  items: [{ name: "Chips", quantity: 6 }],
});

describe("refill lifecycle: empty -> reimbursed (happy path)", () => {
  it("walks OPEN -> OFFERED -> COMMITTED -> PURCHASED -> CLAIM_SUBMITTED -> REIMBURSED", async () => {
    const { service, chat, hr, clock } = setup(team);

    const { refill, created } = await service.reportEmpty("OSL", "bjorn");
    expect(created).toBe(true);
    expect(refill.status).toBe("OFFERED");
    const owner = refill.assigneeId!;
    expect(chat.toUser(owner, "OFFER")).toHaveLength(1);

    expect((await service.accept(refill.id, owner)).status).toBe("COMMITTED");

    clock.advance(3 * HOUR);
    const bought = await service.recordPurchase(refill.id, owner, purchase(800));
    expect(bought.status).toBe("CLAIM_SUBMITTED"); // claim filed automatically
    expect(hr.claims.size).toBe(1);
    const claim = [...hr.claims.values()][0]!;
    expect(claim).toMatchObject({ employeeId: owner, receiptImageRef: bought.purchase?.receipt.imageRef });
    expect(claim.amount).toEqual(major(800, "NOK"));

    // HR takes days to approve; until then nothing changes
    clock.advance(4 * 24 * HOUR);
    await service.tick();
    expect((await service.getRefill(refill.id)).status).toBe("CLAIM_SUBMITTED");

    hr.decide(claim.hrClaimId, "APPROVED");
    await service.tick();
    expect((await service.getRefill(refill.id)).status).toBe("REIMBURSED");
    expect(chat.toUser(owner, "CLAIM_APPROVED")).toHaveLength(1);
  });
});

describe("RULE: two people cannot both commit to the same refill", () => {
  it("a duplicate 'empty' report returns the same refill (no second refill, no second offer)", async () => {
    const { service, chat } = setup(team);
    const first = await service.reportEmpty("OSL", "anna");
    const second = await service.reportEmpty("OSL", "chloe");
    expect(second.created).toBe(false);
    expect(second.refill.id).toBe(first.refill.id);
    expect(chat.ofKind("OFFER")).toHaveLength(1);
  });

  it("two simultaneous accepts: exactly one wins, the other gets an error and no message", async () => {
    const { service, chat } = setup(team);
    const { refill } = await service.reportEmpty("OSL", "anna");
    const owner = refill.assigneeId!;

    // The same volunteer double-taps "accept" (or two app instances race): both run concurrently.
    const results = await Promise.allSettled([service.accept(refill.id, owner), service.accept(refill.id, owner)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect([ConflictError, InvalidTransitionError].some((E) => failed[0]!.reason instanceof E)).toBe(true);
    expect(chat.toUser(owner, "CONFIRMATION")).toHaveLength(1); // winner notified once
  });

  it("someone who was NOT offered the refill cannot accept it", async () => {
    const { service } = setup(team);
    const { refill } = await service.reportEmpty("OSL", "anna");
    const other = ["anna", "bjorn", "chloe"].find((id) => id !== refill.assigneeId)!;
    await expect(service.accept(refill.id, other)).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("once committed, nobody else can accept or buy", async () => {
    const { service } = setup(team);
    const { refill } = await service.reportEmpty("OSL", "anna");
    const owner = refill.assigneeId!;
    const other = ["anna", "bjorn", "chloe"].find((id) => id !== owner)!;
    await service.accept(refill.id, owner);
    await expect(service.accept(refill.id, other)).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(service.recordPurchase(refill.id, other, purchase(500))).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("the repository compare-and-set rejects a stale writer", async () => {
    const { service, repo } = setup(team);
    const { refill } = await service.reportEmpty("OSL", "anna");
    const a = (await repo.get(refill.id))!;
    const b = (await repo.get(refill.id))!;
    a.reportedBy = "A";
    await repo.save(a, a.version);
    b.reportedBy = "B";
    await expect(repo.save(b, b.version)).rejects.toBeInstanceOf(ConflictError);
  });

  it("the two offices are independent: one active refill each", async () => {
    const { service } = setup(team);
    const o = await service.reportEmpty("OSL", "anna");
    const b = await service.reportEmpty("BLR", "ravi");
    expect(o.created && b.created).toBe(true);
    expect(o.refill.id).not.toBe(b.refill.id);
  });
});

describe("RULE: a refill nobody completes is handed to someone else", () => {
  it("an unanswered offer times out after 2h and goes to the next volunteer", async () => {
    const { service, clock, chat } = setup(team);
    const { refill } = await service.reportEmpty("OSL", "anna");
    const first = refill.assigneeId!;

    clock.advance(2 * HOUR + 1);
    await service.tick();

    const after = await service.getRefill(refill.id);
    expect(after.status).toBe("OFFERED");
    expect(after.assigneeId).not.toBe(first);
    expect(after.attempts).toEqual([expect.objectContaining({ volunteerId: first, outcome: "timeout" })]);
    expect(chat.ofKind("OFFER")).toHaveLength(2);
    await expect(service.accept(refill.id, first)).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("a declined offer goes to the next volunteer immediately", async () => {
    const { service } = setup(team);
    const { refill } = await service.reportEmpty("OSL", "anna");
    const first = refill.assigneeId!;
    const after = await service.decline(refill.id, first);
    expect(after.assigneeId).not.toBe(first);
    expect(after.attempts[0]?.outcome).toBe("declined");
  });

  it("a committed volunteer who misses the 24h deadline loses the refill; late purchase is rejected", async () => {
    const { service, clock, chat } = setup(team);
    const { refill } = await service.reportEmpty("OSL", "anna");
    const first = refill.assigneeId!;
    await service.accept(refill.id, first);

    clock.advance(25 * HOUR);
    await service.tick();

    const after = await service.getRefill(refill.id);
    expect(after.assigneeId).not.toBe(first);
    expect(after.status).toBe("OFFERED");
    expect(after.attempts[0]).toMatchObject({ volunteerId: first, outcome: "missed_deadline" });
    expect(chat.toUser(first, "HANDOVER")).toHaveLength(1);
    await expect(service.recordPurchase(refill.id, first, purchase(500))).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("sends a reminder at 50% of the window, exactly once", async () => {
    const { service, clock, chat } = setup(team);
    const { refill } = await service.reportEmpty("OSL", "anna");
    const owner = refill.assigneeId!;
    await service.accept(refill.id, owner);

    clock.advance(11 * HOUR);
    await service.tick();
    expect(chat.toUser(owner, "REMINDER")).toHaveLength(0);

    clock.advance(1 * HOUR + 1);
    await service.tick();
    await service.tick();
    expect(chat.toUser(owner, "REMINDER")).toHaveLength(1);
  });

  it("a volunteer can release a commitment without it counting as a miss", async () => {
    const { service } = setup(team);
    const { refill } = await service.reportEmpty("OSL", "anna");
    const first = refill.assigneeId!;
    await service.accept(refill.id, first);
    const after = await service.release(refill.id, first);
    expect(after.assigneeId).not.toBe(first);
    expect(after.attempts[0]?.outcome).toBe("released");
  });

  it("never offers the same volunteer twice for one refill; when all tried, anyone present may self-take", async () => {
    const { service, clock, chat } = setup([emp("anna", "OSL"), emp("bjorn", "OSL")]);
    const { refill } = await service.reportEmpty("OSL", "anna");
    clock.advance(2 * HOUR + 1);
    await service.tick(); // second volunteer
    clock.advance(2 * HOUR + 1);
    await service.tick(); // nobody left

    const after = await service.getRefill(refill.id);
    expect(after.status).toBe("OPEN");
    expect(after.selfTakeOpen).toBe(true);
    expect(chat.messages.filter((m) => m.kind === "ANNOUNCE")).toHaveLength(1);

    // a volunteer who is physically present can take it
    const taken = await service.accept(refill.id, "bjorn");
    expect(taken.status).toBe("COMMITTED");
    expect(taken.assigneeId).toBe("bjorn");
  });

  it("escalates to the office manager after the maximum number of failed hand-overs, once", async () => {
    const { service, clock, chat } = setup([emp("a", "OSL"), emp("b", "OSL"), emp("c", "OSL"), emp("d", "OSL")]);
    await service.reportEmpty("OSL", "a");
    for (let i = 0; i < 3; i++) {
      clock.advance(2 * HOUR + 1);
      await service.tick();
    }
    await service.tick();
    expect(chat.toUser("mgr-osl", "ESCALATION")).toHaveLength(1);
  });

  it("escalates when the box has been empty for 48h", async () => {
    const { service, clock, chat } = setup([emp("a", "OSL")]);
    await service.reportEmpty("OSL", "a");
    clock.advance(49 * HOUR);
    await service.tick();
    expect(chat.toUser("mgr-osl", "ESCALATION")).toHaveLength(1);
  });

  it("tick is idempotent: running it again changes nothing", async () => {
    const { service, clock, chat, repo } = setup(team);
    await service.reportEmpty("OSL", "anna");
    clock.advance(2 * HOUR + 1);
    await service.tick();
    const snapshot = JSON.stringify(await repo.list());
    const messages = chat.messages.length;
    await service.tick();
    expect(JSON.stringify(await repo.list())).toBe(snapshot);
    expect(chat.messages.length).toBe(messages);
  });
});

describe("hybrid work, holidays and visitors", () => {
  it("nobody present -> channel is asked (self-take); someone arriving next day gets the offer on tick", async () => {
    const { service, directory, clock, chat } = setup([emp("anna", "OSL")]);
    directory.setPresence("anna", "2026-03-10", null).setPresence("anna", "2026-03-11", null);
    const { refill } = await service.reportEmpty("OSL", "anna");
    expect(refill.status).toBe("OPEN");
    expect(refill.selfTakeOpen).toBe(true);

    directory.setPresence("anna", "2026-03-11", "OSL");
    clock.advance(HOUR);
    await service.tick();
    expect((await service.getRefill(refill.id)).assigneeId).toBe("anna");
    expect(chat.toUser("anna", "OFFER")).toHaveLength(1);
  });

  it("an Oslo volunteer visiting Bengaluru can be asked to refill the Bengaluru box", async () => {
    const { service, directory } = setup([emp("anna", "OSL"), emp("ravi", "BLR")]);
    directory.setPresence("ravi", "2026-03-10", null).setPresence("ravi", "2026-03-11", null);
    directory.setPresence("anna", "2026-03-10", "BLR");
    const { refill } = await service.reportEmpty("BLR", "ravi");
    expect(refill.assigneeId).toBe("anna");
  });

  it("a volunteer not in the office is never picked, even with the best stats", async () => {
    const { service, directory } = setup([emp("anna", "OSL"), emp("bjorn", "OSL")]);
    directory.setPresence("anna", "2026-03-10", null).setPresence("anna", "2026-03-11", null);
    const { refill } = await service.reportEmpty("OSL", "anna");
    expect(refill.assigneeId).toBe("bjorn");
  });
});

describe("fairness: slow reimbursements are not piled on the same person", () => {
  it("someone with 2 unreimbursed claims is skipped for the next refill", async () => {
    const { service, hr } = setup([emp("anna", "OSL"), emp("bjorn", "OSL")]);
    // anna buys twice and HR has not paid yet
    for (let i = 0; i < 2; i++) {
      const { refill } = await service.reportEmpty("OSL", "bjorn");
      const owner = refill.assigneeId!;
      if (owner !== "anna") await service.decline(refill.id, owner); // route to anna
      await service.accept(refill.id, "anna");
      await service.recordPurchase(refill.id, "anna", purchase(400));
    }
    expect(hr.claims.size).toBe(2);
    const { refill } = await service.reportEmpty("OSL", "bjorn");
    expect(refill.assigneeId).toBe("bjorn");
  });
});

describe("RULE: budget", () => {
  it("blocks a new offer when the monthly budget is used up and tells the manager (once)", async () => {
    const { service, chat, directory } = setup([emp("anna", "OSL")]);
    // spend 5 900 of 6 000 NOK first
    const first = await service.reportEmpty("OSL", "anna");
    await service.accept(first.refill.id, "anna");
    await service.recordPurchase(first.refill.id, "anna", purchase(5900));
    expect(directory).toBeDefined();

    const second = await service.reportEmpty("OSL", "anna");
    expect(second.refill.status).toBe("OPEN");
    expect(second.refill.flags).toContain("BUDGET_BLOCKED");
    expect(chat.toUser("mgr-osl", "BUDGET_BLOCKED")).toHaveLength(1);
    await service.tick();
    expect(chat.toUser("mgr-osl", "BUDGET_BLOCKED")).toHaveLength(1);
    await expect(service.accept(second.refill.id, "anna")).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("a manager override lets the refill proceed past the budget; only the manager may do it", async () => {
    const { service } = setup([emp("anna", "OSL")]);
    const first = await service.reportEmpty("OSL", "anna");
    await service.accept(first.refill.id, "anna");
    await service.recordPurchase(first.refill.id, "anna", purchase(5900));
    const blocked = await service.reportEmpty("OSL", "anna");

    await expect(service.approveBudgetOverride(blocked.refill.id, "anna")).rejects.toBeInstanceOf(InvalidTransitionError);
    const after = await service.approveBudgetOverride(blocked.refill.id, "mgr-osl");
    expect(after.status).toBe("OFFERED");
    expect((await service.accept(after.id, "anna")).status).toBe("COMMITTED");
  });

  it("the budget is used up by purchases in the same month and is fresh in the next month", async () => {
    const { service, clock } = setup([emp("anna", "OSL")]);
    const first = await service.reportEmpty("OSL", "anna");
    await service.accept(first.refill.id, "anna");
    await service.recordPurchase(first.refill.id, "anna", purchase(5900));

    clock.set(new Date("2026-04-02T08:00:00Z"));
    const next = await service.reportEmpty("OSL", "anna");
    expect(next.refill.status).toBe("OFFERED"); // April budget untouched
  });

  it("a purchase that exceeds the monthly budget is REJECTED and nothing is recorded or claimed", async () => {
    const { service, hr } = setup([emp("anna", "OSL")]);
    const { refill } = await service.reportEmpty("OSL", "anna");
    await service.accept(refill.id, "anna");
    await expect(service.recordPurchase(refill.id, "anna", purchase(6500))).rejects.toBeInstanceOf(BudgetError);

    const after = await service.getRefill(refill.id);
    expect(after.status).toBe("COMMITTED"); // still owned, can retry with a valid amount
    expect(after.purchase).toBeUndefined();
    expect(hr.claims.size).toBe(0);
    // the exact boundary is allowed: the whole budget can be used
    const ok = await service.recordPurchase(refill.id, "anna", purchase(6000));
    expect(ok.status).toBe("CLAIM_SUBMITTED");
  });

  it("an over-budget purchase is accepted only after the manager approves an override, and is flagged", async () => {
    const { service } = setup([emp("anna", "OSL")]);
    const { refill } = await service.reportEmpty("OSL", "anna");
    await service.accept(refill.id, "anna");
    await expect(service.approveBudgetOverride(refill.id, "anna")).rejects.toBeInstanceOf(InvalidTransitionError);
    await service.approveBudgetOverride(refill.id, "mgr-osl");
    const done = await service.recordPurchase(refill.id, "anna", purchase(6500));
    expect(done.purchase?.amount).toEqual(major(6500, "NOK"));
    expect(done.flags).toEqual(expect.arrayContaining(["OVER_BUDGET", "OVER_RESERVATION", "UNUSUAL_AMOUNT", "BUDGET_OVERRIDE"]));
  });

  it("two refills competing for the remaining budget: the budget cannot be overspent", async () => {
    // Oslo and a 2nd office are independent, so compete within ONE office over time: after the first
    // purchase only 1 000 NOK remains; the next buyer's reservation shrinks to it and a larger bill is rejected.
    const { service } = setup([emp("anna", "OSL"), emp("bjorn", "OSL")]);
    const a = await service.reportEmpty("OSL", "anna");
    await service.accept(a.refill.id, a.refill.assigneeId!);
    await service.recordPurchase(a.refill.id, a.refill.assigneeId!, purchase(5000));

    const b = await service.reportEmpty("OSL", "anna");
    expect(b.refill.status).toBe("OFFERED");
    const second = b.refill.assigneeId!;
    const committed = await service.accept(b.refill.id, second);
    expect(committed.reservation).toEqual(major(1000, "NOK")); // capped to what is left
    await expect(service.recordPurchase(b.refill.id, second, purchase(1200))).rejects.toBeInstanceOf(BudgetError);
    const ok = await service.recordPurchase(b.refill.id, second, purchase(1000));
    expect(ok.status).toBe("CLAIM_SUBMITTED");
  });

  it("duplicate receipt: the same receipt cannot create a second refill purchase or a second HR claim", async () => {
    const { service, hr } = setup([emp("anna", "OSL")]);
    const a = await service.reportEmpty("OSL", "anna");
    await service.accept(a.refill.id, "anna");
    const input = purchase(500);
    await service.recordPurchase(a.refill.id, "anna", input);

    const b = await service.reportEmpty("OSL", "anna");
    await service.accept(b.refill.id, b.refill.assigneeId!);
    await expect(service.recordPurchase(b.refill.id, b.refill.assigneeId!, input)).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(hr.claims.size).toBe(1);

    // submitting the SAME refill's purchase again is also rejected (it is no longer COMMITTED)
    await expect(service.recordPurchase(a.refill.id, "anna", input)).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(hr.claims.size).toBe(1);
  });

  it("rejects a purchase in the wrong currency, zero amounts and missing receipts", async () => {
    const { service } = setup([emp("anna", "OSL")]);
    const { refill } = await service.reportEmpty("OSL", "anna");
    await service.accept(refill.id, "anna");
    await expect(service.recordPurchase(refill.id, "anna", purchase(500, "INR"))).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(service.recordPurchase(refill.id, "anna", purchase(0))).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(
      service.recordPurchase(refill.id, "anna", { ...purchase(500), receiptImageRef: "" }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("Bengaluru is budgeted in INR independently of Oslo's NOK", async () => {
    const { service } = setup(team);
    const o = await service.reportEmpty("OSL", "anna");
    await service.accept(o.refill.id, o.refill.assigneeId!);
    await service.recordPurchase(o.refill.id, o.refill.assigneeId!, purchase(5900));

    // Oslo is nearly exhausted, Bengaluru is untouched and can proceed
    const b = await service.reportEmpty("BLR", "ravi");
    expect(b.refill.status).toBe("OFFERED");
    const buyer = b.refill.assigneeId!;
    await service.accept(b.refill.id, buyer);
    const done = await service.recordPurchase(b.refill.id, buyer, purchase(2800, "INR"));
    expect(done.flags).toEqual([]);
  });

  it("accept fails with BudgetError if the budget was used up between offer and accept", async () => {
    const { service, repo } = setup([emp("anna", "OSL"), emp("bjorn", "OSL")]);
    const { refill } = await service.reportEmpty("OSL", "anna");
    const owner = refill.assigneeId!;
    // Simulate another refill in the same month eating the budget before the volunteer answers.
    await repo.insert({
      id: "other",
      officeId: "OSL",
      status: "REIMBURSED",
      version: 1,
      reportedBy: "x",
      createdAt: new Date("2026-03-01T00:00:00Z"),
      selfTakeOpen: false,
      attempts: [],
      flags: [],
      purchase: { buyerId: "bjorn", amount: major(5900, "NOK"), receipt: { imageRef: "r" }, items: [], purchasedAt: new Date("2026-03-05T00:00:00Z") },
    });
    await expect(service.accept(refill.id, owner)).rejects.toBeInstanceOf(BudgetError);
  });
});

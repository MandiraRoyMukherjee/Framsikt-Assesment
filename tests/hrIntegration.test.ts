import { describe, expect, it } from "vitest";
import { major } from "../src/domain/money";
import { emp, HOUR, setup } from "./helpers/setup";

const DAY = 24 * HOUR;
const input = { amount: major(900, "NOK"), receiptImageRef: "r.jpg", items: [{ name: "Nuts", quantity: 4 }] };

async function purchased(ctx: ReturnType<typeof setup>) {
  const { refill } = await ctx.service.reportEmpty("OSL", "anna");
  const owner = refill.assigneeId!;
  await ctx.service.accept(refill.id, owner);
  const done = await ctx.service.recordPurchase(refill.id, owner, input);
  return { id: refill.id, owner, done };
}

describe("HR system integration (external, slow, can be down)", () => {
  it("if HR is down at purchase time the refill stays PURCHASED and tick() retries until it works", async () => {
    const ctx = setup([emp("anna", "OSL")]);
    ctx.hr.failNext = 2;
    const { id, done } = await purchased(ctx);
    expect(done.status).toBe("PURCHASED");
    expect(done.claim).toBeUndefined();

    await ctx.service.tick(); // 2nd failure
    expect((await ctx.service.getRefill(id)).status).toBe("PURCHASED");
    await ctx.service.tick(); // succeeds
    const after = await ctx.service.getRefill(id);
    expect(after.status).toBe("CLAIM_SUBMITTED");
    expect(ctx.hr.claims.size).toBe(1);
  });

  it("never creates a second claim once one exists, however often tick runs", async () => {
    const ctx = setup([emp("anna", "OSL")]);
    await purchased(ctx);
    const calls = ctx.hr.createCalls;
    for (let i = 0; i < 5; i++) await ctx.service.tick();
    expect(ctx.hr.createCalls).toBe(calls);
    expect(ctx.hr.claims.size).toBe(1);
  });

  it("claim carries amount, currency, description, receipt and the BUYER's employee id", async () => {
    const ctx = setup([emp("anna", "OSL")]);
    const { owner } = await purchased(ctx);
    const c = [...ctx.hr.claims.values()][0]!;
    expect(c.amount).toEqual(major(900, "NOK"));
    expect(c.employeeId).toBe(owner);
    expect(c.receiptImageRef).toBe("r.jpg");
    expect(c.description).toContain("Oslo");
    expect(c.description).toContain("4x Nuts");
  });

  it("a claim pending > 10 days chases the manager, at most once per day", async () => {
    const ctx = setup([emp("anna", "OSL")]);
    await purchased(ctx);
    ctx.clock.advance(9 * DAY);
    await ctx.service.tick();
    expect(ctx.chat.toUser("mgr-osl", "CLAIM_SLOW")).toHaveLength(0);

    ctx.clock.advance(2 * DAY);
    await ctx.service.tick();
    await ctx.service.tick();
    expect(ctx.chat.toUser("mgr-osl", "CLAIM_SLOW")).toHaveLength(1);

    ctx.clock.advance(DAY + 1);
    await ctx.service.tick();
    expect(ctx.chat.toUser("mgr-osl", "CLAIM_SLOW")).toHaveLength(2);
  });

  it("a rejected claim alerts manager and buyer, and its amount no longer counts as spend", async () => {
    const ctx = setup([emp("anna", "OSL")]);
    const { id, owner } = await purchased(ctx);
    ctx.hr.decide([...ctx.hr.claims.keys()][0]!, "REJECTED");
    await ctx.service.tick();

    expect((await ctx.service.getRefill(id)).status).toBe("CLAIM_REJECTED");
    expect(ctx.chat.toUser("mgr-osl", "CLAIM_REJECTED")).toHaveLength(1);
    expect(ctx.chat.toUser(owner, "CLAIM_REJECTED")).toHaveLength(1);

    // Budget is available again so the box can be refilled
    const next = await ctx.service.reportEmpty("OSL", "anna");
    expect(next.refill.status).toBe("OFFERED");
  });

  it("reimbursed refills are terminal: later ticks do nothing", async () => {
    const ctx = setup([emp("anna", "OSL")]);
    const { id } = await purchased(ctx);
    ctx.hr.decide([...ctx.hr.claims.keys()][0]!, "APPROVED");
    await ctx.service.tick();
    const count = ctx.chat.messages.length;
    await ctx.service.tick();
    expect(ctx.chat.messages.length).toBe(count);
    expect((await ctx.service.getRefill(id)).status).toBe("REIMBURSED");
  });
});

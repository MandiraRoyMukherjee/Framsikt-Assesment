import { describe, expect, it } from "vitest";
import { Sandbox } from "../src/demo/sandbox";
import { major } from "../src/domain/money";
import { emp, setup } from "./helpers/setup";

describe("checklist items stated literally", () => {
  it("a refill is created OPEN; it stays OPEN when nobody can take it yet", async () => {
    const { service, directory } = setup([emp("anna", "OSL")]);
    directory.setPresence("anna", "2026-03-10", null).setPresence("anna", "2026-03-11", null);
    const { refill, created } = await service.reportEmpty("OSL", "anna");
    expect(created).toBe(true);
    expect(refill.status).toBe("OPEN");
    expect(refill.attempts).toEqual([]);
  });

  it("when a volunteer is available the refill is created OPEN and immediately moves to OFFERED", async () => {
    const { service, repo } = setup([emp("anna", "OSL")]);
    const { refill } = await service.reportEmpty("OSL", "anna");
    expect(refill.status).toBe("OFFERED");
    expect((await repo.list())).toHaveLength(1);
  });

  it("HR claim submitted -> claim status is PENDING; HR approval -> REIMBURSED with claim APPROVED", async () => {
    const { service, hr } = setup([emp("anna", "OSL")]);
    const { refill } = await service.reportEmpty("OSL", "anna");
    await service.accept(refill.id, "anna");
    const bought = await service.recordPurchase(refill.id, "anna", {
      amount: major(700, "NOK"),
      receiptImageRef: "r-1.jpg",
      items: [],
    });
    expect(bought.claim?.status).toBe("PENDING");
    hr.decide(bought.claim!.hrClaimId, "APPROVED");
    await service.tick();
    const done = await service.getRefill(refill.id);
    expect(done.status).toBe("REIMBURSED");
    expect(done.claim?.status).toBe("APPROVED");
  });
});

describe("Sandbox (what the interactive page drives)", () => {
  it("runs the whole flow by 'clicking': report -> accept -> receipt -> HR approves", async () => {
    const sb = new Sandbox();
    await sb.reportEmpty("OSL", "dag");
    let v = await sb.view();
    const oslo = v.offices.find((o) => o.office.id === "OSL")!;
    expect(oslo.active?.status).toBe("OFFERED");
    const who = oslo.active!.assigneeId!;
    const id = oslo.active!.id;

    await sb.accept(id, who);
    await sb.purchase(id, who, 800);
    v = await sb.view();
    expect(v.hrClaims).toHaveLength(1);
    await sb.hrDecide(v.hrClaims[0]!.hrClaimId, "APPROVED");
    v = await sb.view();
    expect(v.offices.find((o) => o.office.id === "OSL")!.history[0]?.status).toBe("REIMBURSED");
    expect(v.report.offices.find((o) => o.officeId === "OSL")!.spent).toEqual(major(800, "NOK"));
  });

  it("a second 'empty' report and a double-tap accept are visibly rejected by the rules", async () => {
    const sb = new Sandbox();
    await sb.reportEmpty("BLR", "ravi");
    await sb.reportEmpty("BLR", "sita");
    let v = await sb.view();
    expect(v.timeline.some((t) => t.text.includes("duplicate report was ignored"))).toBe(true);

    const a = v.offices.find((o) => o.office.id === "BLR")!.active!;
    await sb.raceAccept(a.id, a.assigneeId!);
    v = await sb.view();
    expect(v.timeline.some((t) => t.text.includes("1 of 2 succeeded"))).toBe(true);
  });

  it("an over-budget receipt is blocked in the timeline, and the box stays COMMITTED", async () => {
    const sb = new Sandbox();
    await sb.reportEmpty("OSL", "anna");
    let v = await sb.view();
    const a = v.offices.find((o) => o.office.id === "OSL")!.active!;
    await sb.accept(a.id, a.assigneeId!);
    await sb.purchase(a.id, a.assigneeId!, 6500);
    v = await sb.view();
    expect(v.timeline.some((t) => t.kind === "BLOCKED" && t.text.includes("BudgetError"))).toBe(true);
    expect(v.offices.find((o) => o.office.id === "OSL")!.active?.status).toBe("COMMITTED");
  });

  it("time passing hands an ignored offer to the next volunteer; holiday removes someone from the ranking", async () => {
    const sb = new Sandbox();
    await sb.setLocation("anna", "holiday");
    await sb.reportEmpty("OSL", "bjorn");
    let v = await sb.view();
    expect(v.offices[0]!.ranking.some((c) => c.id === "anna")).toBe(false);
    const first = v.offices[0]!.active!.assigneeId;
    expect(first).not.toBe("anna");

    await sb.advance(3);
    v = await sb.view();
    expect(v.offices[0]!.active!.assigneeId).not.toBe(first);
    expect(v.offices[0]!.active!.attempts[0]?.outcome).toBe("timeout");
  });

  it("HR down: receipt is kept as PURCHASED, back up + tick files the claim", async () => {
    const sb = new Sandbox();
    sb.setHrDown(true);
    await sb.reportEmpty("OSL", "anna");
    let v = await sb.view();
    const a = v.offices[0]!.active!;
    await sb.accept(a.id, a.assigneeId!);
    await sb.purchase(a.id, a.assigneeId!, 500);
    v = await sb.view();
    expect(v.offices[0]!.history[0]?.status).toBe("PURCHASED");
    sb.setHrDown(false);
    await sb.tick();
    v = await sb.view();
    expect(v.offices[0]!.history[0]?.status).toBe("CLAIM_SUBMITTED");
  });

  it("the budget shortcut blocks the next refill and the manager override unblocks it", async () => {
    const sb = new Sandbox();
    await sb.spendBudget("OSL", 5900);
    await sb.reportEmpty("OSL", "anna");
    let v = await sb.view();
    const blocked = v.offices[0]!.active!;
    expect(blocked.flags).toContain("BUDGET_BLOCKED");
    await sb.approveOverride(blocked.id, "mgr-osl");
    v = await sb.view();
    expect(v.offices[0]!.active!.status).toBe("OFFERED");
  });
});

/**
 * RefillService - the refill lifecycle. The ONLY place that changes refill state.
 *
 * Concurrency rules (why "two people cannot both commit"):
 *  1. One active refill per office  -> repository.insert() rejects a second one.
 *  2. Every transition is  load -> check -> mutate -> save(expectedVersion)  (compare-and-set).
 *     If two accepts race, exactly one save succeeds; the loser gets ConflictError and NO message is sent
 *     (messages are sent only AFTER a successful save).
 *
 * Time never comes from the system clock directly: everything uses the injected Clock,
 * so the "nobody completes it -> hand over" rules are tested by advancing a fake clock.
 */
import { DEFAULT_CONFIG, type Config } from "../domain/config";
import {
  ActiveRefillExistsError,
  BudgetError,
  ConflictError,
  InvalidTransitionError,
  NotFoundError,
} from "../domain/errors";
import { format, gt, lt, money, type Money } from "../domain/money";
import { localDay, monthKey } from "../domain/time";
import type {
  AttemptOutcome,
  EmployeeId,
  Office,
  OfficeId,
  PurchaseItem,
  Refill,
} from "../domain/types";
import type { ChatPort, Clock, DirectoryPort, HrPort, RefillRepository } from "../ports";
import type { ReceiptReader } from "../ports/llm";
import { canStartRefill, reservationFor, summarize } from "./budget";
import { buildCandidates, rankCandidates } from "./volunteerSelector";

export interface Deps {
  repo: RefillRepository;
  chat: ChatPort;
  hr: HrPort;
  directory: DirectoryPort;
  clock: Clock;
  offices: Office[];
  config?: Config;
  idGenerator?: () => string;
  /** Optional. When present, the receipt is cross-checked; a mismatch only adds a flag (never blocks). */
  receiptReader?: ReceiptReader;
}

export interface PurchaseInput {
  amount: Money;
  receiptImageRef: string;
  items: PurchaseItem[];
}

export class RefillService {
  private readonly config: Config;
  private readonly offices: Map<OfficeId, Office>;
  private readonly newId: () => string;

  constructor(private readonly deps: Deps) {
    this.config = deps.config ?? DEFAULT_CONFIG;
    this.offices = new Map(deps.offices.map((o) => [o.id, o]));
    this.newId = deps.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  // ------------------------------------------------------------------ queries

  async getRefill(id: string): Promise<Refill> {
    const r = await this.deps.repo.get(id);
    if (!r) throw new NotFoundError(`Refill ${id} not found`);
    return r;
  }

  async listRefills(): Promise<Refill[]> {
    return this.deps.repo.list();
  }

  // ------------------------------------------------------------ 1. report empty

  /**
   * Anyone can report an empty box. Idempotent: if the office already has an active refill the
   * existing one is returned (created=false) - this is what stops "everyone reports, two people buy".
   */
  async reportEmpty(officeId: OfficeId, reportedBy: EmployeeId): Promise<{ refill: Refill; created: boolean }> {
    const office = this.office(officeId);
    const existing = await this.deps.repo.findActiveByOffice(officeId);
    if (existing) return { refill: existing, created: false };

    const refill: Refill = {
      id: this.newId(),
      officeId,
      status: "OPEN",
      version: 1,
      reportedBy,
      createdAt: this.deps.clock.now(),
      selfTakeOpen: false,
      attempts: [],
      flags: [],
    };
    try {
      await this.deps.repo.insert(refill);
    } catch (e) {
      if (e instanceof ActiveRefillExistsError) {
        // Lost a simultaneous-report race: hand back the winner's refill.
        const winner = await this.deps.repo.findActiveByOffice(officeId);
        if (winner) return { refill: winner, created: false };
      }
      throw e;
    }
    await this.assign(refill, office);
    return { refill, created: true };
  }

  // ---------------------------------------------------------- 2. accept / decline

  /**
   * Volunteer says yes. Works for the volunteer we offered to, or - when nobody could be
   * auto-selected (selfTakeOpen) - for any eligible volunteer who is physically in the office.
   */
  async accept(refillId: string, volunteerId: EmployeeId): Promise<Refill> {
    const refill = await this.getRefill(refillId);
    const office = this.office(refill.officeId);
    const now = this.deps.clock.now();

    if (refill.status === "OFFERED") {
      if (refill.assigneeId !== volunteerId) {
        throw new InvalidTransitionError(`Refill ${refillId} is offered to someone else`);
      }
      if (refill.offerExpiresAt && now >= refill.offerExpiresAt) {
        throw new InvalidTransitionError("The offer has expired");
      }
    } else if (refill.status === "OPEN" && refill.selfTakeOpen) {
      const eligible = await buildCandidates(office, now, this.deps.directory, await this.deps.repo.list(), this.config);
      if (!eligible.some((c) => c.id === volunteerId)) {
        throw new InvalidTransitionError(`${volunteerId} is not an eligible volunteer in ${office.name} right now`);
      }
    } else {
      throw new InvalidTransitionError(`Refill ${refillId} cannot be accepted in status ${refill.status}`);
    }

    // Budget is checked again at commit time: it may have changed since the offer was made.
    const summary = summarize(office, monthKey(now, office.timezone), await this.deps.repo.list());
    if (!canStartRefill(office, summary) && !refill.flags.includes("BUDGET_OVERRIDE")) {
      throw new BudgetError(`Monthly budget for ${office.name} is used up`);
    }

    refill.status = "COMMITTED";
    refill.assigneeId = volunteerId;
    refill.selfTakeOpen = false;
    refill.offerExpiresAt = undefined;
    refill.committedAt = now;
    refill.commitDeadline = new Date(now.getTime() + this.config.commitTtlMs);
    refill.reminderSentAt = undefined;
    refill.reservation = reservationFor(office, summary);
    await this.persist(refill); // <- compare-and-set: the loser of a race throws ConflictError here

    await this.deps.chat.send({
      to: { userId: volunteerId },
      kind: "CONFIRMATION",
      refillId,
      text: `Thanks! You own the ${office.name} refill. Buy up to ${format(refill.reservation)} and upload the receipt within 24h.`,
    });
    await this.deps.chat.send({
      to: { channelOfOffice: office.id },
      kind: "ANNOUNCE",
      refillId,
      text: `${volunteerId} is refilling the ${office.name} snack box - no need to buy!`,
    });
    return refill;
  }

  async decline(refillId: string, volunteerId: EmployeeId): Promise<Refill> {
    const refill = await this.getRefill(refillId);
    if (refill.status !== "OFFERED" || refill.assigneeId !== volunteerId) {
      throw new InvalidTransitionError(`${volunteerId} has no open offer for refill ${refillId}`);
    }
    this.closeAssignment(refill, "declined");
    await this.assign(refill, this.office(refill.officeId));
    return refill;
  }

  /** A committed volunteer gives the job back (sick, plans changed). Not counted as a miss. */
  async release(refillId: string, volunteerId: EmployeeId): Promise<Refill> {
    const refill = await this.getRefill(refillId);
    if (refill.status !== "COMMITTED" || refill.assigneeId !== volunteerId) {
      throw new InvalidTransitionError(`${volunteerId} has not committed to refill ${refillId}`);
    }
    this.closeAssignment(refill, "released");
    await this.assign(refill, this.office(refill.officeId));
    return refill;
  }

  // ------------------------------------------------------------- 3. purchase

  /** Volunteer uploads the receipt. Records spend and files the HR claim automatically. */
  async recordPurchase(refillId: string, volunteerId: EmployeeId, input: PurchaseInput): Promise<Refill> {
    const refill = await this.getRefill(refillId);
    const office = this.office(refill.officeId);

    if (refill.status !== "COMMITTED" || refill.assigneeId !== volunteerId) {
      // e.g. the refill was handed to someone else after a missed deadline
      throw new InvalidTransitionError(`${volunteerId} is not the current owner of refill ${refillId}`);
    }
    if (input.amount.currency !== office.currency) {
      throw new InvalidTransitionError(`Purchase must be in ${office.currency}, got ${input.amount.currency}`);
    }
    if (input.amount.minor <= 0) throw new InvalidTransitionError("Purchase amount must be positive");
    if (!input.receiptImageRef) throw new InvalidTransitionError("A receipt image is required");

    const all = await this.deps.repo.list();
    // Duplicate receipt: the same receipt can never back two refills (so never two HR claims).
    if (all.some((r) => r.id !== refill.id && r.purchase?.receipt.imageRef === input.receiptImageRef)) {
      throw new InvalidTransitionError("This receipt was already submitted for another refill");
    }

    const now = this.deps.clock.now();
    const before = summarize(office, monthKey(now, office.timezone), all);
    // "before" includes this refill's own reservation; add it back to see the budget without it.
    const availableWithoutOwn = refill.reservation
      ? money(before.available.minor + refill.reservation.minor, office.currency)
      : before.available;

    // Budget cannot be overspent: a purchase above what is left this month is REJECTED, unless the
    // office manager has explicitly approved an override for this refill (then it is recorded + flagged).
    const overBudget = gt(input.amount, availableWithoutOwn);
    if (overBudget && !refill.flags.includes("BUDGET_OVERRIDE")) {
      throw new BudgetError(
        `${format(input.amount)} exceeds the ${format(availableWithoutOwn)} left in the ${office.name} monthly budget. Ask the manager to approve an override.`,
      );
    }

    const flags = new Set(refill.flags);
    if (refill.reservation && gt(input.amount, refill.reservation)) flags.add("OVER_RESERVATION");
    if (lt(input.amount, office.typicalMin) || gt(input.amount, office.typicalMax)) flags.add("UNUSUAL_AMOUNT");
    if (overBudget) flags.add("OVER_BUDGET");
    if (await this.receiptDisagrees(input)) flags.add("RECEIPT_MISMATCH");
    refill.flags = [...flags];

    refill.purchase = {
      buyerId: volunteerId,
      amount: input.amount,
      receipt: { imageRef: input.receiptImageRef },
      items: input.items,
      purchasedAt: now,
    };
    refill.status = "PURCHASED";
    refill.reservation = undefined;
    refill.commitDeadline = undefined;
    refill.reminderSentAt = undefined;
    await this.persist(refill);

    await this.submitClaim(refill);
    return refill;
  }

  /**
   * Optional LLM cross-check of the receipt. ASSISTS a human, never decides:
   *  - any reader error, unreadable receipt, or low confidence -> "no opinion" (false)
   *  - only a confident reading in the SAME currency that differs by more than 1% raises a flag
   */
  private async receiptDisagrees(input: PurchaseInput): Promise<boolean> {
    const reader = this.deps.receiptReader;
    if (!reader) return false;
    try {
      const r = await reader.read(input.receiptImageRef);
      if (r.totalMinor === null || r.currency !== input.amount.currency || r.confidence < 0.7) return false;
      return Math.abs(r.totalMinor - input.amount.minor) > input.amount.minor * 0.01;
    } catch {
      return false;
    }
  }


  /** Files the HR claim. Safe to call repeatedly: it does nothing once a claim exists. */
  private async submitClaim(refill: Refill): Promise<void> {
    if (refill.claim || !refill.purchase) return;
    const office = this.office(refill.officeId);
    const p = refill.purchase;
    try {
      const { hrClaimId } = await this.deps.hr.createClaim({
        idempotencyKey: refill.id,
        amount: p.amount,
        description: `Snack counter refill - ${office.name} - ${p.items.map((i) => `${i.quantity}x ${i.name}`).join(", ") || "snacks"}`,
        receiptImageRef: p.receipt.imageRef,
        employeeId: p.buyerId,
      });
      refill.claim = { hrClaimId, status: "PENDING", submittedAt: this.deps.clock.now() };
      refill.status = "CLAIM_SUBMITTED";
      await this.persist(refill);
    } catch (e) {
      if (e instanceof ConflictError) throw e;
      // HR is another company's system and can be down. The refill stays PURCHASED and tick() retries.
    }
  }

  // ----------------------------------------------------------- manager action

  /** Manager lets a refill proceed even though the monthly budget is used up. */
  async approveBudgetOverride(refillId: string, managerId: EmployeeId): Promise<Refill> {
    const refill = await this.getRefill(refillId);
    const office = this.office(refill.officeId);
    if (managerId !== office.managerId) throw new InvalidTransitionError(`${managerId} is not the manager of ${office.name}`);
    if (refill.status !== "OPEN" && refill.status !== "COMMITTED") {
      throw new InvalidTransitionError("Only an OPEN or COMMITTED refill can be overridden");
    }
    if (!refill.flags.includes("BUDGET_OVERRIDE")) refill.flags.push("BUDGET_OVERRIDE");
    // OPEN: let the refill proceed past a used-up budget. COMMITTED: allow the over-budget purchase.
    if (refill.status === "OPEN") await this.assign(refill, office);
    else await this.persist(refill);
    return refill;
  }

  // ------------------------------------------------------------------- tick

  /**
   * The scheduler entry point (cron / Vercel cron / setInterval). IDEMPOTENT: running it twice
   * in a row does nothing the second time, so overlapping or retried runs are harmless.
   * Handles every "nobody did anything" situation: timeouts, hand-overs, reminders,
   * escalation, retrying HR, polling HR.
   */
  async tick(): Promise<void> {
    for (const snapshot of await this.deps.repo.list()) {
      try {
        await this.tickOne(snapshot.id);
      } catch (e) {
        // Lost a race with a user action - the next tick re-evaluates from fresh state.
        if (!(e instanceof ConflictError)) throw e;
      }
    }
  }

  private async tickOne(id: string): Promise<void> {
    const refill = await this.getRefill(id);
    const office = this.office(refill.officeId);
    const now = this.deps.clock.now();

    switch (refill.status) {
      case "OPEN":
        await this.assign(refill, office); // retries budget block / waits for presence
        break;
      case "OFFERED":
        if (refill.offerExpiresAt && now >= refill.offerExpiresAt) {
          this.closeAssignment(refill, "timeout");
          await this.assign(refill, office);
        }
        break;
      case "COMMITTED":
        await this.tickCommitted(refill, office, now);
        break;
      case "PURCHASED":
        await this.submitClaim(refill); // HR was down earlier
        break;
      case "CLAIM_SUBMITTED":
        await this.pollClaim(refill, office, now);
        return;
      default:
        return; // terminal
    }

    await this.escalateIfNeeded(await this.getRefill(id), office, now);
  }

  private async tickCommitted(refill: Refill, office: Office, now: Date): Promise<void> {
    if (refill.commitDeadline && now >= refill.commitDeadline) {
      const previous = refill.assigneeId;
      this.closeAssignment(refill, "missed_deadline");
      if (previous) {
        await this.deps.chat.send({
          to: { userId: previous },
          kind: "HANDOVER",
          refillId: refill.id,
          text: `The ${office.name} refill was handed to someone else because the 24h window passed. Please do not buy it.`,
        });
      }
      await this.assign(refill, office);
      return;
    }
    const reminderAt = (refill.committedAt?.getTime() ?? 0) + this.config.commitTtlMs * this.config.reminderFraction;
    if (!refill.reminderSentAt && refill.assigneeId && now.getTime() >= reminderAt) {
      refill.reminderSentAt = now;
      await this.persist(refill);
      await this.deps.chat.send({
        to: { userId: refill.assigneeId },
        kind: "REMINDER",
        refillId: refill.id,
        text: `Still on the ${office.name} refill? Upload the receipt, or release it so someone else can take over.`,
      });
    }
  }

  private async pollClaim(refill: Refill, office: Office, now: Date): Promise<void> {
    if (!refill.claim) return;
    let status;
    try {
      status = (await this.deps.hr.getClaim(refill.claim.hrClaimId)).status;
    } catch {
      return; // HR unreachable - try again next tick
    }
    const buyer = refill.purchase?.buyerId;

    if (status === "APPROVED") {
      refill.status = "REIMBURSED";
      refill.claim.status = "APPROVED";
      refill.claim.decidedAt = now;
      await this.persist(refill);
      if (buyer) {
        await this.deps.chat.send({
          to: { userId: buyer },
          kind: "CLAIM_APPROVED",
          refillId: refill.id,
          text: `HR approved your snack claim - the money is on its way. Thank you!`,
        });
      }
    } else if (status === "REJECTED") {
      refill.status = "CLAIM_REJECTED";
      refill.claim.status = "REJECTED";
      refill.claim.decidedAt = now;
      await this.persist(refill);
      const text = `HR rejected the snack claim for refill ${refill.id}. Needs a human follow-up.`;
      await this.deps.chat.send({ to: { userId: office.managerId }, kind: "CLAIM_REJECTED", refillId: refill.id, text });
      if (buyer) await this.deps.chat.send({ to: { userId: buyer }, kind: "CLAIM_REJECTED", refillId: refill.id, text });
    } else {
      const slow = now.getTime() - refill.claim.submittedAt.getTime() >= this.config.claimSlowMs;
      const lastChase = refill.claim.lastChasedAt?.getTime() ?? 0;
      if (slow && now.getTime() - lastChase >= this.config.chaseIntervalMs) {
        refill.claim.lastChasedAt = now;
        await this.persist(refill);
        await this.deps.chat.send({
          to: { userId: office.managerId },
          kind: "CLAIM_SLOW",
          refillId: refill.id,
          text: `HR claim ${refill.claim.hrClaimId} has been pending for more than 10 days. Please chase HR.`,
        });
      }
    }
  }

  private async escalateIfNeeded(refill: Refill, office: Office, now: Date): Promise<void> {
    if (!["OPEN", "OFFERED", "COMMITTED"].includes(refill.status) || refill.escalatedAt) return;
    const tooMany = refill.attempts.length >= this.config.maxAttempts;
    const tooOld = now.getTime() - refill.createdAt.getTime() >= this.config.escalateAfterMs;
    if (!tooMany && !tooOld) return;

    refill.escalatedAt = now;
    await this.persist(refill);
    await this.deps.chat.send({
      to: { userId: office.managerId },
      kind: "ESCALATION",
      refillId: refill.id,
      text: `The ${office.name} snack box is still not refilled (${refill.attempts.length} hand-overs, ${Math.round((now.getTime() - refill.createdAt.getTime()) / 3_600_000)}h open). Human help needed.`,
    });
  }

  // ----------------------------------------------------------------- helpers

  private office(id: OfficeId): Office {
    const o = this.offices.get(id);
    if (!o) throw new NotFoundError(`Unknown office ${id}`);
    return o;
  }

  private async persist(refill: Refill): Promise<void> {
    await this.deps.repo.save(refill, refill.version);
  }

  /** Record how the current assignee's turn ended and clear the assignment fields (in memory only). */
  private closeAssignment(refill: Refill, outcome: AttemptOutcome): void {
    if (refill.assigneeId) {
      refill.attempts.push({ volunteerId: refill.assigneeId, outcome, at: this.deps.clock.now() });
    }
    refill.status = "OPEN";
    refill.assigneeId = undefined;
    refill.offerExpiresAt = undefined;
    refill.committedAt = undefined;
    refill.commitDeadline = undefined;
    refill.reminderSentAt = undefined;
    refill.reservation = undefined;
  }

  /**
   * Find the next owner for an OPEN refill: budget gate -> rank present volunteers -> offer to the best.
   * Persists the result. If nobody qualifies, opens the refill for self-take and tells the channel.
   */
  private async assign(refill: Refill, office: Office): Promise<void> {
    const now = this.deps.clock.now();
    const all = await this.deps.repo.list();
    const summary = summarize(office, monthKey(now, office.timezone), all);
    const overridden = refill.flags.includes("BUDGET_OVERRIDE");

    if (!canStartRefill(office, summary) && !overridden) {
      if (!refill.flags.includes("BUDGET_BLOCKED")) {
        refill.flags.push("BUDGET_BLOCKED");
        await this.persist(refill);
        await this.deps.chat.send({
          to: { userId: office.managerId },
          kind: "BUDGET_BLOCKED",
          refillId: refill.id,
          text: `The ${office.name} snack box is empty but only ${format(summary.available)} of the monthly budget is left. Approve an override to refill.`,
        });
      }
      return;
    }
    refill.flags = refill.flags.filter((f) => f !== "BUDGET_BLOCKED");

    const tried = new Set(refill.attempts.map((a) => a.volunteerId));
    const candidates = await buildCandidates(office, now, this.deps.directory, all, this.config);
    const [best] = rankCandidates(candidates, tried, this.config);

    if (!best) {
      const firstTime = !refill.selfTakeOpen;
      refill.selfTakeOpen = true;
      if (firstTime) {
        await this.persist(refill);
        await this.deps.chat.send({
          to: { channelOfOffice: office.id },
          kind: "ANNOUNCE",
          refillId: refill.id,
          text: `The ${office.name} snack box is empty and nobody could be picked automatically. Any volunteer in the office: please accept refill ${refill.id}.`,
        });
      }
      return;
    }

    refill.status = "OFFERED";
    refill.assigneeId = best.id;
    refill.selfTakeOpen = false;
    refill.offerExpiresAt = new Date(now.getTime() + this.config.offerTtlMs);
    await this.persist(refill);
    await this.deps.chat.send({
      to: { userId: best.id },
      kind: "OFFER",
      refillId: refill.id,
      text: `The ${office.name} snack box is empty. Can you refill it today (${localDay(now, office.timezone)})? Reply within 2h - accept or decline. You will be reimbursed via HR.`,
    });
  }
}

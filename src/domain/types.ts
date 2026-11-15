import type { Currency, Money } from "./money";

export type OfficeId = string;
export type EmployeeId = string;

export interface Office {
  id: OfficeId;
  name: string;
  currency: Currency;
  monthlyBudget: Money;
  /** Typical purchase range - used for reservation size and "unusual amount" flags. */
  typicalMin: Money;
  typicalMax: Money;
  /** IANA timezone: defines "today" and which month a purchase belongs to. */
  timezone: string;
  managerId: EmployeeId;
}

export interface Employee {
  id: EmployeeId;
  name: string;
  homeOfficeId: OfficeId;
  /** HR reimburses in this currency (we never convert for the employee). */
  payrollCurrency: Currency;
  isVolunteer: boolean;
}

export type RefillStatus =
  | "OPEN"
  | "OFFERED"
  | "COMMITTED"
  | "PURCHASED"
  | "CLAIM_SUBMITTED"
  | "REIMBURSED"
  | "CLAIM_REJECTED"
  | "CANCELLED";

/** Statuses where the refill is still "in flight" - at most one per office. */
export const ACTIVE_STATUSES: readonly RefillStatus[] = ["OPEN", "OFFERED", "COMMITTED"];

export type AttemptOutcome = "declined" | "timeout" | "missed_deadline" | "released";

export interface RefillAttempt {
  volunteerId: EmployeeId;
  outcome: AttemptOutcome;
  at: Date;
}

export interface PurchaseItem {
  name: string;
  quantity: number;
}

export interface Receipt {
  /** Reference/URL of the uploaded receipt image. */
  imageRef: string;
}

export interface Purchase {
  buyerId: EmployeeId;
  amount: Money;
  receipt: Receipt;
  items: PurchaseItem[];
  purchasedAt: Date;
}

export type HrClaimStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface Claim {
  hrClaimId: string;
  status: HrClaimStatus;
  submittedAt: Date;
  decidedAt?: Date;
  lastChasedAt?: Date;
}

export type RefillFlag =
  | "BUDGET_BLOCKED"
  | "BUDGET_OVERRIDE"
  | "OVER_RESERVATION"
  | "OVER_BUDGET"
  | "UNUSUAL_AMOUNT"
  /** An optional LLM receipt reading disagrees with the amount entered. Informational only. */
  | "RECEIPT_MISMATCH";

export interface Refill {
  id: string;
  officeId: OfficeId;
  status: RefillStatus;
  /** Optimistic-lock counter. Every successful save increments it. */
  version: number;
  reportedBy: EmployeeId;
  createdAt: Date;
  assigneeId?: EmployeeId;
  offerExpiresAt?: Date;
  committedAt?: Date;
  commitDeadline?: Date;
  reminderSentAt?: Date;
  escalatedAt?: Date;
  /** True when nobody could be auto-selected: any eligible volunteer may take it. */
  selfTakeOpen: boolean;
  reservation?: Money;
  attempts: RefillAttempt[];
  purchase?: Purchase;
  claim?: Claim;
  flags: RefillFlag[];
}

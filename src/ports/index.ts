/**
 * Ports = the only things the core logic knows about the outside world.
 * Real adapters (Slack/Teams bot, HR REST client, Postgres repo, calendar) implement
 * these; the assessment ships simulated stand-ins in src/adapters.
 */
import type { Currency, Money } from "../domain/money";
import type { Employee, EmployeeId, Refill, OfficeId, HrClaimStatus } from "../domain/types";

export interface Clock {
  now(): Date;
}

// ---------------------------------------------------------------- chat

export type ChatKind =
  | "OFFER" // "Can you refill? Accept / Decline"
  | "REMINDER" // "Still on it?"
  | "HANDOVER" // told the previous owner that it was handed over
  | "CONFIRMATION" // you are committed / thanks
  | "ANNOUNCE" // channel post
  | "ESCALATION" // human attention needed
  | "BUDGET_BLOCKED"
  | "CLAIM_SLOW"
  | "CLAIM_REJECTED"
  | "CLAIM_APPROVED";

export interface ChatMessage {
  to: { userId: EmployeeId } | { channelOfOffice: OfficeId };
  kind: ChatKind;
  refillId?: string;
  text: string;
}

export interface ChatPort {
  send(message: ChatMessage): Promise<void>;
}

// ------------------------------------------------------------------ HR

export interface HrClaimRequest {
  /** Our refill id. HR may not de-duplicate, so we also keep hrClaimId ourselves. */
  idempotencyKey: string;
  amount: Money;
  description: string;
  receiptImageRef: string;
  employeeId: EmployeeId;
}

export interface HrPort {
  createClaim(req: HrClaimRequest): Promise<{ hrClaimId: string }>;
  getClaim(hrClaimId: string): Promise<{ status: HrClaimStatus }>;
}

// ----------------------------------------------------------- directory

export interface DirectoryPort {
  getEmployee(id: EmployeeId): Promise<Employee | undefined>;
  listVolunteers(): Promise<Employee[]>;
  /** Which office is the person physically in on this local day (YYYY-MM-DD)? null = home/holiday. */
  officeOn(employeeId: EmployeeId, localDay: string): Promise<OfficeId | null>;
}

// ----------------------------------------------------------------- FX

export interface FxPort {
  /** Rate in millionths: amount_in_to = amount_in_from * rateMicro / 1e6. */
  rateMicro(from: Currency, to: Currency, month: string): number;
}

// ---------------------------------------------------------- repository

export interface RefillRepository {
  get(id: string): Promise<Refill | undefined>;
  findActiveByOffice(officeId: OfficeId): Promise<Refill | undefined>;
  list(): Promise<Refill[]>;
  /** Throws ActiveRefillExistsError if the office already has an active refill. */
  insert(refill: Refill): Promise<void>;
  /** Compare-and-set on version. Throws ConflictError if the stored version differs. */
  save(refill: Refill, expectedVersion: number): Promise<void>;
}

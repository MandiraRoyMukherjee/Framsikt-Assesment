/** Typed domain errors so callers (chat bot, API) can react precisely. */

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Optimistic-lock failure: someone else changed the refill first ("you lost the race"). */
export class ConflictError extends DomainError {}

/** An active refill already exists for this office. */
export class ActiveRefillExistsError extends DomainError {}

/** The action is not valid in the refill's current state or for this person. */
export class InvalidTransitionError extends DomainError {}

/** Monthly budget does not allow another refill. */
export class BudgetError extends DomainError {}

export class NotFoundError extends DomainError {}

export class CurrencyMismatchError extends DomainError {
  constructor(a: string, b: string) {
    super(`Currency mismatch: ${a} vs ${b}`);
  }
}

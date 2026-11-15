/**
 * Money = integer minor units (øre / paise) + explicit currency.
 * Why: floats drift (0.1 + 0.2), and silently adding NOK to INR is the classic
 * multi-currency bug. Every operation here refuses to mix currencies.
 */
import { CurrencyMismatchError } from "./errors";

export type Currency = "NOK" | "INR";

export interface Money {
  readonly minor: number;
  readonly currency: Currency;
}

export function money(minor: number, currency: Currency): Money {
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError(`Money must be an integer number of minor units, got ${minor}`);
  }
  return { minor, currency };
}

/** money(6000, "NOK") -> 6000.00 NOK. Convenience for whole/major amounts. */
export function major(amount: number, currency: Currency): Money {
  return money(Math.round(amount * 100), currency);
}

export const zero = (currency: Currency): Money => money(0, currency);

function assertSame(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  assertSame(a, b);
  return money(a.minor + b.minor, a.currency);
}

export function sub(a: Money, b: Money): Money {
  assertSame(a, b);
  return money(a.minor - b.minor, a.currency);
}

export function sum(items: Money[], currency: Currency): Money {
  return items.reduce((acc, m) => add(acc, m), zero(currency));
}

export function gte(a: Money, b: Money): boolean {
  assertSame(a, b);
  return a.minor >= b.minor;
}

export function gt(a: Money, b: Money): boolean {
  assertSame(a, b);
  return a.minor > b.minor;
}

export function lt(a: Money, b: Money): boolean {
  assertSame(a, b);
  return a.minor < b.minor;
}

export function min(a: Money, b: Money): Money {
  assertSame(a, b);
  return a.minor <= b.minor ? a : b;
}

/**
 * Convert with an integer rate expressed in millionths (rateMicro 125000 = 0.125).
 * BigInt keeps the arithmetic exact; round half up (amounts are positive in reports).
 */
export function convert(m: Money, to: Currency, rateMicro: number): Money {
  if (m.currency === to) return m;
  const scaled = BigInt(m.minor) * BigInt(rateMicro);
  const rounded = (scaled + (scaled >= 0n ? 500000n : -500000n)) / 1000000n;
  return money(Number(rounded), to);
}

export function format(m: Money): string {
  const sign = m.minor < 0 ? "-" : "";
  const abs = Math.abs(m.minor);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const cents = (abs % 100).toString().padStart(2, "0");
  return `${sign}${whole}.${cents} ${m.currency}`;
}

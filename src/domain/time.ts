/**
 * Offices live in different timezones, and "today" / "this month" must be evaluated in the
 * OFFICE's timezone, not the server's (an Oslo purchase at 00:30 on the 1st belongs to the new month).
 */

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = dayFormatters.get(timeZone);
  if (!f) {
    // en-CA renders as YYYY-MM-DD
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormatters.set(timeZone, f);
  }
  return f;
}

/** "2026-03-01" for the given instant in the given timezone. */
export function localDay(date: Date, timeZone: string): string {
  return formatter(timeZone).format(date);
}

/** "2026-03" for the given instant in the given timezone. */
export function monthKey(date: Date, timeZone: string): string {
  return localDay(date, timeZone).slice(0, 7);
}

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

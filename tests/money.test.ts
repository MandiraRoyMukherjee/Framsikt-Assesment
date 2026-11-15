import { describe, expect, it } from "vitest";
import { CurrencyMismatchError } from "../src/domain/errors";
import { add, convert, format, gte, major, money, sub, sum } from "../src/domain/money";

describe("Money", () => {
  it("stores integer minor units - no floating point drift", () => {
    // 0.1 + 0.2 !== 0.3 with floats; with minor units it is exact.
    expect(add(major(0.1, "NOK"), major(0.2, "NOK")).minor).toBe(30);
  });

  it("rejects non-integer minor units", () => {
    expect(() => money(10.5, "NOK")).toThrow(RangeError);
  });

  it("refuses to mix currencies in every operation", () => {
    const nok = major(100, "NOK");
    const inr = major(100, "INR");
    expect(() => add(nok, inr)).toThrow(CurrencyMismatchError);
    expect(() => sub(nok, inr)).toThrow(CurrencyMismatchError);
    expect(() => gte(nok, inr)).toThrow(CurrencyMismatchError);
  });

  it("sums a list, and an empty list is zero in the given currency", () => {
    expect(sum([major(1, "INR"), major(2.5, "INR")], "INR").minor).toBe(350);
    expect(sum([], "NOK")).toEqual({ minor: 0, currency: "NOK" });
  });

  it("converts with an exact integer rate and rounds half up", () => {
    // 15 000 INR * 0.125 = 1 875 NOK exactly
    expect(convert(major(15000, "INR"), "NOK", 125_000)).toEqual(major(1875, "NOK"));
    // 1 paisa * 0.5 = 0.5 øre -> rounds up to 1
    expect(convert(money(1, "INR"), "NOK", 500_000).minor).toBe(1);
  });

  it("convert to the same currency is a no-op", () => {
    const m = major(10, "NOK");
    expect(convert(m, "NOK", 999)).toBe(m);
  });

  it("formats with thousands separators", () => {
    expect(format(major(6000, "NOK"))).toBe("6 000.00 NOK");
    expect(format(money(-12345, "INR"))).toBe("-123.45 INR");
  });
});

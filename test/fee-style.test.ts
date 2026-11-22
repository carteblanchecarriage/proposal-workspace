import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cleanFeeStyle, DEFAULT_FEE_STYLE, feeMoney, FEE_ROUNDINGS, roundFee, textOn } from "../src/fee-style";

describe("roundFee", () => {
  it.each([
    [1234.5, 1, 1235],
    [1234.49, 1, 1234],
    [12_345.67, 10, 12_350],
    [12_345.67, 100, 12_300],
    [12_345.67, 1000, 12_000],
    [1500, 1000, 2000], // halves round up
    [499.99, 1000, 0],
  ])("rounds %d to the nearest %d: %d", (n, to, out) => expect(roundFee(n, to as never)).toBe(out));

  it("cents come out exact (no 0.30000000000000004)", () => {
    expect(roundFee(0.1 + 0.2, 0.01)).toBe(0.3);
    expect(roundFee(1.005 * 1000, 0.01)).toBe(1005);
  });

  it("always lands on the increment, within half an increment of the amount", () =>
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e9, noNaN: true }), fc.constantFrom(...FEE_ROUNDINGS.map((r) => r.value)), (n, to) => {
        const r = roundFee(n, to);
        expect(Math.abs(r - n)).toBeLessThanOrEqual(to / 2 + 1e-6);
        expect(Math.round(r * 100) % Math.round(to * 100)).toBe(0);
      }),
    ));
});

describe("feeMoney", () => {
  it("whole dollars by default, with a thousands separator", () => expect(feeMoney(241_020.4)).toBe("$ 241,020"));
  it("cents when the setting is cents", () => expect(feeMoney(12_345.6, 0.01)).toBe("$ 12,345.60"));
  it("rounded to the setting", () => expect(feeMoney(12_345.67, 1000)).toBe("$ 12,000"));
  it("a dash for nothing, including amounts that round to nothing", () => {
    expect(feeMoney(0)).toBe("-");
    expect(feeMoney(0.4)).toBe("-");
    expect(feeMoney(400, 1000)).toBe("-");
  });
});

describe("cleanFeeStyle (what's saved, and what a bad record falls back to)", () => {
  it("nothing saved: the standard", () => expect(cleanFeeStyle(null)).toEqual(DEFAULT_FEE_STYLE));
  it("keeps good values, uppercasing colors", () =>
    expect(cleanFeeStyle({ head: "#aabbcc", font: "georgia", capitals: false, rounding: 1000 })).toMatchObject({ head: "#AABBCC", font: "georgia", capitals: false, rounding: 1000 }));
  it("replaces anything malformed with the standard", () => {
    const s = cleanFeeStyle({ head: "red", totalRow: "#12345", font: "comic" as never, capitals: "yes" as never, rounding: 7 as never });
    expect(s).toEqual(DEFAULT_FEE_STYLE);
  });
  it("the standard rounding is whole dollars (what tables showed before the setting existed)", () => expect(DEFAULT_FEE_STYLE.rounding).toBe(1));
});

describe("textOn: text color for a table color", () => {
  it.each([
    ["#FFFFFF", "#231f20"],
    ["#F4F4F4", "#231f20"],
    ["#000000", "#ffffff"],
    ["#231F20", "#ffffff"],
    // The standard header blue gets white text (as fee tables have always shown). Note: white on this blue is about
    // 2.6:1 contrast, under the 4.5:1 guideline for small text; dark text would be about 6.3:1. Kept as is on purpose.
    ["#20ABE2", "#ffffff"],
  ])("on %s", (bg, text) => expect(textOn(bg)).toBe(text));
});

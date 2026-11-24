// The $100 a month safeguard on AI spending (lib/ai-limits.ts), and how it shows on the organization's page.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AI_SAFEGUARD_USD, aiBlocked, effectiveLimit } from "../lib/ai-limits";
import { aiUse } from "../lib/org";

describe("effectiveLimit", () => {
  it.each([
    ["no limit", null, 100],
    ["a $20 allowance", 20, 20],
    ["exactly the safeguard", 100, 100],
    ["a plan cap set too high", 400, 100],
    ["a typo", 10_000, 100],
    ["AI off", 0, 0],
    ["a negative value (never saved, but never trusted)", -5, 0],
    ["not a number", NaN, 100],
  ])("%s (saved as %s): $%s applies", (_, limit, applies) => expect(effectiveLimit(limit)).toBe(applies));

  it("never goes above the safeguard, whatever is saved", () =>
    fc.assert(
      fc.property(fc.oneof(fc.constant(null), fc.double({ noNaN: false })), (limit) => {
        const applies = effectiveLimit(limit);
        expect(applies).toBeLessThanOrEqual(AI_SAFEGUARD_USD);
        expect(applies).toBeGreaterThanOrEqual(0);
      }),
    ));
});

describe("aiBlocked (the check before every AI request)", () => {
  it("allows AI under the allowance", () => expect(aiBlocked(20, 19.99)).toBeNull());
  it("pauses AI once the allowance is used", () => expect(aiBlocked(20, 20)).toBe("used up"));
  it("pauses AI at the safeguard, even with no limit", () => {
    expect(aiBlocked(null, 99.99)).toBeNull();
    expect(aiBlocked(null, 100)).toBe("used up");
  });
  it("pauses AI at the safeguard, even when the allowance is higher", () => expect(aiBlocked(500, 100)).toBe("used up"));
  it("an allowance of 0 means AI isn't turned on (not 'used up')", () => expect(aiBlocked(0, 0)).toBe("no allowance"));
});

describe("aiUse (the organization's page)", () => {
  it("shows a percent of the allowance that applies", () => {
    expect(aiUse(20, 5)).toEqual({ state: "limited", percent: 25 });
    expect(aiUse(null, 25)).toEqual({ state: "limited", percent: 25 }); // of the $100 safeguard
    expect(aiUse(1_000, 50)).toEqual({ state: "limited", percent: 50 });
  });
  it("never shows more than 100%", () => expect(aiUse(20, 21)).toEqual({ state: "limited", percent: 100 }));
  it("AI off", () => expect(aiUse(0, 0)).toEqual({ state: "off" }));
});

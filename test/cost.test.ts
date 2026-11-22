// AI pricing (lib/cost.ts). Every call's cost counts against an organization's allowance, so a model without a price
// would be free: its calls would never count. These tests catch that the moment a model changes.
import { describe, expect, it } from "vitest";
import { costOf } from "../lib/cost";
import { MODEL } from "../lib/claude";
import { ASSIST_MODEL } from "../lib/assist";
import { SCHEDULE_MODEL } from "../lib/schedule-ai";

const usage = (model: string, over = {}) => ({ model, input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, ...over });

describe("costOf", () => {
  it.each([
    ["main model", MODEL],
    ["project assistant", ASSIST_MODEL],
    ["schedule assistant", SCHEDULE_MODEL],
  ])("every model the app calls has a price (%s: %s)", (_, model) => {
    expect(costOf(usage(model, { input_tokens: 1_000 }))).toBeGreaterThan(0);
  });

  it("prices Opus 5.5 at $4 in / $20 out / $5 cache write / $0.20 cache read per million tokens", () => {
    expect(costOf(usage("claude-opus-5-5", { input_tokens: 1e6 }))).toBe(4);
    expect(costOf(usage("claude-opus-5-5", { output_tokens: 1e6 }))).toBe(20);
    expect(costOf(usage("claude-opus-5-5", { cache_write_tokens: 1e6 }))).toBe(5);
    expect(costOf(usage("claude-opus-5-5", { cache_read_tokens: 1e6 }))).toBeCloseTo(0.2, 10);
  });

  it("adds all four kinds of tokens", () => {
    const c = costOf(usage("claude-opus-5-5", { input_tokens: 10_000, output_tokens: 2_000, cache_write_tokens: 5_000, cache_read_tokens: 50_000 }));
    expect(c).toBeCloseTo((10_000 * 4 + 2_000 * 20 + 5_000 * 5 + 50_000 * 0.2) / 1e6, 12);
  });

  it("matches dated model names the API may report (claude-opus-5-5-…)", () => {
    expect(costOf(usage("claude-opus-5-5-20261001", { input_tokens: 1e6 }))).toBe(4);
  });

  it("a longer name never takes a shorter one's price: Opus 5.5 is not priced as Opus 5", () => {
    expect(costOf(usage("claude-opus-5-5", { input_tokens: 1e6 }))).toBe(4);
    expect(costOf(usage("claude-opus-5", { input_tokens: 1e6 }))).toBe(5);
    expect(costOf(usage("claude-opus-5-20260901", { input_tokens: 1e6 }))).toBe(5);
    expect(costOf(usage("claude-sonnet-5-5", { input_tokens: 1e6 }))).toBe(2);
  });

  it("an unknown model has no price (null): such calls don't count against an allowance", () => {
    expect(costOf(usage("some-other-model", { input_tokens: 1e6 }))).toBeNull();
  });
});

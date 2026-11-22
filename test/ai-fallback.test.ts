// What happens when an AI call fails (lib/ai-fallback.ts). Failures are simulated: no AI is called.
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { ATTEMPT_TIMEOUT_MS, FALLBACK_MODEL, REQUEST_BUDGET_MS, withFallback, worthFallingBack } from "../lib/ai-fallback";
import { costOf } from "../lib/cost";

const headers = new Headers();
const api = (status: number) => Anthropic.APIError.generate(status, { error: { message: "x" } }, "x", headers);
const quiet = { warn: () => {}, error: () => {} };

describe("worthFallingBack: which failures another model might not have", () => {
  it.each([
    ["overloaded (529)", api(529)],
    ["server error (500)", api(500)],
    ["bad gateway (502)", api(502)],
    ["rate limited (429)", api(429)],
    ["a dropped connection", new Anthropic.APIConnectionError({ message: "reset" })],
  ])("yes for %s", (_, err) => expect(worthFallingBack(err)).toBe(true));

  it.each([
    ["a bad request (400): the other model would reject it too", api(400)],
    ["a bad API key (401)", api(401)],
    ["not found (404), e.g. an expired file", api(404)],
    ["a timeout: no time left for a second slow attempt", new Anthropic.APIConnectionTimeoutError()],
    ["an app error", new Error("oops")],
  ])("no for %s", (_, err) => expect(worthFallingBack(err)).toBe(false));
});

describe("withFallback", () => {
  it("uses the main model when it works, with the attempt time limit", async () => {
    const attempt = vi.fn(async (model: string, _options?: { timeout: number; maxRetries?: number }) => `answer from ${model}`);
    await expect(withFallback("claude-opus-5-5", attempt, { log: quiet })).resolves.toBe("answer from claude-opus-5-5");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledWith("claude-opus-5-5", { timeout: ATTEMPT_TIMEOUT_MS });
  });

  it("tries the fallback model once, without retries of its own, when the main one is overloaded", async () => {
    const attempt = vi.fn(async (model: string, _options?: { timeout: number; maxRetries?: number }) => {
      if (model === "claude-opus-5-5") throw api(529);
      return "from the fallback";
    });
    await expect(withFallback("claude-opus-5-5", attempt, { log: quiet })).resolves.toBe("from the fallback");
    expect(attempt.mock.calls.map((c) => c[0])).toEqual(["claude-opus-5-5", "claude-opus-5"]);
    expect(attempt.mock.calls[1]![1]).toMatchObject({ maxRetries: 0 });
  });

  it("gives the fallback only the time that's left", async () => {
    let t = 0;
    const attempt = vi.fn(async (model: string, _options?: { timeout: number; maxRetries?: number }) => {
      if (model === "claude-opus-5-5") {
        t = 100_000; // the main model took 100 s to fail
        throw api(500);
      }
      return "ok";
    });
    await withFallback("claude-opus-5-5", attempt, { started: 0, now: () => t, log: quiet });
    expect(attempt.mock.calls[1]![1]!.timeout).toBe(REQUEST_BUDGET_MS - 15_000 - 100_000);
  });

  it("doesn't start a fallback that couldn't finish in time", async () => {
    let t = 0;
    const attempt = vi.fn(async () => {
      t = 250_000;
      throw api(529);
    });
    await expect(withFallback("claude-opus-5-5", attempt, { started: 0, now: () => t, log: quiet })).rejects.toMatchObject({ status: 529 });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("never falls back on a rejected request", async () => {
    const attempt = vi.fn(async () => {
      throw api(400);
    });
    await expect(withFallback("claude-opus-5-5", attempt, { log: quiet })).rejects.toMatchObject({ status: 400 });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("reports the original failure when the fallback fails too", async () => {
    const attempt = vi.fn(async (model: string, _options?: { timeout: number; maxRetries?: number }) => {
      throw model === "claude-opus-5-5" ? api(529) : api(500);
    });
    await expect(withFallback("claude-opus-5-5", attempt, { log: quiet })).rejects.toMatchObject({ status: 529 });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("a model without a fallback just fails", async () => {
    const attempt = vi.fn(async () => {
      throw api(529);
    });
    await expect(withFallback("some-model", attempt, { log: quiet })).rejects.toMatchObject({ status: 529 });
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe("fallback models are priced", () => {
  it.each(Object.entries(FALLBACK_MODEL))("%s falls back to %s, which has a price", (_, fallback) => {
    expect(costOf({ model: fallback, input_tokens: 1e6, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0 })).toBeGreaterThan(0);
  });

  it("the time budget matches Vercel's limit for every AI endpoint", async () => {
    const { readFileSync } = await import("node:fs");
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { functions: Record<string, { maxDuration: number }> };
    for (const api of ["api/rfp.ts", "api/chat.ts", "api/compare.ts", "api/extract.ts", "api/fee-draft.ts", "api/schedule-ai.ts"]) {
      expect(vercel.functions[api].maxDuration * 1000).toBeGreaterThanOrEqual(REQUEST_BUDGET_MS);
    }
  });
});

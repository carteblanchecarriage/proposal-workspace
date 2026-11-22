// The project assistant's answers (lib/assist.ts): limits per model, refusals and cut-off replies.
import { describe, expect, it } from "vitest";
import { ASSIST_MODEL, checkReply, cutOffNote, replyLimits } from "../lib/assist";

describe("the project assistant", () => {
  it("answers directly on its own model, with a short limit", () => expect(replyLimits(ASSIST_MODEL)).toEqual({ max_tokens: 2048 }));
  it("gives the fallback (which thinks first) room, at low effort", () => expect(replyLimits("claude-sonnet-5-5")).toEqual({ max_tokens: 8_000, output_config: { effort: "low" } }));
  it("says plainly when the AI declines", () => expect(() => checkReply("refusal")).toThrow(/declined/));
  it("an ordinary answer passes", () => expect(() => checkReply("end_turn")).not.toThrow());
  it("a cut-off answer says so", () => {
    expect(cutOffNote("max_tokens")).toMatch(/cut off/);
    expect(cutOffNote("end_turn")).toBe("");
  });
});

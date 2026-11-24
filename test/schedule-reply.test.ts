// The schedule assistant's reply (src/schedule-reply.ts): never shown as code, never half applied.
import { describe, expect, it } from "vitest";
import { readReply } from "../src/schedule-reply";

describe("readReply", () => {
  it("an edit", () => expect(readReply('{"message":"Moved it.","changes":[{"type":"x"}]}')).toEqual({ message: "Moved it.", changes: [{ type: "x" }] }));
  it("an edit in a code block", () => expect(readReply('```json\n{"message":"Hi","changes":[]}\n```')).toEqual({ message: "Hi", changes: [] }));
  it("a plain answer, braces and all", () => {
    for (const s of ["Bidding ends in May.", "The set {SD, DD} is done."]) expect(readReply(s)).toEqual({ message: s, changes: null });
  });
  it.each(['{"message":"Moved","changes":[{"type":"updateTask","patch":{"start":"2027-0', '```json\n{"message":"Mov', 'Sure: {"message":"x","changes":[{"a":{}},'])("cut off: %s", (s) => {
    const r = readReply(s);
    expect(r.changes).toBeNull();
    expect(r.message).toMatch(/nothing was changed/);
  });
  it("odd values in it", () => expect(readReply('{"message":5,"changes":"no"}')).toEqual({ message: "Done.", changes: [] }));
});

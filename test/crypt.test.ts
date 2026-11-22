// Encryption of saved records (lib/crypt.ts). A fixed test key is set in vitest.config.ts; the real one is never used.
import { describe, expect, it } from "vitest";
import { isSealed, rowAad, seal, unseal } from "../lib/crypt";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const record = { id: "fee-1", title: "Library fee", total: 50_400, nested: { list: [1, "two", null] } };

describe("seal and unseal", () => {
  it("round-trips any record", () => {
    const aad = rowAad("fees", "fee-1");
    expect(unseal(ORG_A, aad, seal(ORG_A, aad, record))).toEqual(record);
  });

  it("stores nothing readable", () => {
    const sealed = seal(ORG_A, rowAad("fees", "fee-1"), record);
    expect(isSealed(sealed)).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain("Library");
    expect(JSON.stringify(sealed)).not.toContain("50400");
  });

  it("encrypts the same record differently each time (a fresh IV per save)", () => {
    const aad = rowAad("fees", "fee-1");
    expect(seal(ORG_A, aad, record).ct).not.toBe(seal(ORG_A, aad, record).ct);
  });

  it("another organization can't open it", () => {
    const aad = rowAad("fees", "fee-1");
    expect(() => unseal(ORG_B, aad, seal(ORG_A, aad, record))).toThrow(/couldn't be decrypted/);
  });

  it("it can't be moved to another row or table", () => {
    const sealed = seal(ORG_A, rowAad("fees", "fee-1"), record);
    expect(() => unseal(ORG_A, rowAad("fees", "fee-2"), sealed)).toThrow(/couldn't be decrypted/);
    expect(() => unseal(ORG_A, rowAad("schedules", "fee-1"), sealed)).toThrow(/couldn't be decrypted/);
  });

  it("any tampering is caught", () => {
    const aad = rowAad("fees", "fee-1");
    const sealed = seal(ORG_A, aad, record);
    const flipped = Buffer.from(sealed.ct, "base64");
    flipped[0] ^= 1;
    expect(() => unseal(ORG_A, aad, { ...sealed, ct: flipped.toString("base64") })).toThrow(/couldn't be decrypted/);
  });

  it("records saved before encryption are still read as they are", () => {
    expect(unseal(ORG_A, rowAad("fees", "old"), { id: "old", title: "plain" })).toEqual({ id: "old", title: "plain" });
  });
});

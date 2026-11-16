import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { UserFacingError } from "./claude.js";

/**
 * Encryption of saved records. Every record's contents are encrypted on the server before they go to Supabase, so
 * the database, its dashboard and its backups only ever hold scrambled data. Server-side only.
 *
 * - Key: DATA_ENCRYPTION_KEY (32 random bytes, base64) in .env.local and Vercel's environment variables, never in
 *   the database. Lose it and the data can't be read back, so keep a copy somewhere safe (a password manager).
 * - Each organization gets its own key, derived from that one (HKDF-SHA256 with the organization's id), so one
 *   organization's data can't be opened with another's key.
 * - AES-256-GCM, with the table and record key as associated data: a record can't be moved to another row or table
 *   without failing to decrypt.
 * - Records saved before encryption (plain JSON) are still read; scripts/encrypt-data.mjs encrypts them.
 */

export type Sealed = { enc: 1; iv: string; tag: string; ct: string };

let master: Buffer | null | undefined;
function masterKey(): Buffer | null {
  if (master !== undefined) return master;
  const raw = process.env.DATA_ENCRYPTION_KEY?.trim();
  if (!raw) return (master = null);
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new UserFacingError("DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded.", 500);
  return (master = key);
}

export const encryptionConfigured = () => !!masterKey();

const orgKeys = new Map<string, Buffer>();
function orgKey(org: string): Buffer {
  const key = masterKey();
  if (!key) throw new UserFacingError("Data encryption isn't configured on the server (DATA_ENCRYPTION_KEY).", 500);
  let k = orgKeys.get(org);
  if (!k) {
    k = Buffer.from(hkdfSync("sha256", key, Buffer.from(org, "utf8"), Buffer.from("proposal-workspace/records/v1", "utf8"), 32));
    orgKeys.set(org, k);
  }
  return k;
}

export const isSealed = (v: unknown): v is Sealed =>
  !!v && typeof v === "object" && (v as Sealed).enc === 1 && typeof (v as Sealed).ct === "string" && typeof (v as Sealed).iv === "string";

/** Encrypts a record for one organization's row (table + record key). Refuses when there's no key: never saves plain text. */
export function seal(org: string, aad: string, value: unknown): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", orgKey(org), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { enc: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

/** Reads a stored record: decrypts it, or passes through one saved before encryption. */
export function unseal(org: string, aad: string, stored: unknown): unknown {
  if (!isSealed(stored)) return stored;
  try {
    const decipher = createDecipheriv("aes-256-gcm", orgKey(org), Buffer.from(stored.iv, "base64"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(stored.ct, "base64")), decipher.final()]).toString("utf8"));
  } catch (err) {
    if (err instanceof UserFacingError) throw err;
    console.error("[crypt] a record couldn't be decrypted (wrong key, or it was altered)");
    throw new UserFacingError("A saved record couldn't be decrypted. Check DATA_ENCRYPTION_KEY.", 500);
  }
}

/** The associated data for a row: which table and which record it belongs to. */
export const rowAad = (table: string, key: string) => `${table}:${key}`;

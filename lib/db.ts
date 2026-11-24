import { UserFacingError } from "./errors.js";
import { rowAad, seal, unseal } from "./crypt.js";

// Talks to Supabase's REST API with the secret key. Server-side only; the browser never sees the key.

export const TABLES = { rfps: "rfp_reviews", comparisons: "comparisons", readings: "readings", projects: "projects", consultants: "consultants", schedules: "schedules", fees: "fees", settings: "settings", pursuits: "pursuits" } as const;
export type Table = keyof typeof TABLES;

export function dbConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
}

async function sb(path: string, init: RequestInit = {}): Promise<Response> {
  const base = process.env.SUPABASE_URL!.replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SECRET_KEY!;
  const res = await fetch(`${base}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", ...init.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[db] ${res.status} ${path.split("?")[0]}: ${body.slice(0, 300)}`);
    if (/does not exist|schema cache|org_id/i.test(body)) throw new UserFacingError("Database tables are missing or out of date. Run supabase/schema.sql, then supabase/orgs.sql, in the Supabase SQL Editor.", 500);
    if (/permission denied/i.test(body)) throw new UserFacingError("The database refused access. Run the grant line at the end of supabase/schema.sql in the Supabase SQL Editor.", 500);
    throw new UserFacingError(`Database error (${res.status}).`, 502);
  }
  return res;
}

const keyCol = (t: Table) => (t === "readings" ? "hash" : "id");
const q = encodeURIComponent;

// Every record belongs to one organization (supabase/orgs.sql); each call below is limited to the one it's given.
// Records are encrypted before they're saved and decrypted as they're read (lib/crypt.ts): the database only ever
// holds an organization id, a record key, a timestamp and scrambled data.

type StoredRow = Record<string, unknown> & { data: unknown };
const opened = (org: string, t: Table, r: StoredRow) => unseal(org, rowAad(TABLES[t], String(r[keyCol(t)])), r.data);

// Schedules and fees carry their version (when the row was last saved) to the browser as _v, and a save says which version it
// started from, so it can't replace someone else's newer one (putIfUnchanged). Never stored in the record itself.
const VERSIONED = new Set<Table>(["schedules", "fees"]);
const columns = (t: Table) => `${keyCol(t)},data${VERSIONED.has(t) ? ",saved_at" : ""}`;
const withVersion = (t: Table, r: StoredRow, record: unknown) =>
  VERSIONED.has(t) && record && typeof record === "object" ? { ...record, _v: r.saved_at } : record;

export async function list(org: string, t: Table): Promise<unknown[]> {
  const rows: StoredRow[] = await (await sb(`${TABLES[t]}?select=${columns(t)}&org_id=eq.${q(org)}&order=saved_at.desc&limit=500`)).json();
  return rows.map((r) => withVersion(t, r, opened(org, t, r)));
}

export async function get(org: string, t: Table, key: string): Promise<unknown | null> {
  const rows: StoredRow[] = await (await sb(`${TABLES[t]}?select=${columns(t)}&org_id=eq.${q(org)}&${keyCol(t)}=eq.${q(key)}`)).json();
  return rows[0] ? withVersion(t, rows[0], opened(org, t, rows[0])) : null;
}

/** What the browser already has of a table: record key → the version it has. */
export type Known = Record<string, string>;
/** Every key of a table with its version, newest first, and the records the browser doesn't have (or has an older one of). */
export type Synced = { keys: [string, string][]; rows: { key: string; v: string; record: unknown }[] };

/**
 * A table as it is now, sending only what's changed. Most loads find nothing has, and cost one small query instead of
 * reading, decrypting and sending every record.
 */
export async function sync(org: string, t: Table, known: Known): Promise<Synced> {
  const k = keyCol(t);
  const from = `${TABLES[t]}?org_id=eq.${q(org)}&order=saved_at.desc&limit=500`;
  const open = (rows: StoredRow[]) => rows.map((r) => ({ key: String(r[k]), v: String(r.saved_at), record: withVersion(t, r, opened(org, t, r)) }));
  if (!Object.keys(known).length) {
    const rows = open(await (await sb(`${from}&select=${k},data,saved_at`)).json());
    return { keys: rows.map((r) => [r.key, r.v]), rows };
  }
  const keys = ((await (await sb(`${from}&select=${k},saved_at`)).json()) as StoredRow[]).map((r): [string, string] => [String(r[k]), String(r.saved_at)]);
  const changed = keys.filter(([key, v]) => known[key] !== v).map(([key]) => key);
  if (!changed.length) return { keys, rows: [] };
  // A few by name; many, by reading the table again.
  const few = changed.length <= 40;
  const only = few ? `&${k}=in.(${changed.map((x) => q(`"${x.replace(/["\\]/g, "\\$&")}"`)).join(",")})` : "";
  const want = new Set(changed);
  const rows: StoredRow[] = await (await sb(`${from}&select=${k},data,saved_at${only}`)).json();
  return { keys, rows: open(rows.filter((r) => want.has(String(r[k])))) };
}

/** When a record was last saved, without opening it; null when it's gone. */
export async function version(org: string, t: Table, key: string): Promise<string | null> {
  const rows: { saved_at: string }[] = await (await sb(`${TABLES[t]}?select=saved_at&org_id=eq.${q(org)}&${keyCol(t)}=eq.${q(key)}`)).json();
  return rows[0]?.saved_at ?? null;
}

function sealedRow(org: string, t: Table, input: Record<string, unknown>): { key: string; row: Record<string, unknown> } {
  const { _v, ...record } = input;
  const key = record[keyCol(t)];
  if (typeof key !== "string" || !key) throw new UserFacingError("Missing record key.");
  // Only the encrypted record is stored. (The tables' older side columns, such as name, title and project, stay
  // empty: they'd be readable.)
  const row: Record<string, unknown> = { org_id: org, [keyCol(t)]: key, data: seal(org, rowAad(TABLES[t], key), record), saved_at: new Date().toISOString() };
  return { key, row };
}

/** Saves a new record only if there's none with its key yet, in one step. Returns its version, or null when there is one. */
export async function putNew(org: string, t: Table, record: Record<string, unknown>): Promise<string | null> {
  const { row } = sealedRow(org, t, record);
  const res = await sb(`${TABLES[t]}?on_conflict=org_id,${keyCol(t)}&select=saved_at`, {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify(row),
  });
  const rows: { saved_at: string }[] = await res.json();
  return rows[0]?.saved_at ?? null;
}

/** Saves a record, replacing any there. Returns its new version. */
export async function put(org: string, t: Table, record: Record<string, unknown>): Promise<string | null> {
  const { row } = sealedRow(org, t, record);
  // The key is (org_id, id), so a save can only ever replace this organization's own record.
  const res = await sb(`${TABLES[t]}?on_conflict=org_id,${keyCol(t)}&select=saved_at`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(row),
  });
  const rows: { saved_at: string }[] = await res.json();
  return rows[0]?.saved_at ?? null;
}

/**
 * Saves a record only if it's still the version the edit started from: checked and saved in one step by the database,
 * so two saves at once can't both succeed. Returns the new version, or null when someone else saved (or deleted) it.
 */
export async function putIfUnchanged(org: string, t: Table, record: Record<string, unknown>, base: string): Promise<string | null> {
  const { key, row } = sealedRow(org, t, record);
  // Always later than the version it replaces, whatever the servers' clocks say: a version is never reused.
  const after = Date.parse(base) + 1;
  if (!Number.isFinite(after)) throw new UserFacingError("Invalid version.");
  const saved_at = new Date(Math.max(Date.now(), after)).toISOString();
  const res = await sb(`${TABLES[t]}?org_id=eq.${q(org)}&${keyCol(t)}=eq.${q(key)}&saved_at=eq.${q(base)}&select=saved_at`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ data: row.data, saved_at }),
  });
  const rows: { saved_at: string }[] = await res.json();
  return rows[0]?.saved_at ?? null;
}

export async function remove(org: string, t: Table, key: string): Promise<void> {
  await sb(`${TABLES[t]}?org_id=eq.${q(org)}&${keyCol(t)}=eq.${q(key)}`, { method: "DELETE" });
}

/** Whether any organization other than this one has a record with this key (guards stored-file paths). */
export async function ownedElsewhere(org: string, t: Table, key: string): Promise<boolean> {
  const rows: unknown[] = await (await sb(`${TABLES[t]}?select=org_id&org_id=neq.${q(org)}&${keyCol(t)}=eq.${q(key)}&limit=1`)).json();
  return rows.length > 0;
}

export async function addFeedback(message: string, tab: string | null, org: string | null, email: string | null): Promise<void> {
  await insertRow("feedback", { message, tab, org_id: org, user_email: email });
}

export async function insertRow(table: string, row: Record<string, unknown>): Promise<void> {
  await sb(table, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
}

/** A raw REST query (path after /rest/v1/), for the organization page (lib/org.ts). Callers filter by org_id themselves. */
export async function query<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await sb(path, init);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** Every record of a table for one organization (no 500-row cap, unlike list), for exports. */
export async function listAll(org: string, t: Table): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let offset = 0; ; offset += 1000) {
    const rows = await query<StoredRow[]>(`${TABLES[t]}?select=${keyCol(t)},data&org_id=eq.${q(org)}&order=saved_at.asc&limit=1000&offset=${offset}`);
    out.push(...rows.map((r) => opened(org, t, r)));
    if (rows.length < 1000) return out;
  }
}

/** Calls a database function (supabase/orgs.sql) with the secret key. */
export async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  return (await sb(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) })).json();
}

import { UserFacingError } from "./claude.js";
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

export async function list(org: string, t: Table): Promise<unknown[]> {
  const rows: StoredRow[] = await (await sb(`${TABLES[t]}?select=${keyCol(t)},data&org_id=eq.${q(org)}&order=saved_at.desc&limit=500`)).json();
  return rows.map((r) => opened(org, t, r));
}

export async function get(org: string, t: Table, key: string): Promise<unknown | null> {
  const rows: StoredRow[] = await (await sb(`${TABLES[t]}?select=${keyCol(t)},data&org_id=eq.${q(org)}&${keyCol(t)}=eq.${q(key)}`)).json();
  return rows[0] ? opened(org, t, rows[0]) : null;
}

export async function put(org: string, t: Table, record: Record<string, unknown>): Promise<void> {
  const key = record[keyCol(t)];
  if (typeof key !== "string" || !key) throw new UserFacingError("Missing record key.");
  // Only the encrypted record is stored. (The tables' older side columns, such as name, title and project, stay
  // empty: they'd be readable.)
  const row: Record<string, unknown> = { org_id: org, [keyCol(t)]: key, data: seal(org, rowAad(TABLES[t], key), record), saved_at: new Date().toISOString() };
  // The key is (org_id, id), so a save can only ever replace this organization's own record.
  await sb(`${TABLES[t]}?on_conflict=org_id,${keyCol(t)}`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(row) });
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

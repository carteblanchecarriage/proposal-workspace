import { currentOrgId, route } from "../lib/auth.js";
import { UserFacingError } from "../lib/errors.js";
import { get, list, put, putIfUnchanged, putNew, remove, sync, TABLES, version, type Known, type Table } from "../lib/db.js";

// /api/db?table=rfps|comparisons|readings|…[&key=...]
//   POST with x-action "sync": several tables at once, only what's changed (what the pages load with)
//   GET: list (or one record with key; with &version, only when it was last saved) · POST: save the JSON body (with
//   &base=version, only if it's still that version, or &create, only if there's none yet; otherwise 409 with the current record) · DELETE: delete key
// Everything is limited to the signed-in person's organization.
//
// When there's no database or login (local dev), the answer is a 503 that says so ({ storage: "browser" }), and the
// browser then keeps saving locally. That's the only answer that does: any other failure, a 503 included, is an
// error the page shows, so a passing outage never quietly switches someone to saving in their browser only.

/** The one answer that tells the browser to save locally: no database is set up on this server. */
export const NO_DATABASE = { error: "Database not configured.", storage: "browser" } as const;

type Params = { org: string; table: Table; key: string | null };

/** The request's organization, table and key; or the no-database answer. */
function params(request: Request): Params | Response {
  const org = currentOrgId();
  if (!org) return Response.json(NO_DATABASE, { status: 503 });
  const url = new URL(request.url);
  const table = url.searchParams.get("table") as Table;
  if (!Object.hasOwn(TABLES, table)) throw new UserFacingError("Unknown table.");
  return { org, table, key: url.searchParams.get("key") };
}

export const GET = route(async (request) => {
  const p = params(request);
  if (p instanceof Response) return p;
  if (p.key && new URL(request.url).searchParams.has("version")) return Response.json({ version: await version(p.org, p.table, p.key) });
  return Response.json(p.key ? await get(p.org, p.table, p.key) : await list(p.org, p.table));
});

/** Under Vercel's 4.5 MB limit on an answer: what doesn't fit is left for the browser to ask for next. */
const MAX_ANSWER = 3_500_000;

/**
 * x-action "sync": { tables: { projects: { id: version, … }, … } } → each table's keys and versions, and the records
 * the browser doesn't have yet. `more`: some were left out to keep the answer within the limit.
 */
async function syncTables(request: Request): Promise<Response> {
  const org = currentOrgId();
  if (!org) return Response.json(NO_DATABASE, { status: 503 });
  const asked = ((await request.json().catch(() => null)) as { tables?: unknown } | null)?.tables;
  if (!asked || typeof asked !== "object") throw new UserFacingError("Invalid request.");
  const entries = Object.entries(asked as Record<string, unknown>);
  if (entries.some(([t, known]) => !Object.hasOwn(TABLES, t) || !known || typeof known !== "object")) throw new UserFacingError("Unknown table.");
  const found = await Promise.all(entries.map(async ([t, known]) => [t, await sync(org, t as Table, known as Known)] as const));
  let size = 0;
  let sent = 0;
  let more = false;
  const tables: Record<string, unknown> = {};
  for (const [t, s] of found) {
    const rows = s.rows.filter((r) => {
      const bytes = Buffer.byteLength(JSON.stringify(r));
      // Always at least one, so asking again always gets further.
      if (sent && size + bytes > MAX_ANSWER) return (more = true), false;
      size += bytes;
      sent++;
      return true;
    });
    tables[t] = { keys: s.keys, rows };
  }
  return Response.json({ tables, more }, { headers: { "cache-control": "no-store" } });
}

export const POST = route(async (request) => {
  if (request.headers.get("x-action") === "sync") return syncTables(request);
  const p = params(request);
  if (p instanceof Response) return p;
  const record = await request.json().catch(() => null);
  if (!record || typeof record !== "object") throw new UserFacingError("Invalid record.");
  const search = new URL(request.url).searchParams;
  const base = search.get("base");
  const create = search.has("create");
  if (!base && !create) return Response.json({ ok: true, version: await put(p.org, p.table, record) });
  const saved = base ? await putIfUnchanged(p.org, p.table, record, base) : await putNew(p.org, p.table, record);
  if (saved) return Response.json({ ok: true, version: saved });
  return Response.json(
    { conflict: true, error: "Someone else saved this since you opened it.", record: await get(p.org, p.table, String((record as { id?: unknown }).id ?? "")) },
    { status: 409 },
  );
});

export const DELETE = route(async (request) => {
  const p = params(request);
  if (p instanceof Response) return p;
  if (!p.key) throw new UserFacingError("Missing key.");
  await remove(p.org, p.table, p.key);
  return Response.json({ ok: true });
});

import { currentOrgId, route } from "../lib/auth.js";
import { UserFacingError } from "../lib/claude.js";
import { get, list, put, putIfUnchanged, remove, TABLES, version, type Table } from "../lib/db.js";

// /api/db?table=rfps|comparisons|readings|…[&key=...]
//   GET: list (or one record with key; with &version, only when it was last saved) · POST: save the JSON body (with
//   &base=version, only if it's still that version; otherwise 409 with the current record) · DELETE: delete key
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

export const POST = route(async (request) => {
  const p = params(request);
  if (p instanceof Response) return p;
  const record = await request.json().catch(() => null);
  if (!record || typeof record !== "object") throw new UserFacingError("Invalid record.");
  const base = new URL(request.url).searchParams.get("base");
  if (!base) return Response.json({ ok: true, version: await put(p.org, p.table, record) });
  const saved = await putIfUnchanged(p.org, p.table, record, base);
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

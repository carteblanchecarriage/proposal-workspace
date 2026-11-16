import { currentOrgId, route } from "../lib/auth.js";
import { UserFacingError } from "../lib/claude.js";
import { get, list, put, remove, TABLES, type Table } from "../lib/db.js";

// /api/db?table=rfps|comparisons|readings|…[&key=...]
//   GET: list (or one record with key) · POST: save the JSON body · DELETE: delete key
// Everything is limited to the signed-in person's organization.
// 503 when there's no database or login (local dev); the browser then keeps saving locally.

function params(request: Request): { org: string; table: Table; key: string | null } {
  const org = currentOrgId();
  if (!org) throw new UserFacingError("Database not configured.", 503);
  const url = new URL(request.url);
  const table = url.searchParams.get("table") as Table;
  if (!Object.hasOwn(TABLES, table)) throw new UserFacingError("Unknown table.");
  return { org, table, key: url.searchParams.get("key") };
}

export const GET = route(async (request) => {
  const { org, table, key } = params(request);
  return Response.json(key ? await get(org, table, key) : await list(org, table));
});

export const POST = route(async (request) => {
  const { org, table } = params(request);
  const record = await request.json().catch(() => null);
  if (!record || typeof record !== "object") throw new UserFacingError("Invalid record.");
  await put(org, table, record);
  return Response.json({ ok: true });
});

export const DELETE = route(async (request) => {
  const { org, table, key } = params(request);
  if (!key) throw new UserFacingError("Missing key.");
  await remove(org, table, key);
  return Response.json({ ok: true });
});

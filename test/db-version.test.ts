// Saving a schedule only if no one else has since (lib/db.ts), against a simulated Supabase.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { org_id: string; id: string; data: unknown; saved_at: string };
let rows: Row[];
let sent: string[];
beforeEach(() => {
  rows = [];
  sent = [];
  vi.stubEnv("SUPABASE_URL", "https://db.test");
  vi.stubEnv("SUPABASE_SECRET_KEY", "x");
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    sent.push(String(init.body ?? ""));
    const eq = (k: string) => u.searchParams.get(k)?.replace(/^eq\./, "");
    const match = (r: Row) => (["org_id", "id", "saved_at"] as const).every((k) => eq(k) === undefined || (k === "saved_at" ? Date.parse(eq(k)!) === Date.parse(r[k]) : eq(k) === r[k]));
    if (init.method === "POST") {
      rows = [...rows.filter((r) => !(r.org_id === body.org_id && r.id === body.id)), body];
      return Response.json([body]);
    }
    const found = rows.filter(match);
    if (init.method === "PATCH") found.forEach((r) => Object.assign(r, body));
    // Times come back with an offset, as Postgres writes them.
    return Response.json(found.map((r) => ({ ...r, saved_at: r.saved_at.replace("Z", "+00:00") })));
  });
});
const db = () => import("../lib/db");
const s = (title: string) => ({ id: "a", title });

describe("putIfUnchanged", () => {
  it("saves over the version it started from, and gives the new one", async () => {
    const { put, putIfUnchanged, get, version } = await db();
    await put("o", "schedules", s("one"));
    const v1 = (await version("o", "schedules", "a"))!;
    const v2 = (await putIfUnchanged("o", "schedules", s("two"), v1))!;
    expect(Date.parse(v2)).toBeGreaterThan(Date.parse(v1));
    expect(await get("o", "schedules", "a")).toEqual({ ...s("two"), _v: v2 });
  });

  it("refuses when someone saved since, and changes nothing", async () => {
    const { put, putIfUnchanged, get, version } = await db();
    await put("o", "schedules", s("one"));
    const v1 = (await version("o", "schedules", "a"))!;
    await putIfUnchanged("o", "schedules", s("theirs"), v1);
    expect(await putIfUnchanged("o", "schedules", s("mine"), v1)).toBeNull();
    expect(await get("o", "schedules", "a")).toMatchObject(s("theirs"));
  });

  it("refuses when it was deleted, and never touches another organization's", async () => {
    const { put, putIfUnchanged, get, version } = await db();
    await put("other", "schedules", s("theirs"));
    const v = (await version("other", "schedules", "a"))!;
    expect(await putIfUnchanged("o", "schedules", s("mine"), v)).toBeNull();
    expect(await get("other", "schedules", "a")).toMatchObject(s("theirs"));
  });

  it("the version isn't stored in the record, and other tables don't carry one", async () => {
    const { put, get } = await db();
    await put("o", "schedules", { ...s("one"), _v: "x" });
    expect(((await get("o", "schedules", "a")) as { _v: string })._v).not.toBe("x");
    await put("o", "fees", s("fee"));
    expect(await get("o", "fees", "a")).toEqual(s("fee"));
  });
});

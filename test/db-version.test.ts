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
      const there = rows.some((r) => r.org_id === body.org_id && r.id === body.id);
      if (there && new Headers(init.headers).get("Prefer")!.includes("ignore-duplicates")) return Response.json([]);
      rows = [...rows.filter((r) => !(r.org_id === body.org_id && r.id === body.id)), body];
      return Response.json([body]);
    }
    const named = u.searchParams.get("id")?.match(/^in\.\((.*)\)$/)?.[1].split(",").map((x) => x.replace(/^"|"$/g, ""));
    const found = named ? rows.filter((r) => r.org_id === eq("org_id") && named.includes(r.id)) : rows.filter(match);
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
    await put("o", "rfps", s("rfp"));
    expect(await get("o", "rfps", "a")).toEqual(s("rfp"));
  });
});

describe("putNew", () => {
  it("two people making the same record: the first one's stays", async () => {
    const { putNew, get } = await db();
    const made = await Promise.all([putNew("o", "fees", s("first")), putNew("o", "fees", s("second"))]);
    expect(made.filter(Boolean)).toHaveLength(1);
    expect(await get("o", "fees", "a")).toMatchObject(s("first"));
  });
  it("another organization's record with the same id doesn't count", async () => {
    const { putNew } = await db();
    await putNew("other", "fees", s("theirs"));
    expect(await putNew("o", "fees", s("mine"))).toBeTruthy();
  });
});

describe("sync", () => {
  it("everything the first time, then only what changed", async () => {
    const { put, sync } = await db();
    for (const id of ["a", "b", "c"]) await put("o", "projects", { id, title: id });
    await put("other", "projects", { id: "x", title: "theirs" });
    const first = await sync("o", "projects", {});
    expect(first.rows.map((r) => r.record)).toEqual(["a", "b", "c"].map((id) => ({ id, title: id })));
    const known = Object.fromEntries(first.keys);
    expect((await sync("o", "projects", known)).rows).toEqual([]);
    await new Promise((r) => setTimeout(r, 2));
    await put("o", "projects", { id: "b", title: "b2" });
    const next = await sync("o", "projects", known);
    expect(next.rows.map((r) => r.record)).toEqual([{ id: "b", title: "b2" }]);
    expect(next.keys).toHaveLength(3);
  });
  it("nothing changed: no record is read", async () => {
    const { put, sync } = await db();
    await put("o", "projects", { id: "a" });
    const known = Object.fromEntries((await sync("o", "projects", {})).keys);
    const calls = vi.fn(globalThis.fetch);
    vi.stubGlobal("fetch", calls);
    await sync("o", "projects", known);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(String(calls.mock.calls[0][0])).not.toContain("data");
  });
  it("schedules and fees still carry their version", async () => {
    const { put, sync } = await db();
    await put("o", "fees", { id: "a" });
    const [r] = (await sync("o", "fees", {})).rows;
    expect(r.record).toEqual({ id: "a", _v: r.v });
  });
});

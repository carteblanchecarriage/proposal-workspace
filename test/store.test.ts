// Loading and saving in the browser (src/store.ts), against a simulated server: a failure must never pass for
// "nothing saved", and a passing outage must never switch someone to saving in their browser only.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/auth", () => ({ authHeaders: async () => ({}), authHeadersNow: () => ({}), refreshAuth: async () => false }));
vi.mock("../src/api", () => ({ unauthorized: () => {} }));

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The server's answer to a load: these records of one table (and nothing in any other it asked for). */
const loaded = (rows: Record<string, unknown>[], init?: RequestInit) =>
  json(200, {
    tables: Object.fromEntries(
      Object.keys(JSON.parse(String(init?.body)).tables).map((t, i) => [t, { keys: i ? [] : rows.map((r) => [r.id, "v"]), rows: i ? [] : rows.map((r) => ({ key: r.id, v: "v", record: r })) }]),
    ),
  });

/** A fresh copy of the store (its "saving locally" switch starts off), with a simulated server and a banner spy. */
async function freshStore(server: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.resetModules();
  const fetch = vi.fn(async (url: string, init?: RequestInit) => server(url, init));
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const store = await import("../src/store");
  const banner = vi.fn();
  store.setLoadProblemHandler(banner);
  return { store, fetch, banner };
}

beforeEach(() => vi.unstubAllGlobals());

describe("loading lists", () => {
  it("returns what the server has, newest first", async () => {
    const { store, banner } = await freshStore((_, init) => loaded([{ id: "a", savedAt: 1 }, { id: "b", savedAt: 2 }], init));
    expect((await store.listProjects()).map((p) => p.id)).toEqual(["b", "a"]);
    expect(banner).not.toHaveBeenCalled();
  });

  it("a failed load raises the banner instead of passing as 'nothing saved'", async () => {
    const { store, banner } = await freshStore(() => json(500, { error: "Database error (500)." }));
    expect(await store.listProjects()).toEqual([]);
    expect(banner).toHaveBeenCalledWith("Database error (500).");
  });

  it("a lost connection says so in plain words", async () => {
    const { store, banner } = await freshStore(() => {
      throw new TypeError("Failed to fetch");
    });
    await store.listFees();
    expect(banner).toHaveBeenCalledWith(expect.stringMatching(/^Couldn't load: the server can't be reached/));
  });
});

describe("loading settings (strict: a failure must stop editing, not show defaults)", () => {
  it("a failed world view load throws, and raises the banner", async () => {
    const { store, banner } = await freshStore(() => json(502, {}));
    await expect(store.getWorldView()).rejects.toThrow(/Couldn't load \(the server returned 502\)/);
    expect(banner).toHaveBeenCalled();
  });

  it.each(["getScheduleStyle", "getFeeStyle", "getQualifications"] as const)("%s throws too", async (getter) => {
    const { store } = await freshStore(() => json(500, { error: "Database error (500)." }));
    await expect(store[getter]()).rejects.toThrow("Database error (500).");
  });

  it("nothing saved yet is not a failure: the defaults", async () => {
    const { store, banner } = await freshStore((_, init) => loaded([], init));
    await expect(store.getFeeStyle()).resolves.toMatchObject({ rounding: 1 });
    expect(banner).not.toHaveBeenCalled();
  });
});

describe("where saves go", () => {
  it("only the server's explicit 'no database here' switches to saving in the browser", async () => {
    const { store, fetch } = await freshStore(() => json(503, { error: "Database not configured.", storage: "browser" }));
    await store.listProjects();
    await store.listProjects();
    expect(fetch).toHaveBeenCalledTimes(1); // switched: the second load didn't ask the server
  });

  it("an outage's 503 is an error, and the next request still goes to the server", async () => {
    let down = true;
    const { store, fetch, banner } = await freshStore((_, init) => (down ? json(503, {}) : loaded([{ id: "p", savedAt: 1 }], init)));
    await expect(store.saveProject({ id: "p", savedAt: 1, name: "Library" })).rejects.toThrow(/Couldn't save \(the server returned 503\)/);
    expect(await store.listProjects()).toEqual([]);
    expect(banner).toHaveBeenCalled();
    down = false;
    expect((await store.listProjects()).map((p) => p.id)).toEqual(["p"]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("a failed save is reported, never swallowed", async () => {
    const { store } = await freshStore(() => json(500, { error: "Database error (500)." }));
    await expect(store.saveFee({ id: "f" } as never)).rejects.toThrow("Database error (500).");
  });
});

describe("loading only what's changed", () => {
  /** How many records each answer held. */
  const sent: number[] = [];
  /** A server with a few tables, answering as api/db.ts does; part: how many records fit in one answer. */
  const server = (tables: Record<string, Record<string, { v: string; record: object }>>, part = Infinity) => (_: string, init?: RequestInit) => {
    const asked = JSON.parse(String(init!.body)).tables as Record<string, Record<string, string>>;
    let left = part;
    let more = false;
    const out = Object.entries(asked).map(([t, known]) => {
      const all = Object.entries(tables[t] ?? {});
      const rows = all.filter(([k, x]) => known[k] !== x.v).filter(() => (left-- > 0 ? true : ((more = true), false)));
      return [t, { keys: all.map(([k, x]) => [k, x.v]), rows: rows.map(([key, x]) => ({ key, v: x.v, record: x.record })) }];
    });
    sent.push(out.reduce((n, [, t]) => n + (t as { rows: unknown[] }).rows.length, 0));
    return json(200, { tables: Object.fromEntries(out), more });
  };
  beforeEach(() => void (sent.length = 0));

  it("lists asked for together make one request", async () => {
    const { store, fetch } = await freshStore(server({ projects: { p: { v: "1", record: { id: "p", savedAt: 1 } } }, fees: { f: { v: "1", record: { id: "f", savedAt: 1 } } } }));
    const [ps, fs, a, b] = await Promise.all([store.listProjects(), store.listFees(), store.getFeeStyle(), store.getScheduleStyle()]);
    expect([ps.length, fs.length, a.rounding, b.colors]).toEqual([1, 1, 1, {}]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a second load is sent only what changed; what was deleted goes", async () => {
    const tables = { projects: { a: { v: "1", record: { id: "a", savedAt: 1, name: "A" } }, b: { v: "1", record: { id: "b", savedAt: 2, name: "B" } }, c: { v: "1", record: { id: "c", savedAt: 3, name: "C" } } } as Record<string, { v: string; record: object }> };
    const { store } = await freshStore(server(tables));
    await store.listProjects();
    tables.projects.b = { v: "2", record: { id: "b", savedAt: 2, name: "B2" } };
    delete tables.projects.c;
    expect((await store.listProjects()).map((p) => p.name)).toEqual(["B2", "A"]);
    await store.listProjects();
    expect(sent).toEqual([3, 1, 0]);
  });

  it("a table still being read for the first time isn't downloaded twice", async () => {
    const { store } = await freshStore(server({ projects: { a: { v: "1", record: { id: "a", savedAt: 1 } } } }));
    const first = store.listProjects();
    await new Promise((r) => setTimeout(r, 0));
    store.preload();
    const again = store.listProjects();
    expect((await first).length + (await again).length).toBe(2);
    expect(sent.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("each list is its own copy: changing one doesn't change the next", async () => {
    const { store } = await freshStore(server({ projects: { a: { v: "1", record: { id: "a", savedAt: 1, name: "A" } } } }));
    (await store.listProjects())[0].name = "changed on a page";
    expect((await store.listProjects())[0].name).toBe("A");
  });

  it("more than fits in one answer is read in parts", async () => {
    const projects = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`p${i}`, { v: "1", record: { id: `p${i}`, savedAt: i } }]));
    const { store, fetch } = await freshStore(server({ projects }, 3));
    expect(await store.listProjects()).toHaveLength(7);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("a server that always says there's more is given up on", async () => {
    const { store, fetch, banner } = await freshStore((_, init) => loaded([], init));
    fetch.mockImplementation(async () => json(200, { tables: {}, more: true }));
    await store.listProjects();
    expect(banner).toHaveBeenCalledWith(expect.stringMatching(/too much to read/));
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(50);
  });

  it("signed out: what was loaded isn't kept for whoever signs in next", async () => {
    const tables = { projects: { a: { v: "1", record: { id: "a", savedAt: 1 } } } };
    const answer = server(tables);
    const { store, fetch } = await freshStore(answer);
    await store.listProjects();
    fetch.mockImplementationOnce(async () => json(401, {}));
    await store.listProjects();
    await store.listProjects();
    expect(JSON.parse(String(fetch.mock.calls.at(-1)![1]!.body)).tables.projects).toEqual({});
  });
});

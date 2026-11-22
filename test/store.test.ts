// Loading and saving in the browser (src/store.ts), against a simulated server: a failure must never pass for
// "nothing saved", and a passing outage must never switch someone to saving in their browser only.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/auth", () => ({ authHeaders: async () => ({}), authHeadersNow: () => ({}), refreshAuth: async () => false }));
vi.mock("../src/api", () => ({ unauthorized: () => {} }));

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
    const { store, banner } = await freshStore(() => json(200, [{ id: "a", savedAt: 1 }, { id: "b", savedAt: 2 }]));
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
    const { store, banner } = await freshStore(() => json(200, []));
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
    const { store, fetch, banner } = await freshStore(() => (down ? json(503, {}) : json(200, [{ id: "p", savedAt: 1 }])));
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

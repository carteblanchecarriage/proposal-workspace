// Saving fees (src/fee-sync.ts): nothing unsaved is lost, and two people on the same fee never overwrite each other.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedFee } from "../src/store";
import { workedExample } from "./fixtures";

const db = vi.hoisted(() => ({ row: null as any, n: 0, fail: false, hold: null as null | Promise<void>, ask: "mine" as any, asked: [] as any[], keep: false, log: [] as string[] }));
vi.mock("../src/store", () => ({
  listFees: async () => (db.row ? [structuredClone(db.row)] : []),
  feeVersion: async () => db.row?._v ?? null,
  fetchFee: async () => structuredClone(db.row),
  saveFeeFrom: async (f: any, base?: string) => {
    db.log.push("start");
    await db.hold;
    if (db.fail) throw new Error("offline");
    if (base && db.row?._v !== base) return { conflict: true, record: structuredClone(db.row) };
    db.row = { ...structuredClone(f), _v: `v${++db.n}` };
    db.log.push("end");
    return { version: db.row._v };
  },
}));
vi.mock("../src/schedule/lib/conflict.js", () => ({
  askConflicts: async (_: string, c: any[]) => (db.asked.push(c), db.ask && Object.fromEntries(c.map((x: any) => [x.key, db.ask]))),
  askDeleted: async () => db.keep,
}));

let sync: typeof import("../src/fee-sync");
let fee: SavedFee | null;
let undo: SavedFee[];
let errors: string[];
let listeners: Record<string, () => void>;
beforeEach(async () => {
  vi.resetModules();
  vi.useRealTimers();
  Object.assign(db, { row: { ...workedExample(), _v: "v0" }, n: 0, fail: false, hold: null, ask: "mine", asked: [], keep: false, log: [] });
  listeners = {};
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => {} });
  vi.stubGlobal("addEventListener", (e: string, fn: () => void) => (listeners[e] = fn));
  sync = await import("../src/fee-sync");
  fee = null;
  undo = [];
  errors = [];
  sync.setFeeHooks({
    open: () => fee,
    adopt: (merged, rebase) => ((fee = merged), (undo = undo.map(rebase))),
    gone: () => (fee = null),
    error: (m) => void errors.push(m),
    notice: () => {},
    typing: () => false,
  });
  fee = (await sync.loadFees())[0];
});
const edit = (fn: (f: SavedFee) => void) => {
  undo.push(structuredClone(fee!));
  fn(fee!);
  sync.queueFee(fee!);
};
const other = (fn: (f: SavedFee) => void) => {
  fn(db.row);
  db.row._v = `v${++db.n}`;
};
const settle = async () => {
  await sync.flushFees();
  await sync.flushFees();
};

describe("not losing anything", () => {
  it("a failed save is kept and sent again", async () => {
    db.fail = true;
    edit((f) => (f.title = "New"));
    await sync.flushFees();
    expect(errors.at(-1)).toBe("offline");
    db.fail = false;
    await sync.flushFees();
    expect(db.row.title).toBe("New");
    expect(errors.at(-1)).toBe("");
  });

  it("saves go one at a time, the newest last", async () => {
    let go!: () => void;
    db.hold = new Promise((r) => (go = r));
    edit((f) => (f.title = "One"));
    const a = sync.flushFees();
    edit((f) => (f.title = "Two"));
    const b = sync.flushFees();
    go();
    await Promise.all([a, b]);
    expect(db.log).toEqual(["start", "end", "start", "end"]);
    expect(db.row.title).toBe("Two");
  });

  it("leaving and coming back while a save is under way shows the edit", async () => {
    let go!: () => void;
    db.hold = new Promise((r) => (go = r));
    edit((f) => (f.title = "New"));
    const saving = sync.flushFees();
    fee = null;
    expect((await sync.loadFees())[0].title).toBe("New");
    go();
    await saving;
  });

  it("a fee deleted here is never saved again", async () => {
    edit((f) => (f.title = "New"));
    sync.forgetFee(fee!.id);
    db.row = null;
    await settle();
    expect(db.row).toBeNull();
  });
});

describe("two people on one fee", () => {
  it("keeps both: hours for different roles on the same task, and a consultant's fee", async () => {
    edit((f) => (f.phases[0].tasks[0].hours.pr = 99));
    other((f) => {
      f.phases[0].tasks[0].hours.pa = 77;
      f.consultants[0].byPhase.dd = 1234;
    });
    await settle();
    expect(db.row.phases[0].tasks[0].hours).toEqual({ pr: 99, pa: 77 });
    expect(db.row.consultants[0].byPhase.dd).toBe(1234);
    expect(fee!.consultants[0].byPhase.dd).toBe(1234);
    expect(db.asked).toEqual([]);
  });

  it("keeps rows each added, and rows removed stay removed", async () => {
    edit((f) => {
      f.phases[0].tasks.push({ id: "mine", name: "Mine", hours: {} });
      f.consultants = f.consultants.filter((c) => c.id !== "c2");
    });
    other((f) => f.phases[0].tasks.push({ id: "theirs", name: "Theirs", hours: {} }));
    await settle();
    expect(db.row.phases[0].tasks.map((t: any) => t.id)).toEqual(["t1", "t2", "mine", "theirs"]);
    expect(db.row.consultants.map((c: any) => c.id)).toEqual(["c1"]);
  });

  it.each([["mine", 250], ["theirs", 300]])("the same rate changed twice asks: keeping %s", async (side, rate) => {
    edit((f) => (f.roles[0].rate = 250));
    other((f) => (f.roles[0].rate = 300));
    db.ask = side;
    await settle();
    expect(db.asked[0]).toHaveLength(1);
    expect(db.row.roles[0].rate).toBe(rate);
    expect(fee!.roles[0].rate).toBe(rate);
  });

  it("closing the question saves nothing and loses nothing", async () => {
    edit((f) => (f.roles[0].rate = 250));
    other((f) => (f.roles[0].rate = 300));
    db.ask = null;
    await sync.flushFees();
    expect([db.row.roles[0].rate, fee!.roles[0].rate]).toEqual([300, 250]);
    db.ask = "mine";
    edit((f) => (f.title = "T"));
    await settle();
    expect(db.row).toMatchObject({ title: "T", roles: [{ rate: 250 }, {}] });
  });

  it("Undo reverses only this tab's change", async () => {
    edit((f) => (f.title = "Mine"));
    other((f) => (f.markupPercent = 15));
    await settle();
    expect(undo[0]).toMatchObject({ title: "Test fee", markupPercent: 15 });
  });

  it("marked final here while someone changed a number: a draft, not a final nobody marked", async () => {
    edit((f) => Object.assign(f, { status: "final", finalAt: 5 }));
    other((f) => (f.roles[0].rate = 300));
    await settle();
    expect(db.row).toMatchObject({ status: "draft", roles: [{ rate: 300 }, {}] });
    expect(db.row.finalAt).toBeUndefined();
  });

  it("marked final with nothing else changed stays final", async () => {
    edit((f) => Object.assign(f, { status: "final", finalAt: 5 }));
    other(() => {});
    await settle();
    expect(db.row).toMatchObject({ status: "final", finalAt: 5 });
  });

  it("an open fee takes in someone else's save on coming back to the tab", async () => {
    sync.watchFees();
    other((f) => (f.title = "Theirs"));
    listeners.focus();
    await vi.waitFor(() => expect(fee!.title).toBe("Theirs"));
    edit((f) => (f.markupPercent = 12)); // and saves on from there without asking
    await settle();
    expect(db.row).toMatchObject({ title: "Theirs", markupPercent: 12 });
  });

  it("deleted by someone else: saved again only if asked", async () => {
    edit((f) => (f.title = "New"));
    db.row = null;
    db.keep = true;
    await settle();
    expect(db.row.title).toBe("New");
    edit((f) => (f.title = "Newer"));
    db.row = null;
    db.keep = false;
    await settle();
    expect(db.row).toBeNull();
    expect(fee).toBeNull();
  });
});

describe("a role removed on one side", () => {
  const remove = (f: SavedFee, id: string) => {
    f.roles = f.roles.filter((r) => r.id !== id);
    for (const p of f.phases) for (const t of p.tasks) delete t.hours[id];
  };
  const hours = () => db.row.phases.flatMap((p: any) => p.tasks.map((t: any) => t.hours));

  it("takes its hours with it, and keeps the other side's work", async () => {
    edit((f) => remove(f, "pr"));
    other((f) => (f.phases[0].tasks[0].hours.pa = 77));
    await settle();
    expect(db.asked).toEqual([]);
    expect(db.row.roles.map((r: any) => r.id)).toEqual(["pa"]);
    expect(hours()).toEqual([{ pa: 77 }, { pa: 20 }, { pa: 60 }]);
  });

  it.each([
    ["mine", ["pa"], [{ pa: 40 }, { pa: 20 }, { pa: 60 }]],
    ["theirs", ["pr", "pa"], [{ pr: 99, pa: 40 }, { pa: 20 }, { pr: 5, pa: 60 }]],
  ])("asks once when the other side changed its hours: %s", async (side, roles, left) => {
    edit((f) => remove(f, "pr"));
    other((f) => (f.phases[0].tasks[0].hours.pr = 99));
    db.ask = side;
    await settle();
    expect(db.asked).toHaveLength(1);
    expect(db.asked[0]).toHaveLength(1);
    expect(db.row.roles.map((r: any) => r.id).sort()).toEqual([...roles].sort());
    expect(hours()).toEqual(left);
    expect(JSON.stringify(db.row)).not.toContain("_hours");
  });
});

it("a fee deleted and made again for the project is never combined with the old one", async () => {
  edit((f) => (f.title = "Old fee's edit"));
  db.row = { ...workedExample(), title: "New fee", createdAt: 999, _v: "n1" };
  await settle();
  expect(db.row.title).toBe("New fee");
  expect(fee).toBeNull();
});

it("a server that refuses every save is given up on, not asked forever", async () => {
  edit((f) => (f.title = "Mine"));
  for (let i = 0; i < 20; i++) {
    db.row._v = `x${i}`;
    await sync.flushFees();
  }
  expect(errors.some((e) => /keeps changing/.test(e))).toBe(true);
  expect(fee!.title).toBe("Mine"); // still here to save
});

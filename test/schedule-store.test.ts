// The schedule store (src/schedule/lib/stores/projects.js): what the assistant can't do to a schedule's dates, the
// repairs made on loading, and edits that survive leaving and coming back while they're being saved.
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], land: null as null | (() => void), hold: false, n: 0, loseAnswer: false, ask: null as any, asked: [] as any[], askDeleted: false }));
vi.mock("../src/store", () => ({
  listSchedules: async () => structuredClone(db.rows),
  // As the server does it: refused when the row isn't the version the edit started from.
  saveScheduleFrom: async (s: Record<string, unknown>, base?: string) => {
    if (db.hold) await new Promise<void>((r) => (db.land = r));
    if (base && db.rows[0]?._v !== base) return { conflict: true, record: structuredClone(db.rows[0] ?? null) };
    const _v = `v${++db.n}`;
    db.rows = [{ ...structuredClone(s), _v }];
    if (db.loseAnswer) throw new Error("lost");
    return { version: _v };
  },
  scheduleVersion: async () => (db.rows[0]?._v as string) ?? null,
  fetchSchedule: async () => structuredClone(db.rows[0] ?? null),
  deleteSchedule: async () => {},
}));
vi.mock("../src/schedule/lib/conflict.js", () => ({
  askConflicts: async (_: string, c: any[]) => (db.asked.push(c), db.ask && Object.fromEntries(c.map((x) => [x.key, db.ask]))),
  askDeleted: async () => db.askDeleted,
}));
import { clearHistory, flushSaves, projectStore } from "../src/schedule/lib/stores/projects.js";

// The store is JavaScript; tests use it untyped.
const store = projectStore as any;
let now: any;
store.subscribe((v: any[]) => (now = v[0]));
const schedule = (over = {}) => ({
  id: "s",
  savedAt: 1,
  colorVersion: 2,
  viewStart: "2027-01-01",
  viewEnd: "2027-12-01",
  tasks: [
    { id: 1, name: "Bar", type: "bar", start: "2027-02-01", end: "2027-03-01", color: "#00914D" },
    { id: 2, name: "Dot", type: "milestone", date: "2027-02-03" },
  ],
  legend: { deliverables: [{ text: "A", date: "2027-02-03" }], milestones: [], estimates: [], approvals: [] },
  ...over,
});
const load = async (over = {}) => {
  db.rows = [{ ...schedule(over), _v: `v${++db.n}` }];
  await store.init(true);
};
beforeEach(async () => {
  db.hold = db.loseAnswer = db.askDeleted = false;
  db.ask = "mine";
  db.asked = [];
  clearHistory("s");
  await flushSaves();
  await load();
});

describe("the assistant's changes", () => {
  it.each([
    ["a reversed view", { type: "updateView", patch: { viewStart: "2029-01-01" } }],
    ["a view centuries long", { type: "updateView", patch: { viewEnd: "2527-01-01" } }],
    ["a bar without dates", { type: "addTask", task: { name: "X", type: "bar" } }],
    ["a date that isn't one", { type: "updateTask", taskId: 2, patch: { date: "TBD" } }],
    ["a day that doesn't exist", { type: "updateTask", taskId: 1, patch: { end: "2027-02-31" } }],
    ["clearing a date", { type: "updateTask", taskId: 2, patch: { date: null } }],
    ["an end before the start", { type: "updateTask", taskId: 1, patch: { end: "2026-01-01" } }],
    ["a legend date that isn't one", { type: "updateLegendItem", section: "deliverables", index: 0, patch: { date: "TBD" } }],
    ["a legend date that isn't text", { type: "updateLegendItem", section: "deliverables", index: 0, patch: { date: 5 } }],
  ])("skips %s", (_, change) => {
    const before = structuredClone(now);
    expect(store.applyChanges("s", [change])).toEqual({ applied: 0, skipped: 1 });
    expect(now).toEqual(before);
  });

  it("applies ordinary ones", () => {
    const r = store.applyChanges("s", [
      { type: "updateView", patch: { viewEnd: "2028-12-01" } },
      { type: "updateTask", taskId: 1, patch: { start: "2027-04-01", end: "2027-05-01" } },
      { type: "addTask", task: { name: "X", type: "milestone", date: "2027-06-02" } },
      { type: "updateLegendItem", section: "deliverables", index: 0, patch: { date: "2027-06-02" } },
    ]);
    expect(r).toEqual({ applied: 4, skipped: 0 });
  });

  it("a bar made a milestone goes at its end", () => {
    store.applyChanges("s", [{ type: "updateTask", taskId: 1, patch: { type: "milestone" } }]);
    expect(now.tasks[0]).toMatchObject({ type: "milestone", date: "2027-03-01" });
  });
});

describe("loading", () => {
  it.each([
    ["reversed", "2029-01-01", "2027-01-01"],
    ["centuries long", "2027-01-01", "20270-01-01"],
    ["missing", undefined, undefined],
  ])("a %s view is set from the tasks", async (_, viewStart, viewEnd) => {
    await load({ viewStart, viewEnd });
    expect(now).toMatchObject({ viewStart: "2027-01-01", viewEnd: "2027-04-01" });
  });

  it("a good view is left alone", () => expect(now).toMatchObject({ viewStart: "2027-01-01", viewEnd: "2027-12-01" }));

  it("hints saved as text are cleared; real text is kept", async () => {
    await load({ date: "Date", client: "Client", number: "24-017" });
    expect(now).toMatchObject({ date: "", client: "", number: "24-017" });
  });

  it("an edit being saved isn't replaced by the older saved version", async () => {
    db.hold = true;
    store.updateProject("s", { title: "NEW" });
    const saving = flushSaves();
    await vi.waitFor(() => expect(db.land).toBeTruthy());
    await store.init(true);
    expect(now.title).toBe("NEW");
    db.land!();
    await saving;
  });
});

describe("someone else saving the same schedule", () => {
  /** Another tab's save, landing before this tab's. */
  const other = (fn: (s: any) => void) => {
    const s: any = structuredClone(db.rows[0]);
    fn(s);
    db.rows = [{ ...s, savedBy: "another tab", _v: `v${++db.n}` }];
  };
  // The save, then the combined one.
  const settle = async () => {
    await flushSaves();
    await flushSaves();
  };
  const saved = () => db.rows[0] as any;

  it("keeps both people's changes to different tasks", async () => {
    store.updateTask("s", 1, { name: "Mine" });
    other((s) => (s.tasks[1].name = "Theirs"));
    await settle();
    expect(saved().tasks.map((t: any) => t.name)).toEqual(["Mine", "Theirs"]);
    expect(now.tasks).toEqual(saved().tasks);
    expect(db.asked).toEqual([]);
  });

  it("keeps both people's changes to different parts of one task", async () => {
    store.updateTask("s", 1, { name: "Mine" });
    other((s) => Object.assign(s.tasks[0], { start: "2027-05-01", end: "2027-06-01" }));
    await settle();
    expect(saved().tasks[0]).toMatchObject({ name: "Mine", start: "2027-05-01", end: "2027-06-01" });
  });

  it("a start from one side and an end from the other is asked about, never combined", async () => {
    store.updateTask("s", 1, { start: "2027-02-20" });
    other((s) => (s.tasks[0].end = "2027-02-10"));
    db.ask = "theirs";
    await settle();
    expect(db.asked[0]).toHaveLength(1);
    expect(saved().tasks[0]).toMatchObject({ start: "2027-02-01", end: "2027-02-10" });
  });

  it.each([["mine", "Mine"], ["theirs", "Theirs"]])("the same thing changed twice: keeping %s", async (side, name) => {
    store.updateTask("s", 1, { name: "Mine" });
    other((s) => (s.tasks[0].name = "Theirs"));
    db.ask = side;
    await settle();
    expect(db.asked[0]).toMatchObject([{ label: "“Bar”: name", mine: { name: "Mine" }, theirs: { name: "Theirs" } }]);
    expect(saved().tasks[0].name).toBe(name);
  });

  it("closing the question saves nothing and loses nothing; the next change asks again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    store.updateTask("s", 1, { name: "Mine" });
    other((s) => (s.tasks[0].name = "Theirs"));
    db.ask = null;
    await flushSaves();
    expect([saved().tasks[0].name, now.tasks[0].name]).toEqual(["Theirs", "Mine"]);
    db.ask = "mine";
    store.updateTask("s", 2, { name: "Dot 2" });
    await settle();
    expect(saved().tasks.map((t: any) => t.name)).toEqual(["Mine", "Dot 2"]);
  });

  it("both adding a task with the same number keeps both", async () => {
    store.addTask("s", { id: 3, name: "Mine", type: "milestone", date: "2027-03-03" });
    other((s) => s.tasks.push({ id: 3, name: "Theirs", type: "milestone", date: "2027-03-03" }));
    await settle();
    expect(saved().tasks.map((t: any) => t.name).sort()).toEqual(["Bar", "Dot", "Mine", "Theirs"]);
    expect(new Set(saved().tasks.map((t: any) => t.id)).size).toBe(4);
    store.undo("s");
    expect(now.tasks.map((t: any) => t.name)).toEqual(["Bar", "Dot", "Theirs"]);
  });

  it("Undo reverses my change and keeps theirs", async () => {
    store.updateTask("s", 1, { name: "Mine" });
    other((s) => (s.tasks[1].name = "Theirs"));
    await settle();
    store.undo("s");
    await settle();
    expect(saved().tasks.map((t: any) => t.name)).toEqual(["Bar", "Theirs"]);
  });

  it("a task I deleted stays deleted unless they changed it, which asks", async () => {
    store.deleteTask("s", 2);
    other((s) => (s.tasks[0].name = "Theirs"));
    await settle();
    expect(saved().tasks.map((t: any) => t.name)).toEqual(["Theirs"]);
    store.deleteTask("s", 1);
    other((s) => (s.tasks[0].name = "Theirs 2"));
    db.ask = "theirs";
    await settle();
    expect(saved().tasks.map((t: any) => t.name)).toEqual(["Theirs 2"]);
  });

  it("my reordering and their new task are both kept", async () => {
    store.reorderTasks("s", 0, 1);
    other((s) => s.tasks.push({ id: 9, name: "Theirs", type: "milestone", date: "2027-03-03" }));
    await settle();
    expect(saved().tasks.map((t: any) => t.name)).toEqual(["Dot", "Theirs", "Bar"]);
  });

  it("legend items are told apart even when a date change re-sorts them", async () => {
    await load({ legend: { deliverables: [{ text: "A", date: "2027-02-03" }, { text: "B", date: "2027-03-03" }], milestones: [], estimates: [], approvals: [] } });
    store.updateLegendItem("s", "deliverables", 0, { date: "2027-05-05" });
    other((s) => (s.legend.deliverables[0].text = "A renamed"));
    await settle();
    expect(saved().legend.deliverables.map((d: any) => [d.text, d.date])).toEqual([["B", "2027-03-03"], ["A renamed", "2027-05-05"]]);
  });

  it("a save whose answer was lost isn't mistaken for someone else's", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.loseAnswer = true;
    store.updateTask("s", 1, { name: "One" });
    await flushSaves();
    db.loseAnswer = false;
    store.updateTask("s", 1, { name: "Two" });
    await settle();
    expect(db.asked).toEqual([]);
    expect(saved().tasks[0].name).toBe("Two");
  });

  it("a schedule they deleted is saved again only if I say so", async () => {
    store.updateTask("s", 1, { name: "Mine" });
    db.rows = [];
    db.askDeleted = true;
    await settle();
    expect(saved().tasks[0].name).toBe("Mine");
    store.updateTask("s", 1, { name: "Mine 2" });
    db.rows = [];
    db.askDeleted = false;
    await settle();
    expect(db.rows).toEqual([]);
    expect(now).toBeUndefined();
  });

  it("the server's version is never stored in the schedule", async () => {
    store.updateTask("s", 1, { name: "Mine" });
    expect("_v" in now).toBe(false);
  });
});

// Dates that aren't real days, or are centuries away, must never reach a timeline (which draws a column per month).
import { describe, expect, it, vi } from "vitest";
import { isDay, isView } from "../lib/dates";
import { scheduleSnapshotHtml } from "../src/schedule-snapshot";

vi.mock("../src/schedule/lib/palette.js", () => ({ buildColorMap: () => new Map(), fontStack: () => "", loadFont: () => {}, paint: (c: string) => c }));

describe("isDay", () => {
  it.each(["2027-01-31", "2028-02-29", "1990-01-01", "2100-12-31"])("%s", (s) => expect(isDay(s)).toBe(true));
  it.each(["2027-02-29", "2027-13-01", "2027-00-10", "0202-01-05", "9999-01-01", "20270-01-05", "2027-1-5", "", "TBD", null, undefined, 5, {}])("not %s", (s) => expect(isDay(s)).toBe(false));
  it("a view: in order, and no longer than thirty years", () => {
    expect(isView("2027-01-01", "2028-01-01")).toBe(true);
    expect(isView("2028-01-01", "2027-01-01")).toBe(false);
    expect(isView("2027-01-01", "2099-01-01")).toBe(false);
  });
});

describe("the project page's schedule snapshot", () => {
  const snap = (over: object) => scheduleSnapshotHtml({ id: "s", savedAt: 0, tasks: [{ id: 1, name: "A", type: "bar", start: "2027-01-05", end: "2027-03-01" }], ...over } as never);
  const months = (html: string) => html.match(/snap-grid/g)?.length ?? 0;
  it("an ordinary schedule draws", () => expect(months(snap({ viewStart: "2027-01-01", viewEnd: "2027-12-01" }))).toBe(12));
  it.each([
    ["a view to the year 9999", { viewEnd: "9999-01-01" }],
    ["a task mistyped as the year 0202", { tasks: [{ id: 1, name: "A", type: "bar", start: "0202-01-05", end: "2027-03-01" }, { id: 2, name: "B", type: "milestone", date: "2027-03-01" }] }],
    ["a task a lifetime away", { tasks: [{ id: 1, name: "A", type: "bar", start: "2027-01-05", end: "2099-03-01" }] }],
  ])("%s draws at most thirty years", (_, over) => expect(months(snap(over))).toBeLessThanOrEqual(372));
  it("nothing with a real date draws nothing", () => expect(snap({ tasks: [{ id: 1, type: "bar", start: "2027-13-45", end: "TBD" }] })).toBe(""));
});

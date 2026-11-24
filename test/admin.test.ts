// The site owner's activity page (lib/admin.ts): who may open it, and the numbers it shows. The database is replaced
// with fixed rows, so the tests check the arithmetic, the billing-period windows and the flags.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rows: Record<string, unknown[]> = {};
vi.mock("../lib/db.js", () => ({
  query: vi.fn(async (path: string) => {
    const table = path.split("?")[0];
    // "Last active" asks for every call, newest first; the window query, oldest first from a date.
    if (table === "usage_events") {
      const events = rows.usage_events as { created_at: string }[];
      const from = /created_at=gte\.([^&]+)/.exec(path)?.[1];
      const since = from ? decodeURIComponent(from) : "";
      const list = events.filter((e) => e.created_at >= since);
      const asc = [...list].sort((a, b) => a.created_at.localeCompare(b.created_at));
      return path.includes("order=created_at.desc") ? asc.reverse() : asc;
    }
    return rows[table] ?? [];
  }),
}));

const { adminOverview, isAdmin } = await import("../lib/admin");
const { usageFor } = await import("../lib/admin-usage");

const NOW = new Date("2026-11-21T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe("isAdmin", () => {
  beforeEach(() => vi.stubEnv("ADMIN_EMAILS", "owner@example.com, Second@Example.com"));
  afterEach(() => vi.unstubAllEnvs());
  it("only the listed emails, ignoring case and spaces", () => {
    expect(isAdmin("owner@example.com")).toBe(true);
    expect(isAdmin("SECOND@example.com")).toBe(true);
    expect(isAdmin("someone@example.com")).toBe(false);
  });
  it("nobody when signed out, or when the list is empty", () => {
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin("")).toBe(false);
    vi.stubEnv("ADMIN_EMAILS", "");
    expect(isAdmin("owner@example.com")).toBe(false);
  });
});

describe("adminOverview", () => {
  beforeEach(() => {
    rows.organizations = [
      // On a $20 allowance, calendar month: $17 this month (85%), plus $50 last month that mustn't count.
      { id: "firm", name: "Firm", plan: "owner", created_at: daysAgo(60), ai_monthly_limit_usd: 20, subscription_status: null, current_period_start: null },
      // Paying: its window is its billing period (from the 10th), not the month.
      { id: "paid", name: "Paid", plan: "pro", created_at: daysAgo(40), ai_monthly_limit_usd: 40, subscription_status: "past_due", current_period_start: "2026-11-10T00:00:00Z" },
      // Signed up, no allowance, never used AI.
      { id: "new", name: "New", plan: "free", created_at: daysAgo(2), ai_monthly_limit_usd: 0, subscription_status: null, current_period_start: null },
      // No limit, last active long ago.
      { id: "old", name: "Old", plan: "owner", created_at: daysAgo(200), ai_monthly_limit_usd: null, subscription_status: null, current_period_start: null },
    ];
    rows.org_members = [{ org_id: "firm" }, { org_id: "firm" }, { org_id: "paid" }, { org_id: "new" }, { org_id: "old" }];
    rows.usage_events = [
      { org_id: "firm", endpoint: "/api/rfp", cost_usd: 10, created_at: daysAgo(1) },
      { org_id: "firm", endpoint: "/api/chat", cost_usd: 7, created_at: daysAgo(3) },
      { org_id: "firm", endpoint: "/api/chat", cost_usd: 50, created_at: "2026-10-25T12:00:00Z" },
      { org_id: "paid", endpoint: "/api/fee-draft", cost_usd: 5, created_at: "2026-11-05T12:00:00Z" }, // before its period
      { org_id: "paid", endpoint: "/api/fee-draft", cost_usd: 6, created_at: "2026-11-12T12:00:00Z" },
      { org_id: "old", endpoint: "/api/rfp", cost_usd: null, created_at: daysAgo(100) }, // a call with no price
    ];
  });

  it("works out each organization's period, cost and percent of its allowance", async () => {
    const o = await adminOverview(NOW);
    const byId = Object.fromEntries(o.orgs.map((x) => [x.id, x]));
    expect(byId.firm).toMatchObject({ calls: 2, costUsd: 17, limitUsd: 20, members: 2 });
    expect(byId.firm.percent).toBeCloseTo(85, 10);
    expect(byId.paid).toMatchObject({ calls: 1, costUsd: 6, percent: 15 });
    expect(byId.new).toMatchObject({ calls: 0, costUsd: 0, percent: null, lastActive: null });
    expect(byId.old).toMatchObject({ limitUsd: null, percent: 0 }); // no limit: a percent of the $100 safeguard
  });

  it("flags what needs attention", async () => {
    const byId = Object.fromEntries((await adminOverview(NOW)).orgs.map((x) => [x.id, x.flags]));
    expect(byId.firm).toEqual(["near limit"]);
    expect(byId.paid).toEqual(["past due"]);
    expect(byId.new).toEqual(["AI off"]);
    expect(byId.old).toEqual(["quiet"]);
  });

  it("lists the most recently active first, never-active last", async () => {
    expect((await adminOverview(NOW)).orgs.map((x) => x.id)).toEqual(["firm", "paid", "old", "new"]);
  });

  it("summarizes this calendar month, and counts features by endpoint", async () => {
    const o = await adminOverview(NOW);
    expect(o.summary).toEqual({ orgs: 4, people: 5, active7: 1, callsMonth: 4, costMonth: 28 });
    expect(o.features).toEqual([
      { endpoint: "/api/fee-draft", calls: 2, costUsd: 11 },
      { endpoint: "/api/rfp", calls: 1, costUsd: 10 }, // a tie on calls: the costlier first
      { endpoint: "/api/chat", calls: 1, costUsd: 7 },
    ]);
  });

  it("gives 30 days of activity, oldest first, ending today", async () => {
    const o = await adminOverview(NOW);
    expect(o.days).toHaveLength(30);
    expect(o.days.at(-1)?.date).toBe("2026-11-21");
    expect(o.days.find((d) => d.date === "2026-11-20")).toMatchObject({ calls: 1, costUsd: 10 });
    expect(o.days.reduce((s, d) => s + d.calls, 0)).toBe(5); // the October call is 27 days back; the 100-day one isn't
  });

  it("breaks usage down by organization, so the owner's own testing can be left out", async () => {
    const o = await adminOverview(NOW, "firm");
    expect(o.yourOrgId).toBe("firm");
    // Everyone: the same totals as the summary.
    const all = usageFor(o, () => true);
    expect([all.callsMonth, all.costMonth]).toEqual([o.summary.callsMonth, o.summary.costMonth]);
    expect(all.days.map((d) => d.calls)).toEqual(o.days.map((d) => d.calls));
    // All but the owner's: only the paying firm's two calls this month.
    const others = usageFor(o, (id) => id !== "firm");
    expect([others.callsMonth, others.costMonth]).toEqual([2, 11]);
    expect(others.features).toEqual([{ endpoint: "/api/fee-draft", calls: 2, costUsd: 11 }]);
    expect(others.days.reduce((s, d) => s + d.calls, 0)).toBe(2);
    // One organization.
    const firm = usageFor(o, (id) => id === "firm");
    expect(firm.features.map((f) => f.endpoint)).toEqual(["/api/rfp", "/api/chat"]);
    expect(firm.days.find((d) => d.date === "2026-11-20")).toMatchObject({ calls: 1, costUsd: 10 });
  });

  it("counts what each organization has made, without opening any of it", async () => {
    rows.projects = [{ org_id: "firm" }, { org_id: "firm" }, { org_id: "paid" }];
    rows.rfp_reviews = [{ org_id: "firm" }];
    rows.fees = [{ org_id: "paid" }];
    const byId = Object.fromEntries((await adminOverview(NOW)).orgs.map((x) => [x.id, x.made]));
    expect(byId.firm).toEqual({ projects: 2, reviews: 1, fees: 0, schedules: 0, comparisons: 0 });
    expect(byId.paid).toEqual({ projects: 1, reviews: 0, fees: 1, schedules: 0, comparisons: 0 });
    expect(byId.new).toEqual({ projects: 0, reviews: 0, fees: 0, schedules: 0, comparisons: 0 });
    const { query } = await import("../lib/db.js");
    // Only each record's organization is asked for: never its (encrypted) data.
    for (const [path] of (query as unknown as { mock: { calls: [string][] } }).mock.calls)
      if (/^(projects|rfp_reviews|fees|schedules|comparisons)\?/.test(path)) expect(path).toMatch(/select=org_id&/);
    delete rows.projects;
    delete rows.rfp_reviews;
    delete rows.fees;
  });
});

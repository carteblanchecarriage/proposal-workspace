import { query } from "./db.js";
import { sortFeatures } from "./admin-usage.js";

// The site owner's activity page (#admin): every organization's plan, members and AI use, and the site's activity
// over the last 30 days. Account and usage data only: nothing from inside an organization's records (those are
// encrypted per organization), and people as counts, never email addresses.
//
//   ADMIN_EMAILS   comma-separated emails that may open it (checked on the server for every request)

/** Whether this signed-in email may open the activity page. */
export function isAdmin(email: string | null | undefined): boolean {
  const e = (email ?? "").trim().toLowerCase();
  if (!e) return false;
  return (process.env.ADMIN_EMAILS ?? "").split(",").some((x) => x.trim().toLowerCase() === e);
}

type OrgRow = {
  id: string;
  name: string;
  plan: string;
  created_at: string;
  ai_monthly_limit_usd: number | null;
  subscription_status: string | null;
  current_period_start: string | null;
};
type UsageRow = { org_id: string; endpoint: string | null; cost_usd: number | null; created_at: string };

export type AdminOrg = {
  id: string;
  name: string;
  plan: string;
  status: string | null;
  members: number;
  createdAt: string;
  lastActive: string | null;
  /** this AI window's (billing period, else calendar month) calls and cost */
  calls: number;
  costUsd: number;
  /** null: no limit */
  limitUsd: number | null;
  /** percent of the allowance used; null with no limit or a zero allowance */
  percent: number | null;
  flags: ("near limit" | "at limit" | "past due" | "quiet" | "AI off")[];
};

export type AdminOverview = {
  generatedAt: string;
  summary: { orgs: number; people: number; active7: number; callsMonth: number; costMonth: number };
  orgs: AdminOrg[];
  /** the last 30 days, oldest first */
  days: { date: string; calls: number; costUsd: number }[];
  /** this calendar month, by endpoint, most used first */
  features: { endpoint: string; calls: number; costUsd: number }[];
  /** the signed-in owner's own organization, so the page can leave its testing out */
  yourOrgId: string | null;
  /**
   * The same usage, by organization, so the page can show any one of them, or all but the owner's: per day (the 30
   * days above, in the same order) and per feature this month.
   */
  byOrg: Record<string, { days: { calls: number; costUsd: number }[]; features: Record<string, { calls: number; costUsd: number }> }>;
};

const DAY = 86_400_000;
const PAYING = new Set(["active", "trialing", "past_due"]);

/** Everything on the activity page, worked out from three tables. */
export async function adminOverview(now = new Date(), yourOrgId: string | null = null): Promise<AdminOverview> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const since = new Date(now.getTime() - 30 * DAY);
  // Usage from whichever is earlier: 30 days back, or the start of the earliest window in use (a billing period).
  const [orgs, members] = await Promise.all([
    query<OrgRow[]>("organizations?select=id,name,plan,created_at,ai_monthly_limit_usd,subscription_status,current_period_start&limit=10000"),
    query<{ org_id: string }[]>("org_members?select=org_id&limit=100000"),
  ]);
  const windowOf = (o: OrgRow) =>
    PAYING.has(o.subscription_status ?? "") && o.current_period_start ? new Date(o.current_period_start) : monthStart;
  const from = new Date(Math.min(since.getTime(), monthStart.getTime(), ...orgs.map((o) => windowOf(o).getTime())));
  const usage = await query<UsageRow[]>(
    `usage_events?select=org_id,endpoint,cost_usd,created_at&created_at=gte.${encodeURIComponent(from.toISOString())}&order=created_at.asc&limit=100000`,
  );
  // The last call ever, per organization, for "last active" (one row each, newest first).
  const last = await query<{ org_id: string; created_at: string }[]>(
    "usage_events?select=org_id,created_at&order=created_at.desc&limit=100000",
  ).then((rows) => {
    const m = new Map<string, string>();
    for (const r of rows) if (!m.has(r.org_id)) m.set(r.org_id, r.created_at);
    return m;
  });

  const memberCount = new Map<string, number>();
  for (const m of members) memberCount.set(m.org_id, (memberCount.get(m.org_id) ?? 0) + 1);

  const cost = (u: UsageRow) => Number(u.cost_usd ?? 0);
  const rows: AdminOrg[] = orgs.map((o) => {
    const start = windowOf(o).getTime();
    const mine = usage.filter((u) => u.org_id === o.id && new Date(u.created_at).getTime() >= start);
    const costUsd = mine.reduce((s, u) => s + cost(u), 0);
    const limitUsd = o.ai_monthly_limit_usd == null ? null : Number(o.ai_monthly_limit_usd);
    const percent = limitUsd && limitUsd > 0 ? (costUsd / limitUsd) * 100 : null;
    const lastActive = last.get(o.id) ?? null;
    const flags: AdminOrg["flags"] = [];
    if (percent != null && percent >= 100) flags.push("at limit");
    else if (percent != null && percent >= 80) flags.push("near limit");
    if (o.subscription_status === "past_due") flags.push("past due");
    if (limitUsd === 0) flags.push("AI off");
    else if (!lastActive || now.getTime() - new Date(lastActive).getTime() > 14 * DAY) flags.push("quiet");
    return {
      id: o.id,
      name: o.name,
      plan: o.plan,
      status: o.subscription_status,
      members: memberCount.get(o.id) ?? 0,
      createdAt: o.created_at,
      lastActive,
      calls: mine.length,
      costUsd,
      limitUsd,
      percent,
      flags,
    };
  });
  // Most recently active first; never-active organizations last, newest first.
  rows.sort((a, b) => (b.lastActive ?? "").localeCompare(a.lastActive ?? "") || b.createdAt.localeCompare(a.createdAt));

  const days: AdminOverview["days"] = [];
  for (let i = 29; i >= 0; i--) days.push({ date: new Date(now.getTime() - i * DAY).toISOString().slice(0, 10), calls: 0, costUsd: 0 });
  const byDay = new Map(days.map((d) => [d.date, d]));
  const features = new Map<string, { calls: number; costUsd: number }>();
  const dayIndex = new Map(days.map((d, i) => [d.date, i]));
  const byOrg: AdminOverview["byOrg"] = Object.fromEntries(orgs.map((o) => [o.id, { days: days.map(() => ({ calls: 0, costUsd: 0 })), features: {} }]));
  let callsMonth = 0;
  let costMonth = 0;
  for (const u of usage) {
    const t = new Date(u.created_at);
    const d = byDay.get(u.created_at.slice(0, 10));
    const mine = byOrg[u.org_id];
    if (d && t >= since) {
      d.calls++;
      d.costUsd += cost(u);
      const od = mine?.days[dayIndex.get(d.date)!];
      if (od) (od.calls++, (od.costUsd += cost(u)));
    }
    if (t >= monthStart) {
      callsMonth++;
      costMonth += cost(u);
      const key = u.endpoint || "(unknown)";
      const f = features.get(key) ?? { calls: 0, costUsd: 0 };
      f.calls++;
      f.costUsd += cost(u);
      features.set(key, f);
      if (mine) {
        const of = (mine.features[key] ??= { calls: 0, costUsd: 0 });
        of.calls++;
        of.costUsd += cost(u);
      }
    }
  }
  const weekAgo = now.getTime() - 7 * DAY;
  return {
    generatedAt: now.toISOString(),
    summary: {
      orgs: orgs.length,
      people: members.length,
      active7: rows.filter((r) => r.lastActive && new Date(r.lastActive).getTime() >= weekAgo).length,
      callsMonth,
      costMonth,
    },
    orgs: rows,
    days,
    // Most used first; ties by cost, then name, so the order never depends on how the rows arrived.
    features: sortFeatures([...features.entries()].map(([endpoint, f]) => ({ endpoint, ...f }))),
    yourOrgId,
    byOrg,
  };
}


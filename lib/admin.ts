import { query } from "./db.js";
import { AI_SAFEGUARD_USD, effectiveLimit } from "./ai-limits.js";
import { UserFacingError } from "./errors.js";
import { sortFeatures } from "./admin-usage.js";

// The site owner's activity page (#admin): every organization's plan, members and AI use, the site's activity over
// the last 30 days, and the inbox: requests for access (to invite or decline) and feedback. Account, usage and inbox
// data only: nothing from inside an organization's records (those are encrypted per organization).
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
  /** percent used of the allowance that applies (its own, never above the safeguard); null with a zero allowance */
  percent: number | null;
  flags: ("near limit" | "at limit" | "past due" | "quiet" | "AI off")[];
  /** how many of each it has saved: counted, never opened (the records are encrypted) */
  made: Record<MadeKind, number>;
};

/** The saved records counted per organization, by the label the page shows. */
export const MADE_TABLES = { projects: "projects", reviews: "rfp_reviews", fees: "fees", schedules: "schedules", comparisons: "comparisons" } as const;
export type MadeKind = keyof typeof MADE_TABLES;

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
  const [orgs, members, made] = await Promise.all([
    query<OrgRow[]>("organizations?select=id,name,plan,created_at,ai_monthly_limit_usd,subscription_status,current_period_start&limit=10000"),
    query<{ org_id: string }[]>("org_members?select=org_id&limit=100000"),
    countMade(),
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
    // Against the allowance that applies: its own, never above the $100 safeguard (lib/ai-limits.ts).
    const applies = effectiveLimit(limitUsd);
    const percent = applies > 0 ? (costUsd / applies) * 100 : null;
    const lastActive = last.get(o.id) ?? null;
    const flags: AdminOrg["flags"] = [];
    if (percent != null && percent >= 100) flags.push("at limit");
    else if (percent != null && percent >= 80) flags.push("near limit");
    if (o.subscription_status === "past_due") flags.push("past due");
    if (applies === 0) flags.push("AI off");
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
      made: made.get(o.id) ?? emptyMade(),
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


// ---------- The inbox: access requests and feedback ----------

export type RequestStatus = "new" | "invited" | "declined";
export const REQUEST_STATUSES: RequestStatus[] = ["new", "invited", "declined"];

export type AccessRequest = { id: string; name: string; email: string; firm: string; note: string; status: RequestStatus; createdAt: string };
export type FeedbackItem = { id: string; message: string; page: string; email: string; orgName: string; createdAt: string };

type RequestRow = { id: string; name: string; email: string; firm: string | null; note: string | null; status: string | null; created_at: string };
type FeedbackRow = { id: string; message: string; tab: string | null; user_email: string | null; org_id: string | null; created_at: string };

/** Requests for access and feedback, newest first (the latest 200 of each). */
export async function adminInbox(): Promise<{ requests: AccessRequest[]; feedback: FeedbackItem[]; invites: PendingInvite[] | null }> {
  const [requests, feedback, orgs, invites] = await Promise.all([
    query<RequestRow[]>("access_requests?select=id,name,email,firm,note,status,created_at&order=created_at.desc&limit=200"),
    query<FeedbackRow[]>("feedback?select=id,message,tab,user_email,org_id,created_at&order=created_at.desc&limit=200"),
    query<{ id: string; name: string }[]>("organizations?select=id,name&limit=10000"),
    // null: they couldn't be read (the page says so)
    pendingInvites().catch(() => null),
  ]);
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  return {
    requests: requests.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      firm: r.firm ?? "",
      note: r.note ?? "",
      status: REQUEST_STATUSES.includes(r.status as RequestStatus) ? (r.status as RequestStatus) : "new",
      createdAt: r.created_at,
    })),
    feedback: feedback.map((f) => ({
      id: f.id,
      message: f.message,
      page: f.tab ?? "",
      email: f.user_email ?? "",
      orgName: (f.org_id && orgName.get(f.org_id)) || "",
      createdAt: f.created_at,
    })),
    invites,
  };
}

const isId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id);

/** Marks a request invited, declined, or new again. */
export async function setRequestStatus(id: unknown, status: unknown): Promise<void> {
  if (!isId(id) || !REQUEST_STATUSES.includes(status as RequestStatus)) throw new UserFacingError("Unknown request or status.");
  await query(`access_requests?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status }) });
}

/**
 * Invites the person who asked: Supabase emails them a link to set a password and sign in (back to this site), and the
 * request is marked invited. Someone who already has an account is marked invited too, and told so.
 */
export async function inviteRequest(id: unknown, origin: string): Promise<{ alreadyHadAccount: boolean }> {
  if (!isId(id)) throw new UserFacingError("Unknown request.");
  const [r] = await query<RequestRow[]>(`access_requests?select=id,email,status&id=eq.${id}`);
  if (!r) throw new UserFacingError("That request no longer exists.", 404);
  const res = await fetch(`${authBase()}/invite?redirect_to=${encodeURIComponent(origin)}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ email: r.email }),
  });
  let alreadyHadAccount = false;
  if (!res.ok) {
    const body = await res.text();
    // Already a user: nothing to send, but they're in.
    if (res.status === 422 && /already/i.test(body)) alreadyHadAccount = true;
    else {
      console.error(`[admin] invite failed: ${res.status}`);
      throw new UserFacingError(res.status === 429 ? "Too many invites sent recently. Try again in a little while." : `The invite couldn't be sent (${res.status}).`, 502);
    }
  }
  await setRequestStatus(id, "invited");
  return { alreadyHadAccount };
}

const emptyMade = (): Record<MadeKind, number> => ({ projects: 0, reviews: 0, fees: 0, schedules: 0, comparisons: 0 });

/** Saved records per organization, per kind: only each row's organization is read, never its (encrypted) contents. */
async function countMade(): Promise<Map<string, Record<MadeKind, number>>> {
  const kinds = Object.keys(MADE_TABLES) as MadeKind[];
  const lists = await Promise.all(kinds.map((k) => query<{ org_id: string }[]>(`${MADE_TABLES[k]}?select=org_id&limit=100000`).catch(() => [])));
  const out = new Map<string, Record<MadeKind, number>>();
  kinds.forEach((k, i) => {
    for (const r of lists[i]) {
      const m = out.get(r.org_id) ?? emptyMade();
      m[k]++;
      out.set(r.org_id, m);
    }
  });
  return out;
}

// ---------- Allowances ----------

/** The most a monthly AI allowance can be set to from the page: the safeguard. */
export const MAX_ALLOWANCE_USD = AI_SAFEGUARD_USD;

/**
 * Sets an organization's monthly AI allowance in dollars: null for no limit, 0 to turn AI off. Rounded to cents.
 * A subscription change (Stripe) sets it again for paying organizations, as it always has.
 */
export async function setOrgAllowance(orgId: unknown, usd: unknown): Promise<number | null> {
  if (!isId(orgId)) throw new UserFacingError("Unknown organization.");
  if (usd !== null && (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0 || usd > MAX_ALLOWANCE_USD))
    throw new UserFacingError(`An allowance is $0 to $${MAX_ALLOWANCE_USD} a month (the safeguard), or blank for the safeguard itself.`);
  const value = usd === null ? null : Math.round((usd as number) * 100) / 100;
  await query(`organizations?id=eq.${orgId}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ai_monthly_limit_usd: value }) });
  return value;
}

// ---------- Invited, not signed in yet ----------

export type PendingInvite = { id: string; email: string; invitedAt: string };

const authBase = () => `${process.env.SUPABASE_URL!.replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "")}/auth/v1`;
const authHeaders = () => {
  const key = process.env.SUPABASE_SECRET_KEY!;
  return { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };
};

/** People invited who haven't signed in yet, longest waiting first. */
export async function pendingInvites(): Promise<PendingInvite[]> {
  type User = { id: string; email?: string; invited_at?: string | null; last_sign_in_at?: string | null };
  const out: PendingInvite[] = [];
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(`${authBase()}/admin/users?page=${page}&per_page=200`, { headers: authHeaders() });
    if (!res.ok) throw new UserFacingError(`Couldn't read the invited people (${res.status}).`, 502);
    const users = ((await res.json()) as { users?: User[] }).users ?? [];
    for (const u of users) if (u.invited_at && !u.last_sign_in_at && u.email) out.push({ id: u.id, email: u.email, invitedAt: u.invited_at });
    if (users.length < 200) break;
  }
  return out.sort((a, b) => a.invitedAt.localeCompare(b.invitedAt));
}

/** Sends someone's invite again (Supabase emails a fresh link). */
export async function resendInvite(email: unknown, origin: string): Promise<void> {
  if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new UserFacingError("Unknown email.");
  const res = await fetch(`${authBase()}/invite?redirect_to=${encodeURIComponent(origin)}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ email }),
  });
  if (res.ok) return;
  console.error(`[admin] resend invite failed: ${res.status}`);
  if (res.status === 429) throw new UserFacingError("Too many invites sent recently. Try again in a little while.", 429);
  throw new UserFacingError(
    `Supabase didn't resend it (${res.status}). To send a fresh invite, delete this person under Authentication → Users in Supabase, then invite them again from their access request or the Supabase dashboard.`,
    502,
  );
}

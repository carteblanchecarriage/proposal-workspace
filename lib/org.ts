import { effectiveLimit } from "./ai-limits.js";
import { getClient, UserFacingError } from "./claude.js";
import { listAll, query, TABLES, type Table } from "./db.js";
import { remove as removeStored, RFP_PATH } from "./storage.js";
import { billingConfigured, cancelSubscription, planPrice } from "./billing.js";

// The organization page: its name, who's in it, this month's AI use, export, and delete. Deliberately simple: no
// roles to manage or invites (a firm may well share one login). Owners can rename and delete; everyone can view and
// export.

const q = encodeURIComponent;
const authBase = () => `${process.env.SUPABASE_URL!.replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "")}/auth/v1`;
const adminHeaders = () => ({ apikey: process.env.SUPABASE_SECRET_KEY!, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY!}` });

type OrgRow = {
  id: string;
  name: string;
  join_domain: string | null;
  ai_monthly_limit_usd: number | null;
  plan: string;
  created_at: string;
  subscription_status: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
};

export async function roleOf(org: string, user: string | null): Promise<string | null> {
  if (!user) return null;
  const rows = await query<{ role: string }[]>(`org_members?select=role&org_id=eq.${q(org)}&user_id=eq.${q(user)}`);
  return rows[0]?.role ?? null;
}

async function requireOwner(org: string, user: string | null) {
  if ((await roleOf(org, user)) !== "owner") throw new UserFacingError("Only the organization's owner can do that.", 403);
}

async function emailOf(user: string): Promise<string | null> {
  const res = await fetch(`${authBase()}/admin/users/${q(user)}`, { headers: adminHeaders() });
  if (!res.ok) return null;
  return ((await res.json()) as { email?: string }).email ?? null;
}

/** How much of its AI allowance an organization has used: off (no allowance), or a percent (0–100) of what applies. */
export type AiUse = { state: "off" } | { state: "limited"; percent: number };
export function aiUse(limit: number | null, spent: number): AiUse {
  // No limit and every allowance are capped by the safeguard, so there's always a percent to show.
  const applies = effectiveLimit(limit);
  if (applies <= 0) return { state: "off" };
  return { state: "limited", percent: Math.min(100, (spent / applies) * 100) };
}

export async function orgInfo(org: string, user: string | null) {
  const [o] = await query<OrgRow[]>(`organizations?select=id,name,join_domain,ai_monthly_limit_usd,plan,created_at,subscription_status,current_period_start,current_period_end&id=eq.${q(org)}`);
  if (!o) throw new UserFacingError("Organization not found.", 404);
  const members = await query<{ user_id: string; role: string; created_at: string }[]>(
    `org_members?select=user_id,role,created_at&org_id=eq.${q(org)}&order=created_at.asc&limit=200`,
  );
  // The same window the AI cap uses (supabase/billing.sql, ai_window_start): a paying organization's billing period,
  // else the calendar month.
  const paying = ["active", "trialing", "past_due"].includes(o.subscription_status ?? "") && o.current_period_start;
  const monthStart = paying ? new Date(o.current_period_start!) : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const usage = await query<{ cost_usd: number | null }[]>(
    `usage_events?select=cost_usd&org_id=eq.${q(org)}&created_at=gte.${q(monthStart.toISOString())}&limit=100000`,
  );
  const spent = usage.reduce((s, u) => s + Number(u.cost_usd ?? 0), 0);
  return {
    name: o.name,
    joinDomain: o.join_domain,
    plan: o.plan,
    subscriptionStatus: o.subscription_status,
    renewsAt: o.current_period_end,
    billing: billingConfigured() ? { price: await planPrice() } : null,
    createdAt: o.created_at,
    // AI use as a share of the allowance, never in dollars: the allowance is a usage limit, not a price.
    ai: aiUse(o.ai_monthly_limit_usd == null ? null : Number(o.ai_monthly_limit_usd), spent),
    you: members.find((m) => m.user_id === user)?.role ?? null,
    people: await Promise.all(members.map(async (m) => ({ email: await emailOf(m.user_id), role: m.role, you: m.user_id === user }))),
  };
}

export async function renameOrg(org: string, user: string | null, name: string): Promise<void> {
  await requireOwner(org, user);
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!clean) throw new UserFacingError("Give the organization a name.");
  await query(`organizations?id=eq.${q(org)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ name: clean }) });
}

/** Everything the organization has saved, as one JSON document. */
export async function exportOrg(org: string, user: string | null) {
  const info = await orgInfo(org, user);
  const tables = Object.fromEntries(
    await Promise.all((Object.keys(TABLES) as Table[]).map(async (t) => [t, await listAll(org, t)] as const)),
  );
  return { exportedAt: new Date().toISOString(), organization: { name: info.name, createdAt: info.createdAt }, ...tables };
}

/**
 * Deletes the organization and everything in it: every record (the database cascades from organizations), the RFP
 * PDFs kept in storage, and its PDFs held at Anthropic. People keep their accounts; next time they sign in they get a
 * new, empty organization. Owner only, and the exact name must be typed to confirm.
 */
export async function deleteOrg(org: string, user: string | null, typedName: string): Promise<void> {
  await requireOwner(org, user);
  const [o] = await query<{ name: string }[]>(`organizations?select=name&id=eq.${q(org)}`);
  if (!o) throw new UserFacingError("Organization not found.", 404);
  if (typedName.trim() !== o.name.trim()) throw new UserFacingError("The name you typed doesn't match.");

  // Stop billing first: a deleted organization must never be charged again.
  await cancelSubscription(org);

  // Files outside the database first, while their records still say where they are. Best effort: anything missed
  // is removed by the usual clean-ups (kept RFP PDFs after 30 days, Anthropic copies after a day).
  const [rfps, cmps, readings] = await Promise.all([listAll(org, "rfps"), listAll(org, "comparisons"), listAll(org, "readings")]);
  const paths = (rfps as { stored?: { path?: string }[] }[]).flatMap((r) => (r.stored ?? []).map((s) => s.path ?? "")).filter((p) => RFP_PATH.test(p));
  for (let i = 0; i < paths.length; i += 100) await removeStored(paths.slice(i, i + 100));
  const fileIds = new Set<string>();
  for (const c of cmps as { proposals?: { file_id?: string }[] }[]) for (const p of c.proposals ?? []) if (p.file_id) fileIds.add(p.file_id);
  for (const r of readings as { file_id?: string }[]) if (r.file_id) fileIds.add(r.file_id);
  // Every PDF the organization uploaded, including any no saved record points to.
  const uploaded = await query<{ file_id: string }[]>(`org_files?select=file_id&org_id=eq.${q(org)}&limit=10000`).catch(() => []);
  for (const f of uploaded) fileIds.add(f.file_id);
  if (fileIds.size && process.env.ANTHROPIC_API_KEY) {
    await Promise.allSettled([...fileIds].map((id) => getClient().files.delete(id)));
  }

  await query(`organizations?id=eq.${q(org)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  console.log(`[org] deleted an organization: ${paths.length} stored PDF(s), ${fileIds.size} Anthropic file(s)`);
}

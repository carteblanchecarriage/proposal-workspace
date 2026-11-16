import { errorResponse, UserFacingError } from "./claude.js";
import { requestContext, runWithContext, setUsageSink, type RequestContext } from "./context.js";
import { dbConfigured, insertRow, rpc } from "./db.js";

/**
 * Supabase Auth + organizations. The browser signs in with Supabase and sends its access token as
 * `Authorization: Bearer <token>`. Every endpoint is wrapped in route(), which checks the token with Supabase, finds
 * (or on first visit, creates) the person's organization, enforces its monthly AI limit, and records Claude usage.
 *
 * Login is on when SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are set. Without them, local dev runs with no login and
 * no database (saves stay in the browser), but a production deploy refuses every request.
 *
 * Optional env:
 *   AUTH_ALLOWED_EMAILS       comma-separated emails and/or "@domain.com"; when set, only those people get in.
 *   DEFAULT_ORG_AI_LIMIT_USD  monthly AI spending limit for new organizations (default 0: no AI until raised).
 */

const base = () => process.env.SUPABASE_URL!.replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "");

export function authConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY);
}

/** What the browser needs to sign in. Both values are public by design (the publishable key only reaches Auth). */
export function publicAuthConfig(): { url: string; publishableKey: string } | null {
  return authConfigured() ? { url: base(), publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY! } : null;
}

function allowed(email: string | undefined): boolean {
  const list = (process.env.AUTH_ALLOWED_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true;
  const e = (email ?? "").toLowerCase();
  return list.some((entry) => (entry.startsWith("@") ? e.endsWith(entry) : e === entry));
}

/** emailConfirmed: Supabase has verified the address (only then can it match an organization's join domain). */
type AuthUser = { id: string; email: string | null; emailConfirmed: boolean };

// Verified tokens, kept briefly so a burst of requests doesn't ask Supabase each time.
const TOKEN_MS = 60_000;
const tokens = new Map<string, { user: AuthUser; until: number }>();

async function verify(token: string): Promise<AuthUser | null> {
  const now = Date.now();
  const hit = tokens.get(token);
  if (hit && hit.until > now) return hit.user;
  const res = await fetch(`${base()}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY!, Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new UserFacingError("Couldn't check your sign-in. Try again.", 502);
  const body = (await res.json()) as { id?: string; email?: string; email_confirmed_at?: string | null };
  if (!body.id) return null;
  const user = { id: body.id, email: body.email ?? null, emailConfirmed: !!body.email_confirmed_at };
  if (tokens.size > 1000) tokens.clear();
  tokens.set(token, { user, until: now + TOKEN_MS });
  return user;
}

export type Org = { id: string; name: string; role: string; limitUsd: number | null; spentUsd: number };

// A person's organization, kept briefly (AI endpoints always re-read it, for an up-to-date spending total).
const ORG_MS = 30_000;
const orgs = new Map<string, { org: Org; until: number }>();

async function orgFor(user: AuthUser, fresh: boolean): Promise<Org> {
  const now = Date.now();
  const hit = orgs.get(user.id);
  if (!fresh && hit && hit.until > now) return hit.org;
  const limit = Number(process.env.DEFAULT_ORG_AI_LIMIT_USD ?? 0);
  // A new person joins the organization whose join_domain matches their confirmed email (e.g. @yourfirm.com), or gets
  // a new organization of their own.
  const rows = (await rpc("ensure_org", {
    p_user: user.id,
    p_email: user.emailConfirmed ? user.email : null,
    p_name: user.email ? `${user.email}'s organization` : "My organization",
    p_limit: Number.isFinite(limit) ? limit : 0,
  })) as { org_id: string; org_name: string; role: string; ai_monthly_limit_usd: number | null; spent_this_month: number }[];
  const r = rows[0];
  if (!r) throw new UserFacingError("Couldn't load your organization.", 500);
  const org = { id: r.org_id, name: r.org_name, role: r.role, limitUsd: r.ai_monthly_limit_usd == null ? null : Number(r.ai_monthly_limit_usd), spentUsd: Number(r.spent_this_month) };
  if (orgs.size > 1000) orgs.clear();
  orgs.set(user.id, { org, until: now + ORG_MS });
  return org;
}

/** After renaming or deleting an organization: forget the cached copies on this server, so the change shows at once. */
export const forgetOrgs = () => orgs.clear();

setUsageSink((ctx, u) =>
  insertRow("usage_events", {
    org_id: ctx.orgId,
    user_id: ctx.userId,
    endpoint: ctx.endpoint,
    model: u.model,
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_write_tokens: u.cache_write_tokens,
    cache_read_tokens: u.cache_read_tokens,
    cost_usd: u.cost_usd,
  }),
);

/** Checks the request's sign-in and finds its organization. Throws 401/403 when it isn't good. */
async function authenticate(request: Request, ai: boolean): Promise<{ user: AuthUser | null; org: Org | null }> {
  if (!authConfigured()) {
    if (process.env.VERCEL_ENV === "production") throw new UserFacingError("Login isn't configured on the server.", 500);
    return { user: null, org: null }; // local dev without Supabase Auth
  }
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new UserFacingError("Please sign in.", 401);
  const user = await verify(token);
  if (!user) throw new UserFacingError("Your sign-in has expired. Please sign in again.", 401);
  if (!allowed(user.email ?? undefined)) throw new UserFacingError("This account doesn't have access.", 403);
  if (!dbConfigured()) throw new UserFacingError("The database isn't configured on the server.", 500);
  return { user, org: await orgFor(user, ai) };
}

type Handler = (request: Request) => Promise<Response>;

/**
 * Wraps an endpoint: sign-in, organization, and (with ai: true) the monthly AI limit. Inside the handler,
 * currentOrgId() gives the organization, and every Claude call's usage is recorded against it.
 */
export function route(handler: Handler, opts: { ai?: boolean } = {}): Handler {
  return async (request) => {
    let ctx: RequestContext;
    try {
      const { user, org } = await authenticate(request, !!opts.ai);
      if (opts.ai && org && org.limitUsd != null && org.spentUsd >= org.limitUsd) {
        throw new UserFacingError(
          org.limitUsd === 0
            ? "AI features aren't turned on for your organization yet."
            : `Your organization has reached its AI limit for this month ($${org.limitUsd.toFixed(2)}).`,
          402,
        );
      }
      ctx = { userId: user?.id ?? null, email: user?.email ?? null, orgId: org?.id ?? null, endpoint: new URL(request.url).pathname, pending: [] };
    } catch (err) {
      return errorResponse(err);
    }
    return runWithContext(ctx, async () => {
      try {
        return await handler(request);
      } catch (err) {
        return errorResponse(err);
      } finally {
        await Promise.allSettled(ctx.pending);
      }
    });
  };
}

/** The organization of the request being handled; null when login is off (local dev). */
export const currentOrgId = (): string | null => requestContext()?.orgId ?? null;

/** For /api/auth: who's signed in and their organization. */
export async function whoAmI(request: Request): Promise<{ email: string | null; org: Org | null }> {
  const { user, org } = await authenticate(request, true);
  return { email: user?.email ?? null, org };
}

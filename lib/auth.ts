import { UserFacingError } from "./claude.js";

/**
 * Supabase Auth. The browser signs in with Supabase and sends its access token as `Authorization: Bearer <token>`;
 * every API endpoint checks that token with Supabase before doing anything.
 *
 * Login is on when SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are set. Without them, local dev runs with no login,
 * but a production deploy refuses every request, so a missing variable never leaves the live site open.
 *
 * Optional AUTH_ALLOWED_EMAILS: comma-separated emails and/or "@domain.com" entries. When set, only those people get
 * in, even if someone else manages to create an account.
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

export type AuthUser = { id: string; email?: string };

// Verified tokens, kept briefly so a burst of requests doesn't ask Supabase each time.
const CACHE_MS = 60_000;
const cache = new Map<string, { user: AuthUser; until: number }>();

async function verify(token: string): Promise<AuthUser | null> {
  const now = Date.now();
  const hit = cache.get(token);
  if (hit && hit.until > now) return hit.user;
  const res = await fetch(`${base()}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY!, Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new UserFacingError("Couldn't check your sign-in. Try again.", 502);
  const body = (await res.json()) as { id?: string; email?: string };
  if (!body.id) return null;
  const user = { id: body.id, email: body.email };
  if (cache.size > 1000) cache.clear();
  cache.set(token, { user, until: now + CACHE_MS });
  return user;
}

/** Throws 401 unless the request carries a valid Supabase session for an allowed user. */
export async function checkAccess(request: Request): Promise<AuthUser | null> {
  if (!authConfigured()) {
    if (process.env.VERCEL_ENV === "production") throw new UserFacingError("Login isn't configured on the server.", 500);
    return null; // local dev without Supabase Auth
  }
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new UserFacingError("Please sign in.", 401);
  const user = await verify(token);
  if (!user) throw new UserFacingError("Your sign-in has expired. Please sign in again.", 401);
  if (!allowed(user.email)) throw new UserFacingError("This account doesn't have access.", 403);
  return user;
}

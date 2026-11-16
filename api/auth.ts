import { publicAuthConfig, whoAmI } from "../lib/auth.js";
import { errorResponse } from "../lib/claude.js";

// GET: what the browser needs to sign in ({ auth: null } when login is off, e.g. local dev without Supabase Auth).
export async function GET(): Promise<Response> {
  return Response.json({ auth: publicAuthConfig() }, { headers: { "cache-control": "no-store" } });
}

// POST: checks the request's sign-in (making the person's organization on their first visit), so the page knows
// whether to show the app or the sign-in form.
export async function POST(request: Request): Promise<Response> {
  try {
    const { email, org } = await whoAmI(request);
    return Response.json({
      ok: true,
      email,
      org: org && { name: org.name, role: org.role, aiLimitUsd: org.limitUsd, aiSpentUsd: Math.round(org.spentUsd * 100) / 100 },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

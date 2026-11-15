import { checkAccess, publicAuthConfig } from "../lib/auth.js";
import { errorResponse } from "../lib/claude.js";

// GET: what the browser needs to sign in ({ auth: null } when login is off, e.g. local dev without Supabase Auth).
export async function GET(): Promise<Response> {
  return Response.json({ auth: publicAuthConfig() }, { headers: { "cache-control": "no-store" } });
}

// POST: checks the request's sign-in, so the page knows whether to show the app or the login form.
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await checkAccess(request);
    return Response.json({ ok: true, email: user?.email ?? null });
  } catch (err) {
    return errorResponse(err);
  }
}

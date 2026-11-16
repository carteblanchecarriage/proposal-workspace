import { forgetOrgs, publicAuthConfig, route, whoAmI } from "../lib/auth.js";
import { errorResponse, UserFacingError } from "../lib/claude.js";
import { requestContext } from "../lib/context.js";
import { deleteOrg, exportOrg, orgInfo, renameOrg } from "../lib/org.js";

// GET: what the browser needs to sign in ({ auth: null } when login is off, e.g. local dev without Supabase Auth).
export async function GET(): Promise<Response> {
  return Response.json({ auth: publicAuthConfig() }, { headers: { "cache-control": "no-store" } });
}

// The organization page (x-action: org-info | org-rename | org-export | org-delete). Kept in this function because
// the Vercel Hobby plan allows 12 per deployment.
const orgAction = route(async (request) => {
  const ctx = requestContext();
  if (!ctx?.orgId) throw new UserFacingError("Organizations need sign-in to be set up.", 503);
  const body = ((await request.json().catch(() => null)) ?? {}) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name : "";
  switch (request.headers.get("x-action")) {
    case "org-info":
      return Response.json(await orgInfo(ctx.orgId, ctx.userId));
    case "org-rename":
      await renameOrg(ctx.orgId, ctx.userId, name);
      forgetOrgs();
      return Response.json({ ok: true });
    case "org-export":
      return Response.json(await exportOrg(ctx.orgId, ctx.userId), { headers: { "cache-control": "no-store" } });
    case "org-delete":
      await deleteOrg(ctx.orgId, ctx.userId, name);
      forgetOrgs();
      return Response.json({ ok: true });
    default:
      throw new UserFacingError("Unknown action.");
  }
});

// POST: checks the request's sign-in (making the person's organization on their first visit), so the page knows
// whether to show the app or the sign-in form. With x-action, the organization page's actions.
export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("x-action")) return orgAction(request);
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

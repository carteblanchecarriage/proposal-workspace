import { adminOverview, isAdmin } from "../lib/admin.js";
import { forgetOrgs, inviteOnly, publicAuthConfig, route, whoAmI } from "../lib/auth.js";
import { errorResponse, UserFacingError } from "../lib/claude.js";
import { requestContext } from "../lib/context.js";
import { deleteOrg, exportOrg, orgInfo, renameOrg, roleOf } from "../lib/org.js";
import { checkoutUrl, handleWebhook, portalUrl } from "../lib/billing.js";
import { appOrigin } from "../lib/origin.js";
import { requestAccess } from "../lib/access-requests.js";

// GET: what the browser needs to sign in ({ auth: null } when login is off, e.g. local dev without Supabase Auth).
export async function GET(): Promise<Response> {
  return Response.json({ auth: publicAuthConfig(), inviteOnly: inviteOnly() }, { headers: { "cache-control": "no-store" } });
}

// The organization page (x-action: org-info | org-rename | org-export | org-delete | billing-checkout | billing-portal), and the
// site owner's activity page (admin-overview, ADMIN_EMAILS only). Kept in this function because
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
    case "billing-checkout":
    case "billing-portal": {
      if ((await roleOf(ctx.orgId, ctx.userId)) !== "owner") throw new UserFacingError("Only the organization's owner can manage billing.", 403);
      const origin = appOrigin(request);
      const url = request.headers.get("x-action") === "billing-checkout" ? await checkoutUrl(ctx.orgId, ctx.email, origin) : await portalUrl(ctx.orgId, origin);
      forgetOrgs();
      return Response.json({ url });
    }
    case "admin-overview":
      if (!isAdmin(ctx.email)) throw new UserFacingError("Not available.", 403);
      return Response.json(await adminOverview(), { headers: { "cache-control": "no-store" } });
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
// Stripe's webhook also lands here (it signs every request with a Stripe-Signature header).
export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("stripe-signature")) return handleWebhook(request);
  // "Request access" from the public landing page: no sign-in.
  if (request.headers.get("x-action") === "request-access") {
    try {
      await requestAccess(request);
      return Response.json({ ok: true });
    } catch (err) {
      return errorResponse(err);
    }
  }
  if (request.headers.get("x-action")) return orgAction(request);
  try {
    const { email, org } = await whoAmI(request);
    return Response.json({
      ok: true,
      email,
      org: org && { name: org.name, role: org.role },
      // Shows the activity page's link; the page's data is checked again on the server.
      ...(isAdmin(email) ? { admin: true } : {}),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

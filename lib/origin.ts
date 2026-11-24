import { UserFacingError } from "./errors.js";

/**
 * The app's own address: where the server's PDF browser may go, and where Stripe sends people back to. On Vercel it
 * comes from Vercel's settings, never from the request, so a forged Host header can't point either somewhere else.
 */
export function appOrigin(request: Request): string {
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  // Local development: the dev server on this machine only.
  const host = request.headers.get("host") ?? "";
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) throw new UserFacingError("This can't be done from this address.", 400);
  return `http://${host}`;
}

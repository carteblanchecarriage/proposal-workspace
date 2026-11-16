import Stripe from "stripe";
import { UserFacingError } from "./claude.js";
import { query } from "./db.js";

/**
 * Billing with Stripe: one plan, a monthly subscription that turns on AI with a cap per billing period.
 *
 *   STRIPE_SECRET_KEY      sk_live_… (or sk_test_… while testing)
 *   STRIPE_WEBHOOK_SECRET  whsec_… from the webhook endpoint (pointed at https://<site>/api/auth)
 *   STRIPE_PRICE_ID        price_… of the plan's monthly price (the amount lives in Stripe)
 *   PLAN_AI_CAP_USD        AI included per billing period, in US$ (default 40)
 *   STRIPE_TAX=1           collect sales tax with Stripe Tax (turn on once Stripe Tax is set up)
 *
 * Checkout and the billing portal are Stripe's own pages. The webhook keeps each organization's plan in step:
 * subscribed → plan "pro" with the AI cap; cancelled or unpaid → plan "free" with the default limit (0). The firm's
 * own organization (plan "owner") is never touched.
 */

export const billingConfigured = () => !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);

let client: Stripe | null = null;
function stripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) throw new UserFacingError("Billing isn't set up on this site yet.", 503);
  client ??= new Stripe(process.env.STRIPE_SECRET_KEY);
  return client;
}

const capUsd = () => {
  const n = Number(process.env.PLAN_AI_CAP_USD ?? 40);
  return Number.isFinite(n) && n >= 0 ? n : 40;
};
const freeLimitUsd = () => {
  const n = Number(process.env.DEFAULT_ORG_AI_LIMIT_USD ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const q = encodeURIComponent;

type OrgBilling = { id: string; name: string; plan: string; stripe_customer_id: string | null };

async function orgBilling(org: string): Promise<OrgBilling> {
  const [o] = await query<OrgBilling[]>(`organizations?select=id,name,plan,stripe_customer_id&id=eq.${q(org)}`);
  if (!o) throw new UserFacingError("Organization not found.", 404);
  return o;
}

async function patchOrg(org: string, fields: Record<string, unknown>) {
  await query(`organizations?id=eq.${q(org)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(fields) });
}

// The plan's price, for the page ("$149 / month"), read from Stripe and kept for an hour.
let priceCache: { label: string; until: number } | null = null;
export async function planPrice(): Promise<string | null> {
  if (!billingConfigured()) return null;
  if (priceCache && priceCache.until > Date.now()) return priceCache.label;
  try {
    const p = await stripe().prices.retrieve(process.env.STRIPE_PRICE_ID!);
    const amount = (p.unit_amount ?? 0) / 100;
    const label = `${amount.toLocaleString("en-US", { style: "currency", currency: (p.currency ?? "usd").toUpperCase(), minimumFractionDigits: amount % 1 ? 2 : 0 })} / ${p.recurring?.interval ?? "month"}`;
    priceCache = { label, until: Date.now() + 60 * 60 * 1000 };
    return label;
  } catch (err) {
    console.error("[billing] couldn't read the plan's price:", (err as Error).message);
    return null;
  }
}
export const planCapUsd = capUsd;

/** A Stripe Checkout page for this organization to subscribe. The organization's id travels with the subscription. */
export async function checkoutUrl(org: string, email: string | null, origin: string): Promise<string> {
  if (!billingConfigured()) throw new UserFacingError("Billing isn't set up on this site yet.", 503);
  const o = await orgBilling(org);
  if (o.plan === "owner") throw new UserFacingError("This organization doesn't need a subscription.");
  let customer = o.stripe_customer_id;
  if (!customer) {
    const c = await stripe().customers.create({ name: o.name, email: email ?? undefined, metadata: { org_id: org } });
    customer = c.id;
    await patchOrg(org, { stripe_customer_id: customer });
  }
  const tax = process.env.STRIPE_TAX === "1";
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    client_reference_id: org,
    line_items: [{ price: process.env.STRIPE_PRICE_ID!, quantity: 1 }],
    subscription_data: { metadata: { org_id: org } },
    // Founding-customer prices and other discounts are Stripe promotion codes.
    allow_promotion_codes: true,
    ...(tax ? { automatic_tax: { enabled: true }, customer_update: { address: "auto", name: "auto" }, tax_id_collection: { enabled: true } } : {}),
    success_url: `${origin}/#org/subscribed`,
    cancel_url: `${origin}/#org`,
  });
  if (!session.url) throw new UserFacingError("Couldn't start checkout.", 502);
  return session.url;
}

/** Stripe's billing portal: card, invoices, cancel. */
export async function portalUrl(org: string, origin: string): Promise<string> {
  const o = await orgBilling(org);
  if (!o.stripe_customer_id) throw new UserFacingError("There's no subscription to manage yet.");
  const session = await stripe().billingPortal.sessions.create({ customer: o.stripe_customer_id, return_url: `${origin}/#org` });
  return session.url;
}

/** Cancels the organization's subscription at once (when the organization is deleted). Throws if Stripe refuses. */
export async function cancelSubscription(org: string): Promise<void> {
  const [o] = await query<{ stripe_subscription_id: string | null; subscription_status: string | null }[]>(
    `organizations?select=stripe_subscription_id,subscription_status&id=eq.${q(org)}`,
  );
  if (!o?.stripe_subscription_id || o.subscription_status === "canceled") return;
  try {
    await stripe().subscriptions.cancel(o.stripe_subscription_id);
  } catch (err) {
    if ((err as { code?: string }).code === "resource_missing") return; // already gone
    throw new UserFacingError("Couldn't cancel the subscription, so nothing was deleted. Try again, or cancel it under Manage billing first.", 502);
  }
}

/** A subscription's billing period (newer Stripe API versions keep it on the subscription's item). */
function periodOf(sub: Stripe.Subscription): { start: number | null; end: number | null } {
  const item = sub.items?.data?.[0] as (Stripe.SubscriptionItem & { current_period_start?: number; current_period_end?: number }) | undefined;
  const s = sub as Stripe.Subscription & { current_period_start?: number; current_period_end?: number };
  return { start: item?.current_period_start ?? s.current_period_start ?? null, end: item?.current_period_end ?? s.current_period_end ?? null };
}

const PAID = new Set(["active", "trialing", "past_due"]);
const iso = (t: number | null) => (t ? new Date(t * 1000).toISOString() : null);

/** Sets the organization's plan and AI limit from a subscription's current state. */
export async function applySubscription(sub: Stripe.Subscription): Promise<string> {
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const byMeta = sub.metadata?.org_id;
  const [o] = byMeta
    ? await query<OrgBilling[]>(`organizations?select=id,name,plan,stripe_customer_id&id=eq.${q(byMeta)}`)
    : await query<OrgBilling[]>(`organizations?select=id,name,plan,stripe_customer_id&stripe_customer_id=eq.${q(customer)}`);
  if (!o) return "no matching organization";
  if (o.plan === "owner") return "owner organization left as is";
  const { start, end } = periodOf(sub);
  // past_due keeps the plan while Stripe retries the card; anything else that isn't paid turns AI off.
  const paid = PAID.has(sub.status);
  await patchOrg(o.id, {
    stripe_customer_id: o.stripe_customer_id ?? customer,
    stripe_subscription_id: sub.id,
    subscription_status: sub.status,
    current_period_start: iso(start),
    current_period_end: iso(end),
    plan: paid ? "pro" : "free",
    ai_monthly_limit_usd: paid ? capUsd() : freeLimitUsd(),
  });
  return `${paid ? "pro" : "free"} (${sub.status})`;
}

/**
 * Stripe's webhook (POST /api/auth with a Stripe-Signature header). Verifies the signature, then updates the
 * organization from the subscription's current state, fetched fresh from Stripe, so events that arrive late or out
 * of order can't put an organization on the wrong plan.
 */
export async function handleWebhook(request: Request): Promise<Response> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new Response("Webhook not configured", { status: 503 });
  const body = await request.text();
  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(body, request.headers.get("stripe-signature") ?? "", secret);
  } catch {
    return new Response("Bad signature", { status: 400 });
  }
  try {
    let result = "ignored";
    switch (event.type) {
      case "checkout.session.completed": {
        // Links the customer to the organization (the subscription events set the plan).
        const s = event.data.object as Stripe.Checkout.Session;
        const org = s.client_reference_id;
        const customer = typeof s.customer === "string" ? s.customer : s.customer?.id;
        if (org && customer) {
          await query(`organizations?id=eq.${q(org)}&stripe_customer_id=is.null`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ stripe_customer_id: customer }) });
          result = "customer linked";
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
      {
        const sent = event.data.object as Stripe.Subscription;
        let current = sent;
        try {
          current = await stripe().subscriptions.retrieve(sent.id);
        } catch {} // fall back to the event's copy
        result = await applySubscription(current);
      }
        break;
    }
    console.log(`[billing] ${event.type}: ${result}`);
    return Response.json({ received: true });
  } catch (err) {
    console.error(`[billing] ${event.type} failed:`, (err as Error).message);
    // A 500 makes Stripe retry the event later.
    return new Response("Error", { status: 500 });
  }
}

-- Billing (Stripe): run once in Supabase → SQL Editor, after domain-join.sql. Safe to re-run.
-- One plan: a monthly subscription that turns on AI with a monthly cap (PLAN_AI_CAP_USD). Stripe tells the app when a
-- subscription starts, renews or ends (its webhook), and the app sets the organization's plan and AI limit to match.

alter table organizations add column if not exists stripe_subscription_id text;
alter table organizations add column if not exists subscription_status text;
alter table organizations add column if not exists current_period_start timestamptz;
alter table organizations add column if not exists current_period_end timestamptz;
create unique index if not exists organizations_stripe_customer on organizations (stripe_customer_id) where stripe_customer_id is not null;

-- The AI spending window: a paying organization's current billing period (its cap resets on its billing date);
-- everyone else, the calendar month.
create or replace function ai_window_start(g organizations) returns timestamptz
language sql stable
as $$
  select case
    when g.subscription_status in ('active', 'trialing', 'past_due') and g.current_period_start is not null
      then g.current_period_start
    else date_trunc('month', now())
  end
$$;

-- Same as domain-join.sql's, but spending is counted over that window.
create or replace function ensure_org(p_user uuid, p_email text, p_name text, p_limit numeric)
returns table (org_id uuid, org_name text, role text, ai_monthly_limit_usd numeric, spent_this_month numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  o uuid;
  r text;
  v_domain text := lower(split_part(coalesce(p_email, ''), '@', 2));
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));
  select m.org_id, m.role into o, r from org_members m where m.user_id = p_user;
  if o is null and v_domain <> '' then
    select g.id into o from organizations g where lower(g.join_domain) = v_domain;
    if o is not null then
      r := 'member';
      insert into org_members (user_id, org_id, role) values (p_user, o, r);
    end if;
  end if;
  if o is null then
    insert into organizations (name, ai_monthly_limit_usd) values (p_name, p_limit) returning id into o;
    r := 'owner';
    insert into org_members (user_id, org_id, role) values (p_user, o, r);
  end if;
  return query
    select g.id, g.name, r, g.ai_monthly_limit_usd,
           coalesce((select sum(u.cost_usd) from usage_events u
                     where u.org_id = g.id and u.created_at >= ai_window_start(g)), 0)
    from organizations g where g.id = o;
end $$;
revoke all on function ensure_org(uuid, text, text, numeric) from public, anon, authenticated;
grant execute on function ensure_org(uuid, text, text, numeric) to service_role;
revoke all on function ai_window_start(organizations) from public, anon, authenticated;
grant execute on function ai_window_start(organizations) to service_role;

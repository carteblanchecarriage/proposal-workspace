-- Domain auto-join: run once in Supabase → SQL Editor, AFTER orgs.sql. Safe to re-run.
-- Anyone who signs up with a confirmed email at an organization's join_domain (e.g. @yourfirm.com) joins that organization
-- as a member. Everyone else still gets a new organization of their own, as its owner.

alter table organizations add column if not exists join_domain text;
create unique index if not exists organizations_join_domain on organizations (lower(join_domain));

-- Public email providers can never be a join domain (it would put strangers into one organization).
alter table organizations drop constraint if exists organizations_join_domain_not_public;
alter table organizations add constraint organizations_join_domain_not_public check (
  join_domain is null or lower(join_domain) not in (
    'gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','msn.com','yahoo.com','ymail.com',
    'icloud.com','me.com','mac.com','aol.com','proton.me','protonmail.com','gmx.com','mail.com','zoho.com',
    'yandex.com','fastmail.com','hey.com'
  )
);

-- Your firm's organization: its name and email domain. Edit both, then uncomment and run:
--   update organizations set name = 'Your Firm', join_domain = 'yourfirm.com' where name = 'My organization';

-- ensure_org now takes the person's (confirmed) email, to match a join domain, and returns their role.
drop function if exists ensure_org(uuid, text, numeric);
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
                     where u.org_id = g.id and u.created_at >= date_trunc('month', now())), 0)
    from organizations g where g.id = o;
end $$;
revoke all on function ensure_org(uuid, text, text, numeric) from public, anon, authenticated;
grant execute on function ensure_org(uuid, text, text, numeric) to service_role;

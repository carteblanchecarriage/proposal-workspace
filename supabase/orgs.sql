-- Organizations: run once in Supabase → SQL Editor, AFTER schema.sql. Safe to re-run, but once domain-join.sql has
-- run there's no need: a re-run only adds back an older, unused ensure_org (org-files.sql removes it).
-- Every record belongs to one organization; the server only reads and writes the signed-in person's organization.
-- Existing records (from before organizations) all go into one organization, "My organization".

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- Monthly AI spending limit in US$ (null = no limit). New organizations get DEFAULT_ORG_AI_LIMIT_USD (default 0).
  ai_monthly_limit_usd numeric,
  plan text not null default 'free',
  stripe_customer_id text,
  created_at timestamptz not null default now()
);

-- One organization per person (user_id is the key).
create table if not exists org_members (
  user_id uuid primary key references auth.users on delete cascade,
  org_id uuid not null references organizations on delete cascade,
  role text not null default 'owner',
  created_at timestamptz not null default now()
);
create index if not exists org_members_org on org_members (org_id);

-- Every Claude call's tokens and cost, per organization: the monthly limit reads this, and billing will too.
create table if not exists usage_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations on delete cascade,
  user_id uuid,
  endpoint text,
  model text not null,
  input_tokens integer not null,
  output_tokens integer not null,
  cache_write_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cost_usd numeric,
  created_at timestamptz not null default now()
);
create index if not exists usage_events_org_time on usage_events (org_id, created_at);

alter table organizations enable row level security;
alter table org_members enable row level security;
alter table usage_events enable row level security;
grant select, insert, update, delete on organizations, org_members, usage_events to service_role;

-- Existing records: one organization for all of them (created once), then org_id on every table, part of each key.
do $$
declare
  legacy uuid;
  t text;
  k text;
  orphans boolean := false;
  n bigint;
begin
  -- Only make "My organization" when some record has no organization yet (the first run). Re-running after the
  -- organization was renamed must not make an empty one.
  foreach t in array array['rfp_reviews','comparisons','readings','projects','consultants','schedules','fees','settings','pursuits'] loop
    execute format('alter table %I add column if not exists org_id uuid references organizations on delete cascade', t);
    execute format('select count(*) from %I where org_id is null', t) into n;
    if n > 0 then orphans := true; end if;
  end loop;
  if orphans then
    select id into legacy from organizations where name = 'My organization' order by created_at limit 1;
    if legacy is null then
      insert into organizations (name, ai_monthly_limit_usd, plan) values ('My organization', null, 'owner') returning id into legacy;
    end if;
  end if;

  foreach t in array array['rfp_reviews','comparisons','readings','projects','consultants','schedules','fees','settings','pursuits'] loop
    k := case when t = 'readings' then 'hash' else 'id' end;
    if legacy is not null then
      execute format('update %I set org_id = %L where org_id is null', t, legacy);
    end if;
    execute format('alter table %I alter column org_id set not null', t);
    -- The key becomes (org_id, id): two organizations can never collide or overwrite each other's records.
    execute format('alter table %I drop constraint if exists %I', t, t || '_pkey');
    execute format('alter table %I add primary key (org_id, %I)', t, k);
  end loop;

  alter table feedback add column if not exists org_id uuid references organizations on delete set null;
  alter table feedback add column if not exists user_email text;
end $$;

-- The signed-in person's organization, made on their first visit (atomically, so two first requests can't make two),
-- with this month's AI spending. Called by the server with the secret key.
create or replace function ensure_org(p_user uuid, p_name text, p_limit numeric)
returns table (org_id uuid, org_name text, ai_monthly_limit_usd numeric, spent_this_month numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  o uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));
  select m.org_id into o from org_members m where m.user_id = p_user;
  if o is null then
    insert into organizations (name, ai_monthly_limit_usd) values (p_name, p_limit) returning id into o;
    insert into org_members (user_id, org_id) values (p_user, o);
  end if;
  return query
    select g.id, g.name, g.ai_monthly_limit_usd,
           coalesce((select sum(u.cost_usd) from usage_events u
                     where u.org_id = g.id and u.created_at >= date_trunc('month', now())), 0)
    from organizations g where g.id = o;
end $$;
revoke all on function ensure_org(uuid, text, numeric) from public, anon, authenticated;
grant execute on function ensure_org(uuid, text, numeric) to service_role;

-- After creating your own account, put it in the existing organization (replace the email):
--   insert into org_members (user_id, org_id)
--   select u.id, o.id from auth.users u, organizations o
--   where u.email = 'you@example.com' and o.name = 'My organization'
--   on conflict (user_id) do update set org_id = excluded.org_id;

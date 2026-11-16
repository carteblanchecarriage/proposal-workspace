-- Which organization uploaded each PDF held at Anthropic (its file_id). Run once in Supabase → SQL Editor, after
-- orgs.sql. Safe to re-run.
-- Endpoints that take a file_id from the browser (chat, RFP review, addenda, own-proposal summary) only accept ones
-- their organization uploaded, so a file id from another organization is refused even if someone had it.

create table if not exists org_files (
  file_id text primary key,
  org_id uuid not null references organizations on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists org_files_org on org_files (org_id);
alter table org_files enable row level security;
grant select, insert, update, delete on org_files to service_role;

-- Clean-up after a second run of orgs.sql: the older ensure_org (domain-join.sql replaced it) and an empty
-- "My organization" with no people and no records. Organizations with anyone or anything in them are never touched.
drop function if exists ensure_org(uuid, text, numeric);
delete from organizations g
where g.name = 'My organization'
  and not exists (select 1 from org_members m where m.org_id = g.id)
  and not exists (select 1 from rfp_reviews r where r.org_id = g.id)
  and not exists (select 1 from comparisons r where r.org_id = g.id)
  and not exists (select 1 from readings r where r.org_id = g.id)
  and not exists (select 1 from projects r where r.org_id = g.id)
  and not exists (select 1 from consultants r where r.org_id = g.id)
  and not exists (select 1 from schedules r where r.org_id = g.id)
  and not exists (select 1 from fees r where r.org_id = g.id)
  and not exists (select 1 from settings r where r.org_id = g.id)
  and not exists (select 1 from pursuits r where r.org_id = g.id)
  and not exists (select 1 from usage_events r where r.org_id = g.id);

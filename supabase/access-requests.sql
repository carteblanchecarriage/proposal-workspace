-- Requests for access from the public landing page ("Request access"). Run once in Supabase → SQL Editor. Safe to
-- re-run. Review them in the Table Editor (access_requests), then invite people under Authentication → Users →
-- Invite user, and set status to 'invited' (or 'declined') to keep track.

create table if not exists access_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  firm text,
  note text,
  status text not null default 'new',
  created_at timestamptz not null default now()
);
create index if not exists access_requests_email on access_requests (lower(email), created_at);
create index if not exists access_requests_time on access_requests (created_at);
alter table access_requests enable row level security;
grant select, insert, update, delete on access_requests to service_role;

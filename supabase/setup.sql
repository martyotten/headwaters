-- Headwaters CRM: database setup.
--
-- Paste this whole file into Supabase > SQL Editor > New query, then click Run.
-- It is safe to run more than once.
--
-- Every row belongs to the signed-in user who created it (owner_id), and
-- row-level security makes the database refuse every read or write that is
-- not the owner's own. Visitors who are not signed in get nothing.

create extension if not exists pgcrypto;

-- Contacts ------------------------------------------------------------------
create table if not exists public.contacts (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  company     text,
  title       text,
  email       text,
  phone       text,
  tags        text[] not null default '{}',
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Follow-ups: things to do for a contact, with an optional due date ---------
create table if not exists public.followups (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  contact_id  uuid not null references public.contacts (id) on delete cascade,
  title       text not null check (length(trim(title)) > 0),
  due_on      date,
  done        boolean not null default false,
  done_at     timestamptz,
  created_at  timestamptz not null default now()
);

-- Actions: a dated log of what happened with a contact ----------------------
create table if not exists public.actions (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  contact_id   uuid not null references public.contacts (id) on delete cascade,
  kind         text not null default 'note'
               check (kind in ('call', 'email', 'meeting', 'note', 'other')),
  happened_on  date not null default current_date,
  summary      text not null check (length(trim(summary)) > 0),
  created_at   timestamptz not null default now()
);

create index if not exists contacts_owner_name_idx on public.contacts (owner_id, name);
create index if not exists followups_owner_due_idx on public.followups (owner_id, done, due_on);
create index if not exists followups_contact_idx  on public.followups (contact_id);
create index if not exists actions_contact_idx    on public.actions (contact_id, happened_on desc);

-- Keep contacts.updated_at current -----------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists contacts_touch on public.contacts;
create trigger contacts_touch before update on public.contacts
  for each row execute function public.touch_updated_at();

-- Row-level security: only the owner, only when signed in -------------------
alter table public.contacts  enable row level security;
alter table public.followups enable row level security;
alter table public.actions   enable row level security;

alter table public.contacts  force row level security;
alter table public.followups force row level security;
alter table public.actions   force row level security;

revoke all on public.contacts, public.followups, public.actions from anon;
grant select, insert, update, delete
  on public.contacts, public.followups, public.actions to authenticated;
-- The website form function (netlify/functions/submission-created.js) uses the
-- secret key, which acts as service_role. Newer Supabase projects don't grant
-- new tables to it automatically.
grant select, insert, update
  on public.contacts, public.followups, public.actions to service_role;

drop policy if exists "owner only" on public.contacts;
create policy "owner only" on public.contacts
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- A follow-up or action can only point at one of the owner's own contacts.
drop policy if exists "owner only" on public.followups;
create policy "owner only" on public.followups
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.contacts c
                where c.id = contact_id and c.owner_id = (select auth.uid()))
  );

drop policy if exists "owner only" on public.actions;
create policy "owner only" on public.actions
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.contacts c
                where c.id = contact_id and c.owner_id = (select auth.uid()))
  );

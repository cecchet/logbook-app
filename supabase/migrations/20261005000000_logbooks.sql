-- Digital logbooks -- phase 1: sanctioning bodies, people and their roles,
-- logbooks and their append-only records (see the design document for
-- technical directors).
--
-- Identity is the signed-in email (Supabase email one-time code / magic
-- link): an accreditation or an owner is an email, so a scrutineer or an
-- owner needs no account set up in advance -- they sign in with that email.
--
-- Every write goes through a function below that checks the caller's role
-- (security definer); the tables themselves are read-only to clients, under
-- row level security. Records are append-only: never updated or deleted,
-- each one chained to the previous one by a hash.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Who is calling
-- ---------------------------------------------------------------------------

create or replace function current_email() returns text
language sql stable
set search_path = ''
as $$ select lower(nullif(auth.jwt() ->> 'email', '')) $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Frog Racing administrators (bootstrap: insert the first one from the
-- Supabase SQL editor -- see supabase/README.md).
create table admins (
  email text primary key check (email = lower(email)),
  added_at timestamptz not null default now(),
  added_by text
);

create table bodies (
  id text primary key check (id ~ '^[a-z0-9-]+$'),   -- e.g. 'ara', 'nasa'
  name text not null,
  -- How the body numbers its logbooks, shown to its scrutineers.
  logbook_number_note text,
  created_at timestamptz not null default now(),
  disabled_at timestamptz,
  deleted_at timestamptz
);

-- One per person per body: a technical director is also a scrutineer of
-- that body. Disabled / deleted, never removed, so records signed under an
-- accreditation stay checkable.
create table accreditations (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(email)),
  name text not null,
  body_id text not null references bodies(id),
  role text not null check (role in ('technical_director', 'scrutineer')),
  license_number text,
  -- A body's own short code for the scrutineer (ARA's 2-digit number).
  scrutineer_code text,
  granted_by text not null,
  granted_at timestamptz not null default now(),
  disabled_at timestamptz,
  deleted_at timestamptz,
  unique (email, body_id)
);

create table logbooks (
  id uuid primary key default gen_random_uuid(),
  -- Body-agnostic number, e.g. FL-7K3M-9Q2D (see new_digital_number).
  digital_number text not null unique,
  vin text not null check (vin = upper(vin) and length(vin) between 5 and 20),
  issuing_body text not null references bodies(id),
  status text not null default 'active' check (status in ('active', 'suspended', 'closed')),
  owner_email text not null check (owner_email = lower(owner_email)),
  -- The public link's secret part; reset by the owner or on a transfer.
  public_token text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  public_enabled boolean not null default true,
  -- What the public link shows (see public_logbook).
  privacy jsonb not null default '{"owner": false, "vin": "partial", "builder": true, "cage_photos": true}',
  issued_at timestamptz not null default now(),
  issued_by text not null
);
-- One open logbook per car.
create unique index logbooks_one_per_vin on logbooks (vin) where status <> 'closed';
create index logbooks_owner on logbooks (owner_email);

-- Each body's own logbook number for the car (NASA's pre-printed number,
-- ARA's scrutineer code + last 6 of the VIN...); a car may carry several.
create table logbook_numbers (
  logbook_id uuid not null references logbooks(id),
  body_id text not null references bodies(id),
  number text not null,
  added_at timestamptz not null default now(),
  primary key (logbook_id, body_id),
  unique (body_id, number)
);

-- The logbook itself: append-only, chained.
create table records (
  id uuid primary key default gen_random_uuid(),
  logbook_id uuid not null references logbooks(id),
  seq integer not null,
  kind text not null check (kind in ('issue', 'amendment', 'transfer', 'correction', 'note')),
  -- The record's content: for an issue record, the cage (the rollcage app's
  -- session: vehicle + answers + picture references), the owner's details
  -- and the logbook details.
  body jsonb not null,
  -- A correction points at the record it corrects.
  corrects uuid references records(id),
  author_email text not null,
  accreditation_id uuid not null references accreditations(id),
  created_at timestamptz not null default now(),
  prev_hash text,
  hash text not null,
  unique (logbook_id, seq)
);

-- ---------------------------------------------------------------------------
-- Records: sequence, hash chain, append-only
-- ---------------------------------------------------------------------------

create or replace function record_hash(prev text, kind text, body jsonb, created_at timestamptz, author text)
returns text
language sql immutable
set search_path = ''
as $$
  select encode(extensions.digest(
    coalesce(prev, '') || '|' || kind || '|' || author || '|' ||
    to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || body::text,
    'sha256'), 'hex')
$$;

create or replace function records_before_insert() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  last record;
begin
  -- One writer at a time per logbook, so the chain has no forks.
  perform 1 from public.logbooks where id = new.logbook_id for update;
  select seq, hash into last from public.records
    where logbook_id = new.logbook_id order by seq desc limit 1;
  new.seq := coalesce(last.seq, 0) + 1;
  new.prev_hash := last.hash;
  new.created_at := now();
  new.hash := public.record_hash(new.prev_hash, new.kind, new.body, new.created_at, new.author_email);
  return new;
end $$;

create trigger records_chain before insert on records
  for each row execute function records_before_insert();

create or replace function records_append_only() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'logbook records are append-only: % is not allowed', tg_op;
end $$;

create trigger records_no_update before update or delete on records
  for each row execute function records_append_only();
create trigger records_no_truncate before truncate on records
  for each statement execute function records_append_only();

-- ---------------------------------------------------------------------------
-- Digital logbook numbers: FL-XXXX-XXXC, Crockford base32 (no I, L, O, U),
-- 7 random characters + 1 check character (mod 37) that catches a mistyped
-- or swapped character.
-- ---------------------------------------------------------------------------

create or replace function crockford_check(chars text) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  checks constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ*~$=U';
  n bigint := 0;
  i integer;
begin
  for i in 1 .. length(chars) loop
    n := n * 32 + (strpos(alphabet, substr(chars, i, 1)) - 1);
  end loop;
  return substr(checks, (n % 37)::integer + 1, 1);
end $$;

create or replace function new_digital_number() returns text
language plpgsql volatile
set search_path = ''
as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  bytes bytea;
  chars text;
  candidate text;
  i integer;
begin
  loop
    bytes := extensions.gen_random_bytes(7);
    chars := '';
    for i in 0 .. 6 loop
      chars := chars || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
    end loop;
    chars := chars || public.crockford_check(chars);
    candidate := 'FL-' || substr(chars, 1, 4) || '-' || substr(chars, 5, 4);
    exit when not exists (select 1 from public.logbooks where digital_number = candidate);
  end loop;
  return candidate;
end $$;

-- Whether a typed number is well formed (check character included).
create or replace function digital_number_valid(num text) returns boolean
language sql immutable
set search_path = ''
as $$
  select upper(num) ~ '^FL-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{3}[0-9A-HJKMNP-TV-Z*~$=U]$'
     and substr(upper(num), 12, 1) = public.crockford_check(substr(upper(num), 4, 4) || substr(upper(num), 9, 3))
$$;

-- ---------------------------------------------------------------------------
-- Role checks
-- ---------------------------------------------------------------------------

create or replace function is_admin() returns boolean
language sql stable security definer
set search_path = ''
as $$ select exists (select 1 from public.admins where email = public.current_email()) $$;

-- The caller's active accreditation with a body (null if none).
create or replace function my_accreditation(body text) returns public.accreditations
language sql stable security definer
set search_path = ''
as $$
  select a.* from public.accreditations a
  join public.bodies b on b.id = a.body_id
  where a.email = public.current_email() and a.body_id = body
    and a.disabled_at is null and a.deleted_at is null
    and b.disabled_at is null and b.deleted_at is null
$$;

create or replace function is_scrutineer() returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.accreditations a join public.bodies b on b.id = a.body_id
    where a.email = public.current_email() and a.disabled_at is null and a.deleted_at is null
      and b.disabled_at is null and b.deleted_at is null)
$$;

create or replace function is_technical_director(body text) returns boolean
language sql stable security definer
set search_path = ''
as $$ select coalesce((public.my_accreditation(body)).role = 'technical_director', false) $$;

create or replace function can_read_logbook(lb uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select public.is_admin() or public.is_scrutineer()
      or exists (select 1 from public.logbooks where id = lb and owner_email = public.current_email())
$$;

-- ---------------------------------------------------------------------------
-- Row level security: clients read through these policies; every write goes
-- through the functions below.
-- ---------------------------------------------------------------------------

alter table admins enable row level security;
alter table bodies enable row level security;
alter table accreditations enable row level security;
alter table logbooks enable row level security;
alter table logbook_numbers enable row level security;
alter table records enable row level security;

revoke all on admins, bodies, accreditations, logbooks, logbook_numbers, records from anon, authenticated;
grant select on bodies to anon, authenticated;
grant select on admins, accreditations, logbooks, logbook_numbers, records to authenticated;

create policy admins_read on admins for select to authenticated
  using (email = current_email() or is_admin());

create policy bodies_read on bodies for select to anon, authenticated
  using (deleted_at is null or is_admin());

create policy accreditations_read on accreditations for select to authenticated
  using (email = current_email() or is_admin() or is_technical_director(body_id));

create policy logbooks_read on logbooks for select to authenticated
  using (owner_email = current_email() or is_admin() or is_scrutineer());

create policy logbook_numbers_read on logbook_numbers for select to authenticated
  using (can_read_logbook(logbook_id));

create policy records_read on records for select to authenticated
  using (can_read_logbook(logbook_id));

-- ---------------------------------------------------------------------------
-- Functions: who am I
-- ---------------------------------------------------------------------------

create or replace function my_roles() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'email', public.current_email(),
    'admin', public.is_admin(),
    'accreditations', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'body', a.body_id, 'bodyName', b.name, 'role', a.role,
                                          'license', a.license_number, 'code', a.scrutineer_code) order by b.name)
      from public.accreditations a join public.bodies b on b.id = a.body_id
      where a.email = public.current_email() and a.disabled_at is null and a.deleted_at is null
        and b.disabled_at is null and b.deleted_at is null), '[]'::jsonb))
$$;

-- ---------------------------------------------------------------------------
-- Functions: Frog Racing administration
-- ---------------------------------------------------------------------------

create or replace function add_admin(p_email text) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  insert into public.admins (email, added_by) values (lower(trim(p_email)), public.current_email())
    on conflict (email) do nothing;
end $$;

create or replace function save_body(p_id text, p_name text, p_number_note text default null) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  insert into public.bodies (id, name, logbook_number_note) values (p_id, p_name, p_number_note)
    on conflict (id) do update set name = excluded.name, logbook_number_note = excluded.logbook_number_note;
end $$;

-- p_state: 'active', 'disabled' or 'deleted'.
create or replace function set_body_state(p_id text, p_state text) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  update public.bodies set
    disabled_at = case when p_state = 'active' then null else coalesce(disabled_at, now()) end,
    deleted_at = case when p_state = 'deleted' then coalesce(deleted_at, now()) else null end
  where id = p_id;
end $$;

-- Grant (or update) an accreditation. Frog Racing grants any role; a
-- technical director grants scrutineers of their own body only.
create or replace function grant_accreditation(p_email text, p_name text, p_body text, p_role text,
                                               p_license text default null, p_code text default null)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  result uuid;
begin
  if not (public.is_admin() or (p_role = 'scrutineer' and public.is_technical_director(p_body))) then
    raise exception 'not allowed';
  end if;
  insert into public.accreditations (email, name, body_id, role, license_number, scrutineer_code, granted_by)
  values (lower(trim(p_email)), p_name, p_body, p_role, p_license, p_code, public.current_email())
  on conflict (email, body_id) do update set
    name = excluded.name, role = excluded.role, license_number = excluded.license_number,
    scrutineer_code = excluded.scrutineer_code, granted_by = excluded.granted_by, granted_at = now(),
    disabled_at = null, deleted_at = null
  returning id into result;
  return result;
end $$;

-- p_state: 'active', 'disabled' or 'deleted'. Records signed under it stay valid.
create or replace function set_accreditation_state(p_id uuid, p_state text) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  acc public.accreditations;
begin
  select * into acc from public.accreditations where id = p_id;
  if acc.id is null then raise exception 'no such accreditation'; end if;
  if not (public.is_admin() or (acc.role = 'scrutineer' and public.is_technical_director(acc.body_id))) then
    raise exception 'not allowed';
  end if;
  update public.accreditations set
    disabled_at = case when p_state = 'active' then null else coalesce(disabled_at, now()) end,
    deleted_at = case when p_state = 'deleted' then coalesce(deleted_at, now()) else null end
  where id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- Functions: scrutineers
-- ---------------------------------------------------------------------------

-- Issue a logbook after the physical inspection: the logbook, the body's own
-- number and the signed issue record, all at once.
-- p: { vin, body, ownerEmail, bodyNumber?, record: {...} }
create or replace function issue_logbook(p jsonb) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  acc public.accreditations;
  lb public.logbooks;
  v text := upper(regexp_replace(coalesce(p ->> 'vin', ''), '\s', '', 'g'));
begin
  acc := public.my_accreditation(p ->> 'body');
  if acc.id is null then raise exception 'not a scrutineer of %', p ->> 'body'; end if;
  if exists (select 1 from public.logbooks where vin = v and status <> 'closed') then
    raise exception 'this car (VIN %) already has a logbook', v;
  end if;
  insert into public.logbooks (digital_number, vin, issuing_body, owner_email, issued_by)
  values (public.new_digital_number(), v, acc.body_id, lower(trim(p ->> 'ownerEmail')), acc.email)
  returning * into lb;
  if coalesce(p ->> 'bodyNumber', '') <> '' then
    insert into public.logbook_numbers (logbook_id, body_id, number) values (lb.id, acc.body_id, p ->> 'bodyNumber');
  end if;
  insert into public.records (logbook_id, kind, body, author_email, accreditation_id, seq, hash)
  values (lb.id, 'issue', coalesce(p -> 'record', '{}'::jsonb), acc.email, acc.id, 0, '');
  return jsonb_build_object('id', lb.id, 'digitalNumber', lb.digital_number, 'publicToken', lb.public_token);
end $$;

-- Add a record to a logbook (phase 1: amendments, corrections, notes and
-- ownership transfers; event entries come with the events phase).
-- A transfer's body carries { ownerEmail } and moves the car to that owner,
-- resetting its public link.
create or replace function add_record(p_logbook uuid, p_kind text, p_body jsonb, p_body_id text,
                                      p_corrects uuid default null)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  acc public.accreditations;
  lb public.logbooks;
  rec public.records;
begin
  acc := public.my_accreditation(p_body_id);
  if acc.id is null then raise exception 'not a scrutineer of %', p_body_id; end if;
  if p_kind not in ('amendment', 'transfer', 'correction', 'note') then raise exception 'unknown record kind %', p_kind; end if;
  select * into lb from public.logbooks where id = p_logbook;
  if lb.id is null then raise exception 'no such logbook'; end if;
  if lb.status = 'closed' then raise exception 'this logbook is closed'; end if;
  if p_kind = 'correction' and not exists (select 1 from public.records where id = p_corrects and logbook_id = p_logbook) then
    raise exception 'a correction must name a record of this logbook';
  end if;
  if p_kind = 'transfer' then
    if coalesce(p_body ->> 'ownerEmail', '') = '' then raise exception 'a transfer needs the new owner''s email'; end if;
    update public.logbooks set owner_email = lower(trim(p_body ->> 'ownerEmail')),
      public_token = encode(extensions.gen_random_bytes(16), 'hex')
    where id = p_logbook;
  end if;
  insert into public.records (logbook_id, kind, body, corrects, author_email, accreditation_id, seq, hash)
  values (p_logbook, p_kind, p_body, p_corrects, acc.email, acc.id, 0, '')
  returning * into rec;
  return jsonb_build_object('id', rec.id, 'seq', rec.seq, 'hash', rec.hash);
end $$;

-- ---------------------------------------------------------------------------
-- Functions: owners
-- ---------------------------------------------------------------------------

create or replace function my_garage() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', l.id, 'digitalNumber', l.digital_number, 'vin', l.vin, 'body', l.issuing_body, 'status', l.status,
    'publicToken', l.public_token, 'publicEnabled', l.public_enabled, 'privacy', l.privacy,
    'bodyNumbers', (select coalesce(jsonb_object_agg(n.body_id, n.number), '{}'::jsonb) from public.logbook_numbers n where n.logbook_id = l.id),
    'vehicle', (select r.body -> 'vehicle' from public.records r where r.logbook_id = l.id and r.kind = 'issue')
  ) order by l.issued_at), '[]'::jsonb)
  from public.logbooks l where l.owner_email = public.current_email()
$$;

create or replace function set_privacy(p_logbook uuid, p_privacy jsonb, p_public_enabled boolean) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.logbooks set
    privacy = jsonb_build_object(
      'owner', coalesce((p_privacy ->> 'owner')::boolean, false),
      'vin', case when p_privacy ->> 'vin' in ('full', 'partial', 'hidden') then p_privacy ->> 'vin' else 'partial' end,
      'builder', coalesce((p_privacy ->> 'builder')::boolean, true),
      'cage_photos', coalesce((p_privacy ->> 'cage_photos')::boolean, true)),
    public_enabled = p_public_enabled
  where id = p_logbook and owner_email = public.current_email();
  if not found then raise exception 'not your logbook'; end if;
end $$;

create or replace function reset_public_link(p_logbook uuid) returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  token text := encode(extensions.gen_random_bytes(16), 'hex');
begin
  update public.logbooks set public_token = token
  where id = p_logbook and owner_email = public.current_email();
  if not found then raise exception 'not your logbook'; end if;
  return token;
end $$;

-- ---------------------------------------------------------------------------
-- Public link: what anyone with the link sees, filtered by the owner's
-- privacy choices. Records keep their hashes so the chain can be checked.
-- ---------------------------------------------------------------------------

create or replace function public_logbook(p_token text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  lb public.logbooks;
  pv jsonb;
  shown_vin text;
begin
  select * into lb from public.logbooks where public_token = p_token and public_enabled;
  if lb.id is null then return null; end if;
  pv := lb.privacy;
  shown_vin := case pv ->> 'vin' when 'full' then lb.vin when 'hidden' then null
                    else repeat('*', greatest(length(lb.vin) - 6, 0)) || right(lb.vin, 6) end;
  return jsonb_build_object(
    'digitalNumber', lb.digital_number,
    'vin', shown_vin,
    'body', lb.issuing_body,
    'bodyName', (select name from public.bodies where id = lb.issuing_body),
    'status', lb.status,
    'issuedAt', lb.issued_at,
    'bodyNumbers', (select coalesce(jsonb_object_agg(n.body_id, n.number), '{}'::jsonb) from public.logbook_numbers n where n.logbook_id = lb.id),
    'records', (select coalesce(jsonb_agg(jsonb_build_object(
        'seq', r.seq, 'kind', r.kind, 'createdAt', r.created_at, 'author', a.name, 'license', a.license_number,
        'authorBody', a.body_id, 'hash', r.hash, 'prevHash', r.prev_hash,
        'body', public.public_record_body(r.body, pv)) order by r.seq), '[]'::jsonb)
      from public.records r join public.accreditations a on a.id = r.accreditation_id
      where r.logbook_id = lb.id));
end $$;

-- A record's content as the public link shows it: the owner's details,
-- the builder and the cage photos only when the owner allows them; the VIN
-- per the VIN setting. (The public copy can't be hash-checked once fields
-- are removed -- the "Verified" check is made on the server's full copy.)
create or replace function public_record_body(b jsonb, pv jsonb) returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  out jsonb := b;
  answers jsonb;
begin
  if not coalesce((pv ->> 'owner')::boolean, false) then out := out - 'owner'; end if;
  out := out - 'techSheets' - 'paperPages' - 'damagePhotos';
  if not coalesce((pv ->> 'cage_photos')::boolean, true) then out := out - 'pictures'; end if;
  answers := out #> '{cage,answers}';
  if answers is not null then
    answers := answers - 'vehicle_vin';
    if not coalesce((pv ->> 'builder')::boolean, true) then
      answers := answers - 'vehicle_builder' - 'vehicle_builder_name' - 'vehicle_builder_address'
                         - 'vehicle_builder_email' - 'vehicle_builder_phone';
    end if;
    answers := answers - 'vehicle_owner_name' - 'vehicle_owner_address' - 'vehicle_owner_email' - 'vehicle_owner_phone';
    out := jsonb_set(out, '{cage,answers}', answers);
  end if;
  return out;
end $$;

-- ---------------------------------------------------------------------------
-- Who may call what. (Postgres lets everyone execute a new function by
-- default: take that back, then grant each one to its callers.)
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function current_email, is_admin, my_accreditation, is_scrutineer, is_technical_director,
  can_read_logbook, my_roles, add_admin, save_body, set_body_state, grant_accreditation,
  set_accreditation_state, issue_logbook, add_record, my_garage, set_privacy, reset_public_link,
  digital_number_valid
  to authenticated;
-- (current_email / is_admin: the bodies policy runs them for anon readers too.)
grant execute on function public_logbook, digital_number_valid, current_email, is_admin to anon;
-- (digital_number_valid runs as its caller and calls crockford_check.)
grant execute on function crockford_check to anon, authenticated;

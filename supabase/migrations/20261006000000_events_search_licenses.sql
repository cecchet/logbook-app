-- Digital logbooks -- second migration:
--  - scrutineer licenses that expire, renewed by the technical director;
--  - cars without a VIN (custom builds): the VIN becomes optional, and only
--    a real 17-character VIN must be unique; the car's make, model, year and
--    owner's name are kept on the logbook for searching;
--  - search_logbooks: find a logbook by any of those;
--  - events: staff (chief scrutineer, scrutineers), the competitor list
--    (car number, driver, logbook -- or the car's details when it has none)
--    and each car's tech status; inspection records can only be added by the
--    event's staff, during its window, for a logbook the event accepts.

-- ---------------------------------------------------------------------------
-- Licenses that expire
-- ---------------------------------------------------------------------------

alter table accreditations add column license_expires date;

-- Active = not disabled or deleted, license not expired, body active.
create or replace function accreditation_active(a public.accreditations) returns boolean
language sql stable
set search_path = ''
as $$
  select a.disabled_at is null and a.deleted_at is null
     and (a.license_expires is null or a.license_expires >= current_date)
     and exists (select 1 from public.bodies b where b.id = a.body_id and b.disabled_at is null and b.deleted_at is null)
$$;

create or replace function my_accreditation(body text) returns public.accreditations
language sql stable security definer
set search_path = ''
as $$
  select a.* from public.accreditations a
  where a.email = public.current_email() and a.body_id = body and public.accreditation_active(a)
$$;

create or replace function is_scrutineer() returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.accreditations a where a.email = public.current_email() and public.accreditation_active(a))
$$;

create or replace function my_roles() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'email', public.current_email(),
    'admin', public.is_admin(),
    'accreditations', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'body', a.body_id, 'bodyName', b.name, 'role', a.role,
                                          'license', a.license_number, 'code', a.scrutineer_code,
                                          'licenseExpires', a.license_expires) order by b.name)
      from public.accreditations a join public.bodies b on b.id = a.body_id
      where a.email = public.current_email() and public.accreditation_active(a)), '[]'::jsonb),
    -- Accreditations whose license has run out: shown so the person knows why.
    'expired', coalesce((
      select jsonb_agg(jsonb_build_object('body', a.body_id, 'bodyName', b.name, 'licenseExpires', a.license_expires))
      from public.accreditations a join public.bodies b on b.id = a.body_id
      where a.email = public.current_email() and a.disabled_at is null and a.deleted_at is null
        and a.license_expires < current_date), '[]'::jsonb))
$$;

drop function grant_accreditation(text, text, text, text, text, text);
create or replace function grant_accreditation(p_email text, p_name text, p_body text, p_role text,
                                               p_license text default null, p_code text default null,
                                               p_expires date default null)
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
  insert into public.accreditations (email, name, body_id, role, license_number, scrutineer_code, license_expires, granted_by)
  values (lower(trim(p_email)), p_name, p_body, p_role, p_license, p_code, p_expires, public.current_email())
  on conflict (email, body_id) do update set
    name = excluded.name, role = excluded.role, license_number = excluded.license_number,
    scrutineer_code = excluded.scrutineer_code, license_expires = excluded.license_expires,
    granted_by = excluded.granted_by, granted_at = now(), disabled_at = null, deleted_at = null
  returning id into result;
  return result;
end $$;

-- A new expiry date (usually a year later, after the yearly test).
create or replace function renew_license(p_id uuid, p_expires date) returns void
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
  update public.accreditations set license_expires = p_expires where id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- Cars without a VIN; searchable car details
-- ---------------------------------------------------------------------------

alter table logbooks drop constraint logbooks_vin_check;
alter table logbooks alter column vin drop not null;
alter table logbooks add constraint logbooks_vin_check check (vin is null or (vin = upper(vin) and length(vin) between 3 and 30));
-- true: a manufacturer's 17-character VIN, unique among open logbooks;
-- false: a builder's chassis or serial number, which may repeat.
alter table logbooks add column has_vin boolean not null default false;
alter table logbooks add column make text, add column model text, add column year text,
  add column car_name text, add column owner_name text;

drop index logbooks_one_per_vin;
create unique index logbooks_one_per_vin on logbooks (vin) where has_vin and status <> 'closed';

-- Logbooks issued before this migration.
update logbooks l set
  has_vin = coalesce(l.vin ~ '^[A-HJ-NPR-Z0-9]{17}$', false),
  make = r.body #>> '{vehicle,make}', model = r.body #>> '{vehicle,model}', year = r.body #>> '{vehicle,year}',
  car_name = r.body #>> '{vehicle,name}', owner_name = r.body #>> '{owner,name}'
from records r where r.logbook_id = l.id and r.kind = 'issue';

-- p: { vin?, body, ownerEmail, ownerName?, bodyNumber?, vehicle: { make, model, year, name },
--      record: {...}, allowDuplicate? }
-- A real VIN already on an open logbook is refused. A chassis number (or a
-- car with no number at all) that looks like an existing logbook -- same
-- number, or same make, model and year with the same owner -- is refused
-- with the matches listed, unless allowDuplicate confirms it's another car.
drop function issue_logbook(jsonb);
create or replace function issue_logbook(p jsonb) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  acc public.accreditations;
  lb public.logbooks;
  v text := nullif(upper(regexp_replace(coalesce(p ->> 'vin', ''), '\s', '', 'g')), '');
  is_vin boolean;
  owner text := lower(trim(coalesce(p ->> 'ownerEmail', '')));
  matches text;
begin
  acc := public.my_accreditation(p ->> 'body');
  if acc.id is null then raise exception 'not an active scrutineer of %', p ->> 'body'; end if;
  if owner !~ '^[^@\s]+@[^@\s]+$' then raise exception 'the owner''s email is needed'; end if;
  is_vin := coalesce(v ~ '^[A-HJ-NPR-Z0-9]{17}$', false);
  if is_vin and exists (select 1 from public.logbooks where vin = v and has_vin and status <> 'closed') then
    raise exception 'this car (VIN %) already has a logbook', v;
  end if;
  if not coalesce((p ->> 'allowDuplicate')::boolean, false) then
    select string_agg(digital_number, ', ') into matches from public.logbooks l
    where l.status <> 'closed' and not is_vin and (
      (v is not null and l.vin = v)
      or (l.owner_email = owner and lower(coalesce(l.make, '')) = lower(coalesce(p #>> '{vehicle,make}', ''))
          and lower(coalesce(l.model, '')) = lower(coalesce(p #>> '{vehicle,model}', ''))
          and coalesce(l.year, '') = coalesce(p #>> '{vehicle,year}', '')));
    if matches is not null then raise exception 'possible duplicate of %', matches; end if;
  end if;
  insert into public.logbooks (digital_number, vin, has_vin, issuing_body, owner_email, owner_name, make, model, year, car_name, issued_by)
  values (public.new_digital_number(), v, is_vin, acc.body_id, owner, nullif(p ->> 'ownerName', ''),
          nullif(p #>> '{vehicle,make}', ''), nullif(p #>> '{vehicle,model}', ''), nullif(p #>> '{vehicle,year}', ''),
          nullif(p #>> '{vehicle,name}', ''), acc.email)
  returning * into lb;
  if coalesce(p ->> 'bodyNumber', '') <> '' then
    insert into public.logbook_numbers (logbook_id, body_id, number) values (lb.id, acc.body_id, p ->> 'bodyNumber');
  end if;
  insert into public.records (logbook_id, kind, body, author_email, accreditation_id, seq, hash)
  values (lb.id, 'issue', coalesce(p -> 'record', '{}'::jsonb), acc.email, acc.id, 0, '');
  return jsonb_build_object('id', lb.id, 'digitalNumber', lb.digital_number, 'publicToken', lb.public_token);
end $$;

-- Find logbooks (scrutineers and admins). f: { text?, body?, make?, model?,
-- year?, owner?, status? } -- text matches the digital number, the VIN or
-- chassis number, a body's logbook number, the car's name, make or model,
-- and the owner's name or email; the others narrow it down. Newest first,
-- at most 50.
create or replace function search_logbooks(f jsonb) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  t text := '%' || coalesce(nullif(trim(f ->> 'text'), ''), '') || '%';
  has_text boolean := coalesce(nullif(trim(f ->> 'text'), ''), '') <> '';
begin
  if not (public.is_admin() or public.is_scrutineer()) then raise exception 'not allowed'; end if;
  return coalesce((select jsonb_agg(x order by x ->> 'issuedAt' desc) from (
    select jsonb_build_object(
      'id', l.id, 'digitalNumber', l.digital_number, 'vin', l.vin, 'hasVin', l.has_vin, 'body', l.issuing_body,
      'status', l.status, 'make', l.make, 'model', l.model, 'year', l.year, 'carName', l.car_name,
      'ownerName', l.owner_name, 'ownerEmail', l.owner_email, 'issuedAt', l.issued_at,
      'bodyNumbers', (select coalesce(jsonb_object_agg(n.body_id, n.number), '{}'::jsonb) from public.logbook_numbers n where n.logbook_id = l.id)) as x
    from public.logbooks l
    where (not has_text or l.digital_number ilike t or l.vin ilike t or l.car_name ilike t or l.make ilike t
           or l.model ilike t or l.owner_name ilike t or l.owner_email ilike t
           or exists (select 1 from public.logbook_numbers n where n.logbook_id = l.id and n.number ilike t))
      and (coalesce(f ->> 'body', '') = '' or l.issuing_body = f ->> 'body')
      and (coalesce(f ->> 'make', '') = '' or l.make ilike '%' || (f ->> 'make') || '%')
      and (coalesce(f ->> 'model', '') = '' or l.model ilike '%' || (f ->> 'model') || '%')
      and (coalesce(f ->> 'year', '') = '' or l.year = f ->> 'year')
      and (coalesce(f ->> 'owner', '') = '' or l.owner_name ilike '%' || (f ->> 'owner') || '%' or l.owner_email ilike '%' || (f ->> 'owner') || '%')
      and (coalesce(f ->> 'status', '') = '' or l.status = f ->> 'status')
    order by l.issued_at desc limit 50) s), '[]'::jsonb);
end $$;

-- Transfers also carry the new owner's name.
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
  if acc.id is null then raise exception 'not an active scrutineer of %', p_body_id; end if;
  if p_kind not in ('amendment', 'transfer', 'correction', 'note') then raise exception 'unknown record kind %', p_kind; end if;
  select * into lb from public.logbooks where id = p_logbook;
  if lb.id is null then raise exception 'no such logbook'; end if;
  if lb.status = 'closed' then raise exception 'this logbook is closed'; end if;
  if p_kind = 'correction' and not exists (select 1 from public.records where id = p_corrects and logbook_id = p_logbook) then
    raise exception 'a correction must name a record of this logbook';
  end if;
  if p_kind = 'transfer' then
    if coalesce(p_body ->> 'ownerEmail', '') = '' then raise exception 'a transfer needs the new owner''s email'; end if;
    update public.logbooks set owner_email = lower(trim(p_body ->> 'ownerEmail')), owner_name = nullif(p_body ->> 'ownerName', ''),
      public_token = encode(extensions.gen_random_bytes(16), 'hex')
    where id = p_logbook;
  end if;
  insert into public.records (logbook_id, kind, body, corrects, author_email, accreditation_id, seq, hash)
  values (p_logbook, p_kind, p_body, p_corrects, acc.email, acc.id, 0, '')
  returning * into rec;
  return jsonb_build_object('id', rec.id, 'seq', rec.seq, 'hash', rec.hash);
end $$;

-- ---------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------

create table events (
  id uuid primary key default gen_random_uuid(),
  body_id text not null references bodies(id),
  name text not null,
  location text,
  scrutineering_starts_on date not null,
  starts_on date not null,
  ends_on date not null,
  -- Logbooks this event accepts, by issuing body (always includes its own).
  accepted_bodies text[] not null default '{}',
  created_by text not null,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  check (scrutineering_starts_on <= starts_on and starts_on <= ends_on)
);

create table event_staff (
  event_id uuid not null references events(id),
  email text not null check (email = lower(email)),
  role text not null check (role in ('chief', 'scrutineer')),
  primary key (event_id, email)
);

-- The competitor list: one row per car entered.
create table event_entries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id),
  car_number text not null,
  driver text,
  codriver text,
  class text,
  logbook_id uuid references logbooks(id),
  -- The car, when it has no logbook yet (make, model, year...).
  vehicle jsonb,
  tech_status text not null default 'pending' check (tech_status in ('pending', 'passed', 'failed', 'withdrawn')),
  updated_at timestamptz not null default now(),
  unique (event_id, car_number)
);

alter table records add column event_id uuid references events(id);
alter table records drop constraint records_kind_check;
alter table records add constraint records_kind_check
  check (kind in ('issue', 'amendment', 'transfer', 'correction', 'note', 'inspection', 'post_event', 'dnf'));

alter table events enable row level security;
alter table event_staff enable row level security;
alter table event_entries enable row level security;
revoke all on events, event_staff, event_entries from anon, authenticated;
grant select on events, event_staff, event_entries to authenticated;
-- Every scrutineer can see events (they may work another body's); owners
-- and the public can't (yet -- see the marshal mode in the design notes).
create policy events_read on events for select to authenticated using (is_admin() or is_scrutineer());
create policy event_staff_read on event_staff for select to authenticated using (is_admin() or is_scrutineer());
create policy event_entries_read on event_entries for select to authenticated using (is_admin() or is_scrutineer());

-- Organizers: the body's technical director, or Frog Racing.
create or replace function can_organize(p_body text) returns boolean
language sql stable security definer
set search_path = ''
as $$ select public.is_admin() or public.is_technical_director(p_body) $$;

create or replace function event_role(p_event uuid) returns text
language sql stable security definer
set search_path = ''
as $$ select role from public.event_staff where event_id = p_event and email = public.current_email() $$;

-- The window for event records: from the start of scrutineering to the day
-- after the event ends (cars that went off may only be reached then).
create or replace function event_open(e public.events) returns boolean
language sql stable
set search_path = ''
as $$ select e.cancelled_at is null and current_date between e.scrutineering_starts_on and e.ends_on + 1 $$;

-- Create (p.id omitted) or update an event. p: { id?, body, name, location,
-- scrutineeringStartsOn, startsOn, endsOn, acceptedBodies: [...] }
create or replace function save_event(p jsonb) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  result uuid;
  accepted text[] := array(select distinct x from jsonb_array_elements_text(coalesce(p -> 'acceptedBodies', '[]'::jsonb)) x
                           union select p ->> 'body');
begin
  if not public.can_organize(p ->> 'body') then raise exception 'not allowed'; end if;
  if p ? 'id' and p ->> 'id' <> '' then
    update public.events set name = p ->> 'name', location = p ->> 'location',
      scrutineering_starts_on = (p ->> 'scrutineeringStartsOn')::date, starts_on = (p ->> 'startsOn')::date,
      ends_on = (p ->> 'endsOn')::date, accepted_bodies = accepted
    where id = (p ->> 'id')::uuid and body_id = p ->> 'body'
    returning id into result;
    if result is null then raise exception 'no such event'; end if;
  else
    insert into public.events (body_id, name, location, scrutineering_starts_on, starts_on, ends_on, accepted_bodies, created_by)
    values (p ->> 'body', p ->> 'name', p ->> 'location', (p ->> 'scrutineeringStartsOn')::date, (p ->> 'startsOn')::date,
            (p ->> 'endsOn')::date, accepted, public.current_email())
    returning id into result;
  end if;
  return result;
end $$;

-- p_role: 'chief', 'scrutineer', or null to take the person off the event.
create or replace function set_event_staff(p_event uuid, p_email text, p_role text) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  ev public.events;
begin
  select * into ev from public.events where id = p_event;
  if ev.id is null or not public.can_organize(ev.body_id) then raise exception 'not allowed'; end if;
  if p_role is null then
    delete from public.event_staff where event_id = p_event and email = lower(trim(p_email));
  else
    insert into public.event_staff (event_id, email, role) values (p_event, lower(trim(p_email)), p_role)
      on conflict (event_id, email) do update set role = excluded.role;
  end if;
end $$;

-- Add or update a competitor. p: { carNumber, driver?, codriver?, class?,
-- logbookId? | vehicle? } -- by the organizers or the chief scrutineer.
create or replace function save_entry(p_event uuid, p jsonb) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  ev public.events;
  result uuid;
begin
  select * into ev from public.events where id = p_event;
  if ev.id is null or not (public.can_organize(ev.body_id) or public.event_role(p_event) = 'chief') then raise exception 'not allowed'; end if;
  insert into public.event_entries (event_id, car_number, driver, codriver, class, logbook_id, vehicle)
  values (p_event, p ->> 'carNumber', p ->> 'driver', p ->> 'codriver', p ->> 'class', nullif(p ->> 'logbookId', '')::uuid, p -> 'vehicle')
  on conflict (event_id, car_number) do update set driver = excluded.driver, codriver = excluded.codriver,
    class = excluded.class, logbook_id = excluded.logbook_id, vehicle = excluded.vehicle, updated_at = now()
  returning id into result;
  return result;
end $$;

-- An inspection, post-event (parc ferme) or DNF record for a competitor's
-- logbook: only the event's staff, only during its window, only for a
-- logbook issued by a body the event accepts. p_status (inspection and
-- post-event) sets the car's tech status: 'passed' or 'failed'.
create or replace function add_event_record(p_entry uuid, p_kind text, p_body jsonb, p_status text default null)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  en public.event_entries;
  ev public.events;
  lb public.logbooks;
  acc public.accreditations;
  rec public.records;
begin
  if p_kind not in ('inspection', 'post_event', 'dnf') then raise exception 'unknown event record kind %', p_kind; end if;
  select * into en from public.event_entries where id = p_entry;
  select * into ev from public.events where id = en.event_id;
  if ev.id is null then raise exception 'no such entry'; end if;
  if public.event_role(ev.id) is null then raise exception 'you are not on this event''s staff'; end if;
  if not public.event_open(ev) then raise exception 'this event is not open for records (scrutineering % to the day after %)', ev.scrutineering_starts_on, ev.ends_on; end if;
  -- Signed as the event's body's scrutineer -- or, for staff accredited by
  -- another body only, under one of their own active accreditations.
  acc := public.my_accreditation(ev.body_id);
  if acc.id is null then
    select a.* into acc from public.accreditations a
    where a.email = public.current_email() and public.accreditation_active(a) order by a.granted_at limit 1;
  end if;
  if acc.id is null then raise exception 'not an active scrutineer'; end if;
  select * into lb from public.logbooks where id = en.logbook_id;
  if lb.id is null then raise exception 'car % has no logbook', en.car_number; end if;
  if not (lb.issuing_body = any (ev.accepted_bodies)) then raise exception 'this event does not accept % logbooks', lb.issuing_body; end if;
  insert into public.records (logbook_id, kind, body, author_email, accreditation_id, event_id, seq, hash)
  values (lb.id, p_kind, p_body, acc.email, acc.id, ev.id, 0, '')
  returning * into rec;
  if p_status in ('passed', 'failed', 'withdrawn') then
    update public.event_entries set tech_status = p_status, updated_at = now() where id = p_entry;
  end if;
  return jsonb_build_object('id', rec.id, 'seq', rec.seq, 'hash', rec.hash);
end $$;

-- The events a person works (staff) or organizes, with tech progress.
create or replace function my_events() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id, 'body', e.body_id, 'name', e.name, 'location', e.location,
    'scrutineeringStartsOn', e.scrutineering_starts_on, 'startsOn', e.starts_on, 'endsOn', e.ends_on,
    'acceptedBodies', e.accepted_bodies, 'open', public.event_open(e), 'myRole', public.event_role(e.id),
    'organizer', public.can_organize(e.body_id),
    'cars', (select count(*) from public.event_entries x where x.event_id = e.id and x.tech_status <> 'withdrawn'),
    'passed', (select count(*) from public.event_entries x where x.event_id = e.id and x.tech_status = 'passed'),
    'failed', (select count(*) from public.event_entries x where x.event_id = e.id and x.tech_status = 'failed'),
    'pending', (select count(*) from public.event_entries x where x.event_id = e.id and x.tech_status = 'pending')
  ) order by e.starts_on desc), '[]'::jsonb)
  from public.events e
  where e.cancelled_at is null and (public.event_role(e.id) is not null or public.can_organize(e.body_id))
$$;

-- Everything a scrutineer needs to work an event offline: the competitor
-- list and every entered car's logbook with its records.
create or replace function event_bundle(p_event uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  ev public.events;
begin
  select * into ev from public.events where id = p_event;
  if ev.id is null or not (public.event_role(p_event) is not null or public.can_organize(ev.body_id)) then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'event', to_jsonb(ev),
    'staff', (select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from public.event_staff s where s.event_id = p_event),
    'entries', (select coalesce(jsonb_agg(jsonb_build_object(
        'entry', to_jsonb(x),
        'logbook', (select to_jsonb(l) - 'public_token' from public.logbooks l where l.id = x.logbook_id),
        'records', (select coalesce(jsonb_agg(to_jsonb(r) order by r.seq), '[]'::jsonb) from public.records r where r.logbook_id = x.logbook_id)
      ) order by x.car_number), '[]'::jsonb)
      from public.event_entries x where x.event_id = p_event));
end $$;

-- ---------------------------------------------------------------------------
-- Grants (see the first migration: nothing is executable unless granted)
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function current_email, is_admin, my_accreditation, is_scrutineer, is_technical_director,
  can_read_logbook, my_roles, add_admin, save_body, set_body_state, grant_accreditation,
  set_accreditation_state, renew_license, issue_logbook, add_record, search_logbooks, my_garage, set_privacy,
  reset_public_link, digital_number_valid, crockford_check, accreditation_active,
  can_organize, event_role, event_open, save_event, set_event_staff, save_entry, add_event_record, my_events, event_bundle
  to authenticated;
grant execute on function public_logbook, digital_number_valid, crockford_check, current_email, is_admin to anon;

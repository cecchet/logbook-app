-- Disciplines inside a sanctioning body (e.g. SCCNH: Autocross, Gravel Trials): each with its
-- own events, scrutineers and annual stickers. A body with none works as before.
--  - body_disciplines: a body's disciplines (System admins and the body's all-disciplines
--    technical directors manage them).
--  - accreditations.discipline: the discipline an accreditation is for -- null: all of the
--    body's. One person can hold one per discipline (a technical director for Gravel Trials, a
--    scrutineer for Autocross), each with its license, expiry and permissions.
--  - Permissions count per discipline: what someone may do in a discipline is what their
--    accreditations for it, and their all-disciplines one, allow (my_permissions_in). Managing an
--    accreditation for a discipline takes holding its permissions in that discipline; an
--    all-disciplines one, holding them for all.
--  - events.discipline: an event's discipline; its tech sheets are signed under the scrutineer's
--    accreditation for it.
--  - stickers / sticker_applications.discipline: an annual sticker is for a body's discipline
--    and season ("SCCNH · AUTOX · 2026").
--  - Logbooks stay the body's: issuing one, or adding an entry, takes the permission in any of
--    the body's disciplines.

create table if not exists body_disciplines (
  body_id text not null references bodies(id),
  id text not null check (id ~ '^[a-z0-9-]+$'),
  name text not null,
  -- The short form printed on stickers (e.g. "AUTOX").
  short text,
  position int not null default 0,
  archived_at timestamptz,
  primary key (body_id, id)
);
alter table body_disciplines enable row level security;
revoke all on body_disciplines from anon, authenticated;
grant select on body_disciplines to anon, authenticated;
drop policy if exists body_disciplines_read on body_disciplines;
create policy body_disciplines_read on body_disciplines for select to anon, authenticated using (true);

alter table accreditations add column if not exists discipline text;
alter table accreditations drop constraint if exists accreditations_discipline_fkey;
alter table accreditations add constraint accreditations_discipline_fkey foreign key (body_id, discipline) references body_disciplines (body_id, id);
alter table accreditations drop constraint if exists accreditations_email_body_id_key;
create unique index if not exists accreditations_one_per_discipline on accreditations (email, body_id, coalesce(discipline, ''));

alter table events add column if not exists discipline text;
alter table events drop constraint if exists events_discipline_fkey;
alter table events add constraint events_discipline_fkey foreign key (body_id, discipline) references body_disciplines (body_id, id);
alter table stickers add column if not exists discipline text;
alter table sticker_applications add column if not exists discipline text;

-- The discipline's name and short form ("" when none).
create or replace function discipline_name(p_body text, p_discipline text) returns text
language sql stable security definer
set search_path = ''
as $$ select coalesce((select d.name from public.body_disciplines d where d.body_id = p_body and d.id = p_discipline), '') $$;

create or replace function discipline_short(p_body text, p_discipline text) returns text
language sql stable security definer
set search_path = ''
as $$ select coalesce((select coalesce(nullif(d.short, ''), upper(d.id)) from public.body_disciplines d where d.body_id = p_body and d.id = p_discipline), '') $$;

-- The caller's accreditation to sign with for a body: the all-disciplines one first, then a
-- technical director's, then the oldest.
create or replace function my_accreditation(body text) returns public.accreditations
language sql stable security definer
set search_path = ''
as $$
  select a.* from public.accreditations a
  where a.email = public.current_email() and a.body_id = body and public.accreditation_active(a)
  order by (a.discipline is null) desc, (a.role = 'technical_director') desc, a.granted_at
  limit 1
$$;

-- ... for a discipline (null: any of the body's): the one for that discipline, else the
-- all-disciplines one.
create or replace function my_accreditation_for(p_body text, p_discipline text) returns public.accreditations
language sql stable security definer
set search_path = ''
as $$
  select a.* from public.accreditations a
  where a.email = public.current_email() and a.body_id = p_body and public.accreditation_active(a)
    and (p_discipline is null or a.discipline is null or a.discipline = p_discipline)
  order by (a.discipline is not distinct from p_discipline) desc, (a.discipline is null) desc, (a.role = 'technical_director') desc, a.granted_at
  limit 1
$$;

-- The caller's permissions with a body, in any of its disciplines (every one for a System admin).
create or replace function my_permissions(p_body text) returns text[]
language sql stable security definer
set search_path = ''
as $$
  select case when public.is_admin() then public.all_permissions() else coalesce((
    select array_agg(distinct x) from public.accreditations a, unnest(public.accreditation_permissions(a)) x
    where a.email = public.current_email() and a.body_id = p_body and public.accreditation_active(a)), '{}'::text[]) end
$$;

-- ... in one discipline (its accreditations and the all-disciplines one), or, for null, the
-- body as a whole (the all-disciplines accreditations only).
create or replace function my_permissions_in(p_body text, p_discipline text) returns text[]
language sql stable security definer
set search_path = ''
as $$
  select case when public.is_admin() then public.all_permissions() else coalesce((
    select array_agg(distinct x) from public.accreditations a, unnest(public.accreditation_permissions(a)) x
    where a.email = public.current_email() and a.body_id = p_body and public.accreditation_active(a)
      and (a.discipline is null or a.discipline = p_discipline)), '{}'::text[]) end
$$;

create or replace function has_permission_in(p_body text, p_discipline text, p_perm text) returns boolean
language sql stable security definer
set search_path = ''
as $$ select p_perm = any (public.my_permissions_in(p_body, p_discipline)) $$;

create or replace function is_technical_director(body text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.accreditations a where a.email = public.current_email() and a.body_id = body
                 and a.role = 'technical_director' and public.accreditation_active(a))
$$;

-- Whether the caller may change this accreditation: an admin, or someone holding every
-- permission it holds in its discipline (all of the body's, for an all-disciplines one) --
-- never a technical director's, nor their own.
create or replace function can_change_accreditation(a public.accreditations) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select public.is_admin() or (a.role <> 'technical_director' and a.email <> public.current_email()
    and public.accreditation_permissions(a) <@ public.my_permissions_in(a.body_id, a.discipline))
$$;

-- Adds, renames or archives one of a body's disciplines: System admins, and the body's
-- all-disciplines technical directors.
create or replace function save_discipline(p_body text, p_id text, p_name text, p_short text default null, p_archived boolean default false) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not (public.is_admin() or exists (select 1 from public.accreditations a where a.email = public.current_email() and a.body_id = p_body
          and a.discipline is null and a.role = 'technical_director' and public.accreditation_active(a))) then
    raise exception 'only Frog Racing and the body''s technical directors manage its disciplines';
  end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'the discipline needs a name'; end if;
  insert into public.body_disciplines (body_id, id, name, short, position)
  values (p_body, lower(trim(p_id)), trim(p_name), nullif(upper(trim(coalesce(p_short, ''))), ''),
          (select coalesce(max(position), 0) + 1 from public.body_disciplines where body_id = p_body))
  on conflict (body_id, id) do update set name = excluded.name, short = excluded.short,
    archived_at = case when p_archived then coalesce(public.body_disciplines.archived_at, now()) else null end;
end $$;

create or replace function my_roles() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'email', public.current_email(),
    'admin', public.is_admin(),
    'accreditations', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'body', a.body_id, 'bodyName', b.name, 'role', a.role,
                                          'discipline', a.discipline, 'disciplineName', public.discipline_name(a.body_id, a.discipline),
                                          'license', a.license_number, 'code', a.scrutineer_code,
                                          'licenseExpires', a.license_expires,
                                          'permissions', to_jsonb(public.accreditation_permissions(a))) order by b.name, a.discipline nulls first)
      from public.accreditations a join public.bodies b on b.id = a.body_id
      where a.email = public.current_email() and public.accreditation_active(a)), '[]'::jsonb),
    -- Accreditations whose license has run out: shown so the person knows why.
    'expired', coalesce((
      select jsonb_agg(jsonb_build_object('body', a.body_id, 'bodyName', b.name, 'discipline', a.discipline, 'licenseExpires', a.license_expires))
      from public.accreditations a join public.bodies b on b.id = a.body_id
      where a.email = public.current_email() and a.disabled_at is null and a.deleted_at is null
        and a.license_expires < current_date), '[]'::jsonb))
$$;

-- Add (or update) an accreditation, for a discipline (null: all of the body's). The checks are
-- the permissions one's, counted in that discipline.
drop function if exists grant_accreditation(text, text, text, text, text, text, date, text[]);
create or replace function grant_accreditation(p_email text, p_name text, p_body text, p_role text,
                                               p_license text default null, p_code text default null,
                                               p_expires date default null, p_permissions text[] default null,
                                               p_discipline text default null)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  result uuid;
  admin boolean := public.is_admin();
  disc text := nullif(trim(coalesce(p_discipline, '')), '');
  mine text[] := public.my_permissions_in(p_body, disc);
  em text := lower(trim(p_email));
  existing public.accreditations;
  perms text[];
begin
  if p_role not in ('scrutineer', 'technical_director') then raise exception 'role: scrutineer or technical_director'; end if;
  if p_role = 'technical_director' and not admin then raise exception 'only Frog Racing names a technical director'; end if;
  if disc is not null and not exists (select 1 from public.body_disciplines d where d.body_id = p_body and d.id = disc and d.archived_at is null) then
    raise exception 'no such discipline';
  end if;
  select * into existing from public.accreditations where email = em and body_id = p_body and discipline is not distinct from disc;
  if not admin then
    if not ('add_scrutineers' = any (mine)) then raise exception 'you aren''t allowed to add scrutineers%', case when disc is null then ' for all disciplines' else ' for this discipline' end; end if;
    if existing.id is not null and not public.can_change_accreditation(existing) then
      raise exception '% has permissions you don''t (or is a technical director): you can''t change their accreditation', em;
    end if;
    if existing.id is not null and p_expires is distinct from existing.license_expires and not ('renew_licenses' = any (mine)) then
      raise exception 'you aren''t allowed to change license expiry dates';
    end if;
  end if;
  if p_permissions is not null then
    if not (p_permissions <@ public.all_permissions()) then raise exception 'unknown permission'; end if;
    if not admin and not ('edit_permissions' = any (mine)) and p_permissions is distinct from coalesce(existing.permissions, p_permissions) then
      raise exception 'you aren''t allowed to edit permissions';
    end if;
    if not admin and not (p_permissions <@ mine) then raise exception 'you can''t grant a permission you don''t hold'; end if;
    perms := p_permissions;
  elsif existing.id is not null then
    perms := existing.permissions;
  elsif not admin and not (public.default_scrutineer_permissions() <@ mine) then
    perms := array(select x from unnest(public.default_scrutineer_permissions()) x where x = any (mine));
  end if;
  if existing.id is not null then
    update public.accreditations set name = p_name, role = p_role, license_number = p_license, scrutineer_code = p_code,
      license_expires = p_expires, granted_by = public.current_email(), granted_at = now(), disabled_at = null, deleted_at = null,
      permissions = perms
    where id = existing.id
    returning id into result;
  else
    insert into public.accreditations (email, name, body_id, discipline, role, license_number, scrutineer_code, license_expires, granted_by, permissions)
    values (em, p_name, p_body, disc, p_role, p_license, p_code, p_expires, public.current_email(), perms)
    returning id into result;
  end if;
  return result;
end $$;

create or replace function set_accreditation_permissions(p_id uuid, p_permissions text[]) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  acc public.accreditations;
begin
  select * into acc from public.accreditations where id = p_id;
  if acc.id is null then raise exception 'no such accreditation'; end if;
  if acc.role = 'technical_director' then raise exception 'a technical director holds every permission'; end if;
  if not public.has_permission_in(acc.body_id, acc.discipline, 'edit_permissions') then raise exception 'you aren''t allowed to edit permissions'; end if;
  if not public.can_change_accreditation(acc) then raise exception '% has permissions you don''t: you can''t change theirs', acc.email; end if;
  if p_permissions is not null and not (p_permissions <@ public.all_permissions()) then raise exception 'unknown permission'; end if;
  if not public.is_admin() and not (coalesce(p_permissions, public.default_scrutineer_permissions()) <@ public.my_permissions_in(acc.body_id, acc.discipline)) then
    raise exception 'you can''t grant a permission you don''t hold';
  end if;
  update public.accreditations set permissions = p_permissions where id = p_id;
end $$;

create or replace function renew_license(p_id uuid, p_expires date) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  acc public.accreditations;
begin
  select * into acc from public.accreditations where id = p_id;
  if acc.id is null then raise exception 'no such accreditation'; end if;
  if not public.has_permission_in(acc.body_id, acc.discipline, 'renew_licenses') then raise exception 'you aren''t allowed to renew licenses'; end if;
  if not public.can_change_accreditation(acc) then raise exception '% has permissions you don''t (or is a technical director): you can''t change their license', acc.email; end if;
  update public.accreditations set license_expires = p_expires where id = p_id;
end $$;

create or replace function set_accreditation_state(p_id uuid, p_state text) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  acc public.accreditations;
begin
  select * into acc from public.accreditations where id = p_id;
  if acc.id is null then raise exception 'no such accreditation'; end if;
  if not public.has_permission_in(acc.body_id, acc.discipline, case when p_state = 'deleted' then 'delete_scrutineers' else 'renew_licenses' end) then
    raise exception 'you aren''t allowed to % scrutineers', case when p_state = 'deleted' then 'delete' else 'disable or re-enable' end;
  end if;
  if not public.can_change_accreditation(acc) then raise exception '% has permissions you don''t (or is a technical director): you can''t change them', acc.email; end if;
  update public.accreditations set
    disabled_at = case when p_state = 'active' then null else coalesce(disabled_at, now()) end,
    deleted_at = case when p_state = 'deleted' then coalesce(deleted_at, now()) else null end
  where id = p_id;
end $$;

-- Create (p.id omitted) or update an event, with its discipline (p.discipline, for a body that has them).
create or replace function save_event(p jsonb) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  result uuid;
  disc text := nullif(p ->> 'discipline', '');
  accepted text[] := array(select distinct x from jsonb_array_elements_text(coalesce(p -> 'acceptedBodies', '[]'::jsonb)) x
                           union select p ->> 'body');
begin
  if not public.can_organize(p ->> 'body') then raise exception 'not allowed'; end if;
  if disc is not null and not exists (select 1 from public.body_disciplines d where d.body_id = p ->> 'body' and d.id = disc) then
    raise exception 'no such discipline';
  end if;
  if p ? 'id' and p ->> 'id' <> '' then
    update public.events set name = p ->> 'name', location = p ->> 'location',
      scrutineering_starts_on = (p ->> 'scrutineeringStartsOn')::date, starts_on = (p ->> 'startsOn')::date,
      ends_on = (p ->> 'endsOn')::date, accepted_bodies = accepted, discipline = disc
    where id = (p ->> 'id')::uuid and body_id = p ->> 'body'
    returning id into result;
    if result is null then raise exception 'no such event'; end if;
  else
    insert into public.events (body_id, discipline, name, location, scrutineering_starts_on, starts_on, ends_on, accepted_bodies, created_by)
    values (p ->> 'body', disc, p ->> 'name', p ->> 'location', (p ->> 'scrutineeringStartsOn')::date, (p ->> 'startsOn')::date,
            (p ->> 'endsOn')::date, accepted, public.current_email())
    returning id into result;
  end if;
  return result;
end $$;

-- The events a person works (staff) or organizes, with tech progress and their discipline.
create or replace function my_events() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id, 'body', e.body_id, 'discipline', e.discipline, 'disciplineName', public.discipline_name(e.body_id, e.discipline),
    'name', e.name, 'location', e.location,
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

create or replace function sticker_json(s public.stickers) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object('code', s.code, 'kind', s.kind, 'logbook', s.logbook_id, 'techSheet', s.tech_sheet_id,
    'event', s.event_id, 'body', s.body_id, 'bodyName', (select b.name from public.bodies b where b.id = s.body_id),
    'discipline', s.discipline, 'disciplineName', public.discipline_name(s.body_id, s.discipline),
    'disciplineShort', public.discipline_short(s.body_id, s.discipline),
    'eventName', (select e.name from public.events e where e.id = s.event_id), 'season', s.season,
    'item', s.item_key, 'snapshot', s.snapshot, 'issuedBy', s.issued_by, 'issuedAt', s.issued_at,
    'voidedAt', s.voided_at, 'voidReason', s.void_reason, 'replacedBy', s.replaced_by)
$$;

-- The stickers of a tech sheet, a logbook, an event, or a body's annual ones (p = { techSheet }
-- | { logbook } | { event } | { body, discipline?, season? }), for staff to print.
create or replace function list_stickers(p jsonb) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.sticker_json(s) order by s.issued_at), '[]'::jsonb)
  from public.stickers s
  where (public.is_admin() or public.is_scrutineer())
    and ((p ? 'techSheet' and s.tech_sheet_id = (p ->> 'techSheet')::uuid)
      or (p ? 'logbook' and s.logbook_id = (p ->> 'logbook')::uuid)
      or (p ? 'event' and s.event_id = (p ->> 'event')::uuid)
      or (p ? 'body' and s.body_id = p ->> 'body' and s.kind = 'gear' and s.event_id is null
          and (not p ? 'discipline' or s.discipline is not distinct from nullif(p ->> 'discipline', ''))
          and (not p ? 'season' or s.season = (p ->> 'season')::int)))
$$;

-- The bodies a competitor can apply to, with their disciplines: [{ id, name, disciplines: [{ id, name }] }].
create or replace function sticker_bodies() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name,
    'disciplines', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name) order by d.position, d.name), '[]'::jsonb)
                    from public.body_disciplines d where d.body_id = b.id and d.archived_at is null)) order by b.name), '[]'::jsonb)
  from public.bodies b where b.disabled_at is null and b.deleted_at is null
$$;

create or replace function sticker_application_json(a public.sticker_applications, staff boolean) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object('id', a.id, 'body', a.body_id, 'bodyName', (select b.name from public.bodies b where b.id = a.body_id),
    'discipline', a.discipline, 'disciplineName', public.discipline_name(a.body_id, a.discipline),
    'season', a.season, 'category', a.category, 'owner', a.owner_name, 'gear', a.gear, 'photos', a.photos,
    'submittedAt', a.submitted_at, 'status', a.status, 'stickerCode', a.sticker_code, 'handledAt', a.handled_at, 'note', a.note)
    || case when staff then jsonb_build_object('submittedBy', a.submitted_by, 'handledBy', a.handled_by) else '{}'::jsonb end
$$;

-- p = { body, discipline (for a body that has them), season?, category, owner?, gear, photos }.
create or replace function submit_sticker_application(p jsonb) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  me text := public.current_email();
  body text := nullif(p ->> 'body', '');
  disc text := nullif(p ->> 'discipline', '');
  photos jsonb := public.sticker_photo_list(p -> 'photos');
  cat text := coalesce(p ->> 'category', p -> 'gear' ->> 'category');
  yr int := coalesce(nullif(p ->> 'season', '')::int, extract(year from now())::int);
  new_gear jsonb := (p -> 'gear') - 'photoDataUrls' - 'stickerCode';
  new_id uuid;
begin
  if me is null then raise exception 'sign in to apply for a sticker'; end if;
  if body is null or not exists (select 1 from public.bodies b where b.id = body and b.disabled_at is null and b.deleted_at is null) then
    raise exception 'pick the sanctioning body';
  end if;
  if disc is null and exists (select 1 from public.body_disciplines d where d.body_id = body and d.archived_at is null) then
    raise exception 'pick the discipline';
  end if;
  if disc is not null and not exists (select 1 from public.body_disciplines d where d.body_id = body and d.id = disc and d.archived_at is null) then
    raise exception 'no such discipline';
  end if;
  if not public.sticker_gear(cat) then raise exception 'stickers go on helmets, HANS devices, seats, fire extinguishers and fire suppression systems'; end if;
  if jsonb_typeof(p -> 'gear') <> 'object' then raise exception 'the gear''s details are missing'; end if;
  if not public.sticker_photos_ok(photos) then raise exception 'add a photo of the whole item and one of its tag or label'; end if;
  if exists (
    select 1 from public.sticker_applications a
    where a.submitted_by = me and a.status = 'pending' and a.body_id = body and a.discipline is not distinct from disc
      and a.season = yr and a.category = cat
      and (a.gear = new_gear or exists (
        select 1 from jsonb_array_elements(coalesce(a.gear -> 'certifications', '[]'::jsonb)) x,
                      jsonb_array_elements(coalesce(new_gear -> 'certifications', '[]'::jsonb)) y
        where coalesce(x ->> 'serialNumber', '') <> '' and x ->> 'serialNumber' = y ->> 'serialNumber'))) then
    raise exception 'this item already has a pending application for that body, discipline and season: wait until it''s processed, or withdraw it to send a new one';
  end if;
  insert into public.sticker_applications (body_id, discipline, season, category, owner_name, gear, photos, submitted_by)
  values (body, disc, yr, cat, nullif(trim(p ->> 'owner'), ''), new_gear, photos, me)
  returning sticker_applications.id into new_id;
  return new_id;
end $$;

-- What a scanned sticker shows (anyone): valid, void, or expired -- with its discipline.
create or replace function sticker_view(p_code text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  s public.stickers;
  staff boolean := public.is_admin() or public.is_scrutineer();
  a public.accreditations;
  ev public.events;
  sh public.tech_sheets;
  lb public.logbooks;
  res jsonb;
  snap jsonb;
begin
  select * into s from public.stickers where code = public.sticker_code(p_code);
  if s.code is null then return null; end if;
  select * into a from public.accreditations where id = s.accreditation_id;
  select * into ev from public.events where id = s.event_id;
  snap := s.snapshot;
  if not staff then snap := snap - 'driver' - 'codriver'; end if;
  res := jsonb_build_object('code', s.code, 'kind', s.kind,
    'status', case when s.voided_at is not null then 'void'
                   when s.kind = 'gear' and s.season < extract(year from now())::int then 'expired'
                   when s.kind = 'car' and ev.id is not null and current_date > ev.ends_on + 1 then 'expired'
                   else 'valid' end,
    'season', s.season, 'discipline', s.discipline, 'disciplineName', public.discipline_name(s.body_id, s.discipline),
    'disciplineShort', public.discipline_short(s.body_id, s.discipline),
    'voidedAt', s.voided_at, 'voidReason', s.void_reason, 'replacedBy', s.replaced_by,
    'issuedAt', s.issued_at, 'inspector', jsonb_build_object('name', a.name, 'license', a.license_number),
    'body', s.body_id, 'bodyName', (select b.name from public.bodies b where b.id = s.body_id),
    'event', case when ev.id is null then null else jsonb_build_object('name', ev.name, 'location', ev.location,
      'startsOn', ev.starts_on, 'endsOn', ev.ends_on) end,
    'snapshot', snap, 'staff', staff);
  if s.kind = 'car' then
    select * into sh from public.tech_sheets where id = s.tech_sheet_id;
    res := res || jsonb_build_object('sheet', jsonb_build_object('status', sh.status, 'variant', sh.variant,
      'template', sh.template,
      'results', (select coalesce(jsonb_object_agg(k, v ->> 'result'), '{}'::jsonb) from jsonb_each(coalesce(sh.inspection -> 'items', '{}'::jsonb)) as i(k, v)),
      'signatures', (select coalesce(jsonb_object_agg(k, jsonb_build_object('name', v ->> 'name', 'license', v ->> 'license', 'at', v ->> 'at')), '{}'::jsonb)
                     from jsonb_each(coalesce(sh.inspection -> 'signatures', '{}'::jsonb)) as g(k, v))));
  elsif s.kind = 'logbook' then
    select * into lb from public.logbooks where id = s.logbook_id;
    res := res || jsonb_build_object('logbook', jsonb_build_object('digitalNumber', lb.digital_number, 'status', lb.status,
      'publicToken', case when lb.public_enabled or staff then lb.public_token end, 'id', case when staff then lb.id end));
  end if;
  return res;
end $$;



-- Issuing a logbook: issue_logbooks in any of the body's disciplines.
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
  if not public.has_permission(acc.body_id, 'issue_logbooks') then raise exception 'you aren''t allowed to issue logbooks -- ask your technical director'; end if;
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

-- Logbook entries: add_logbook_entries in any of the body's disciplines.
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
  if not public.has_permission(p_body_id, 'add_logbook_entries') then raise exception 'you aren''t allowed to add logbook entries -- ask your technical director'; end if;
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

-- An event's records: signed under the accreditation for its discipline.
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
  acc := public.my_accreditation_for(ev.body_id, ev.discipline);
  if acc.id is null then
    select a.* into acc from public.accreditations a
    where a.email = public.current_email() and public.accreditation_active(a) order by a.granted_at limit 1;
  end if;
  if acc.id is null then raise exception 'not an active scrutineer'; end if;
  if not public.accreditation_can(acc, 'add_logbook_entries') then raise exception 'you aren''t allowed to add logbook entries -- ask your technical director'; end if;
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

-- A tech sheet: signed under the accreditation for the event's discipline.
create or replace function save_tech_sheet(p_event uuid, p jsonb) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  ev public.events;
  sh public.tech_sheets;
  tpl public.tech_sheet_templates;
  en public.event_entries;
  lb public.logbooks;
  acc public.accreditations;
  car text := trim(coalesce(p ->> 'carNumber', ''));
  role text := public.event_role(p_event);
  want uuid := nullif(p ->> 'template', '')::uuid;
  fin text := p ->> 'finish';
  insp jsonb := coalesce(p -> 'inspection', '{}'::jsonb);
  sig jsonb;
  failed jsonb;
  record_id uuid;
begin
  select * into ev from public.events where id = p_event;
  if ev.id is null then raise exception 'no such event'; end if;
  if role is null then raise exception 'you are not on this event''s staff'; end if;
  -- Filling in: any time until scrutineering ends. The result (finish): only during it.
  if ev.cancelled_at is not null or current_date > ev.ends_on + 1 then raise exception 'this event is over'; end if;
  if fin is not null and not public.event_open(ev) then
    raise exception 'the result can only be recorded during scrutineering (% to the day after %) -- save the sheet until then', ev.scrutineering_starts_on, ev.ends_on;
  end if;
  if car = '' then raise exception 'enter the car number'; end if;
  if fin is not null and fin not in ('pass', 'fail') then raise exception 'finish: pass or fail'; end if;
  if p ->> 'signAs' = 'chief' and role <> 'chief' then raise exception 'only the chief scrutineer signs as chief'; end if;
  acc := public.my_accreditation_for(ev.body_id, ev.discipline);
  if acc.id is null then
    select a.* into acc from public.accreditations a
    where a.email = public.current_email() and public.accreditation_active(a) order by a.granted_at limit 1;
  end if;
  if acc.id is null then raise exception 'not an active scrutineer'; end if;
  if fin is not null and not public.accreditation_can(acc, 'sign_off_tech_sheets') then
    raise exception 'you aren''t allowed to sign off tech sheets (Passed / Failed) -- save the sheet, and a scrutineer who is signs it';
  end if;
  select * into en from public.event_entries where event_id = ev.id and car_number = car;

  select * into sh from public.tech_sheets where event_id = ev.id and car_number = car;
  if sh.id is null then
    -- The sheet the scrutineer picked, else the one for the car's class.
    tpl := public.event_template_for(ev.id, want, coalesce(en.class, p -> 'header' ->> 'class'));
    if tpl.id is null then raise exception 'this event has no tech sheet yet'; end if;
    insert into public.tech_sheets (event_id, car_number, entry_id, template_id, template, variant, header, competitor, status)
    values (ev.id, car, en.id, tpl.id, tpl.definition, p ->> 'variant', coalesce(p -> 'header', '{}'::jsonb), p -> 'competitor', 'inspecting')
    returning * into sh;
  elsif p ? 'seenSubmittedAt' and coalesce(sh.competitor ->> 'submittedAt', '') <> coalesce(p ->> 'seenSubmittedAt', '') then
    raise exception 'the team re-submitted car %''s sheet since you opened it -- close it and open it again to see their changes (what you entered since wasn''t saved)', car;
  end if;

  -- Another of the event's sheets, until the car is signed off.
  if want is not null and want is distinct from sh.template_id then
    if sh.status in ('passed', 'failed') then raise exception 'car % is signed off: its sheet can''t change', car; end if;
    tpl := public.event_template_for(ev.id, want, null);
    update public.tech_sheets set template_id = tpl.id, template = tpl.definition where id = sh.id returning * into sh;
  end if;

  -- Signatures: kept from earlier saves, added when finishing.
  sig := coalesce(sh.inspection -> 'signatures', '{}'::jsonb);
  if fin is not null then
    sig := sig || jsonb_build_object('scrutineer', jsonb_build_object('name', acc.name, 'license', acc.license_number,
      'email', acc.email, 'body', acc.body_id, 'at', now()));
    if p ->> 'signAs' = 'chief' then
      sig := sig || jsonb_build_object('chief', jsonb_build_object('name', acc.name, 'license', acc.license_number,
        'email', acc.email, 'body', acc.body_id, 'at', now()));
    end if;
  end if;
  -- The verdicts of earlier rounds (failed, then re-submitted) stay with the sheet.
  insp := insp || jsonb_build_object('signatures', sig) || case when fin is null then '{}'::jsonb else jsonb_build_object('result', fin) end
    || case when sh.inspection ? 'history' then jsonb_build_object('history', sh.inspection -> 'history') else '{}'::jsonb end;

  update public.tech_sheets set
    header = coalesce(p -> 'header', header), variant = coalesce(p ->> 'variant', variant),
    competitor = coalesce(p -> 'competitor', competitor), entry_id = coalesce(en.id, entry_id),
    inspection = insp,
    -- Before scrutineering opens, a team's submitted sheet stays theirs to update.
    status = case fin when 'pass' then 'passed' when 'fail' then 'failed'
             else case when public.event_open(ev) or sh.status <> 'submitted' then 'inspecting' else sh.status end end,
    inspected_by = public.current_email(), inspected_at = case when fin is null then inspected_at else now() end,
    -- The open sheet keeps its lock; a verdict releases it.
    locked_by = public.current_email(), locked_until = case when fin is null then now() + interval '15 minutes' end,
    updated_at = now()
  where id = sh.id
  returning * into sh;

  if fin is not null and en.id is not null then
    update public.event_entries set tech_status = case fin when 'pass' then 'passed' else 'failed' end, updated_at = now() where id = en.id;
    select * into lb from public.logbooks where id = en.logbook_id;
    if lb.id is not null and lb.issuing_body = any (ev.accepted_bodies) then
      select coalesce(jsonb_agg(k), '[]'::jsonb) into failed
      from jsonb_each(coalesce(insp -> 'items', '{}'::jsonb)) as i(k, v) where v ->> 'result' = 'fail';
      insert into public.records (logbook_id, kind, body, author_email, accreditation_id, event_id, seq, hash)
      values (lb.id, 'inspection', jsonb_build_object('result', fin, 'techSheet', sh.id,
        'template', sh.template ->> 'id', 'failedItems', failed, 'notes', insp ->> 'corrections', 'driver', en.driver),
        acc.email, acc.id, ev.id, 0, '')
      returning id into record_id;
    end if;
  end if;
  return public.tech_sheet_json(sh) || jsonb_build_object('record', record_id);
end $$;

-- Stickers: a discipline -- the event's, or the annual one asked for (issue_annual_stickers in it).
create or replace function issue_sticker(p jsonb) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  k text := p ->> 'kind';
  annual boolean := coalesce((p ->> 'annual')::boolean, false);
  lb public.logbooks;
  sh public.tech_sheets;
  ev public.events;
  acc public.accreditations;
  s public.stickers;
  app public.sticker_applications;
  key text := p ->> 'item';
  it jsonb;
  dec jsonb;
  gear jsonb;
  photos jsonb;
  snap jsonb;
  body text;
  disc text;
  yr int;
begin
  if k = 'logbook' then
    select * into lb from public.logbooks where id = (p ->> 'logbook')::uuid;
    if lb.id is null then raise exception 'no such logbook'; end if;
    if not public.is_scrutineer() then raise exception 'only scrutineers issue stickers'; end if;
    if lb.status <> 'active' then raise exception 'this logbook is %', lb.status; end if;
    body := lb.issuing_body;
    snap := jsonb_build_object('digitalNumber', lb.digital_number, 'make', lb.make, 'model', lb.model, 'year', lb.year);
  elsif k = 'gear' and annual then
    body := nullif(p ->> 'body', '');
    disc := nullif(p ->> 'discipline', '');
    if body is null or not exists (select 1 from public.bodies b where b.id = body and b.disabled_at is null and b.deleted_at is null) then
      raise exception 'pick the sanctioning body';
    end if;
    if (public.my_accreditation(body)).id is null and not public.is_admin() then raise exception 'only its own scrutineers issue a body''s stickers'; end if;
    if not public.has_permission_in(body, disc, 'issue_annual_stickers') then raise exception 'you aren''t allowed to issue annual stickers'; end if;
    yr := coalesce(nullif(p ->> 'season', '')::int, extract(year from now())::int);
    if disc is null and exists (select 1 from public.body_disciplines d where d.body_id = body and d.archived_at is null) then raise exception 'pick the discipline'; end if;
    if disc is not null and not exists (select 1 from public.body_disciplines d where d.body_id = body and d.id = disc) then raise exception 'no such discipline'; end if;
    gear := p -> 'gear';
    if gear is null or not public.sticker_gear(gear ->> 'category') then
      raise exception 'stickers go on helmets, HANS devices, seats, fire extinguishers and fire suppression systems';
    end if;
    photos := public.sticker_photo_list(p -> 'photos');
    if not public.sticker_photos_ok(photos) then raise exception 'a gear sticker needs a photo of the item and one of its tag or label'; end if;
    if p ? 'application' then
      select * into app from public.sticker_applications where id = (p ->> 'application')::uuid;
      if app.id is null or app.body_id <> body or app.status <> 'pending' then raise exception 'that application isn''t pending for this body'; end if;
    end if;
    snap := jsonb_build_object('category', gear ->> 'category', 'label', nullif(p ->> 'label', ''), 'occupant', null,
      'gear', gear - 'photoDataUrls' - 'key' - 'stickerCode', 'photos', photos, 'driver', coalesce(nullif(p ->> 'owner', ''), app.owner_name));
  elsif k in ('gear', 'car') then
    select * into sh from public.tech_sheets where id = (p ->> 'techSheet')::uuid;
    if sh.id is null then raise exception 'save the tech sheet first'; end if;
    select * into ev from public.events where id = sh.event_id;
    if public.event_role(ev.id) is null and not public.is_admin() then raise exception 'only the event''s staff issue its stickers'; end if;
    body := ev.body_id;
    disc := ev.discipline;
    yr := extract(year from ev.starts_on)::int;
    if k = 'gear' then
      it := sh.inspection -> 'items' -> key;
      dec := sh.competitor -> 'items' -> key;
      if coalesce(it ->> 'result', '') <> 'pass' then raise exception 'mark this line Pass and save the sheet first'; end if;
      gear := coalesce(it -> 'gear', dec -> 'gear');
      if gear is null or not public.sticker_gear(gear ->> 'category') then
        raise exception 'stickers go on helmets, HANS devices, seats, fire extinguishers and fire suppression systems';
      end if;
      select public.sticker_photo_list(coalesce(jsonb_agg(x), '[]'::jsonb)) into photos
      from jsonb_array_elements(coalesce(dec -> 'photos', '[]'::jsonb) || coalesce(it -> 'photos', '[]'::jsonb)) x
      -- (Not a team photo the scrutineer removed from the line.)
      where not coalesce(it -> 'removedPhotos', '[]'::jsonb) ? (x ->> 'sha256');
      if not public.sticker_photos_ok(photos) then raise exception 'a gear sticker needs a photo of the item and one of its tag or label'; end if;
      snap := jsonb_build_object('category', gear ->> 'category', 'label', coalesce(nullif(p ->> 'label', ''), key),
        'occupant', case when key like '%.codriver' then 'codriver' when key like '%.driver' then 'driver' else null end,
        'gear', gear - 'photoDataUrls' - 'key' - 'stickerCode', 'photos', photos, 'carNumber', sh.car_number,
        'driver', case when key like '%.codriver' then sh.header ->> 'codriver' else sh.header ->> 'driver' end);
    else
      if sh.status <> 'passed' then raise exception 'the car must pass tech first'; end if;
      select coalesce(jsonb_agg(jsonb_build_object('sha256', x ->> 'sha256', 'kind', 'car')), '[]'::jsonb) into photos
      from jsonb_array_elements(coalesce(sh.competitor -> 'pictures' -> 'car', '[]'::jsonb) || coalesce(sh.inspection -> 'pictures' -> 'car', '[]'::jsonb)) x
      where x ->> 'sha256' ~ '^[0-9a-f]{64}$';
      snap := jsonb_build_object('carNumber', sh.car_number, 'class', sh.header ->> 'class',
        'make', sh.header ->> 'make', 'model', sh.header ->> 'model', 'year', sh.header ->> 'year',
        'driver', sh.header ->> 'driver', 'codriver', sh.header ->> 'codriver', 'photos', photos);
    end if;
  else
    raise exception 'kind: logbook, gear or car';
  end if;

  acc := public.my_accreditation_for(body, disc);
  if acc.id is null then
    select a.* into acc from public.accreditations a
    where a.email = public.current_email() and public.accreditation_active(a) order by a.granted_at limit 1;
  end if;
  if acc.id is null and not public.is_admin() then raise exception 'not an active scrutineer'; end if;

  insert into public.stickers (code, kind, logbook_id, tech_sheet_id, event_id, body_id, discipline, item_key, snapshot, issued_by, accreditation_id, season)
  values (public.new_sticker_code(), k, lb.id, sh.id, ev.id, body, disc, case when k = 'gear' and not annual then key end, snap,
          public.current_email(), acc.id, case when k = 'gear' then yr end)
  returning * into s;
  insert into public.sticker_photos (code, sha256, kind)
  select s.code, x ->> 'sha256', x ->> 'kind' from jsonb_array_elements(coalesce(snap -> 'photos', '[]'::jsonb)) x
  on conflict do nothing;

  update public.stickers set voided_at = now(), voided_by = public.current_email(), void_reason = 'replaced', replaced_by = s.code
  where code <> s.code and voided_at is null and (
    (k = 'gear' and not annual and kind = 'gear' and tech_sheet_id = sh.id and item_key = key)
    or (k = 'gear' and annual and kind = 'gear' and code = public.sticker_code(p ->> 'replaces') and body_id = body and discipline is not distinct from disc and season = yr)
    or (k = 'car' and kind = 'car' and tech_sheet_id = sh.id)
    or (k = 'logbook' and kind = 'logbook' and logbook_id = lb.id and coalesce((p ->> 'replace')::boolean, false)));
  if app.id is not null then
    update public.sticker_applications set status = 'issued', sticker_code = s.code, handled_by = public.current_email(), handled_at = now()
    where id = app.id;
  end if;
  return public.sticker_json(s);
end $$;

-- Voiding a sticker: void_stickers in its discipline.
create or replace function void_sticker(p_code text, p_reason text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  s public.stickers;
begin
  select * into s from public.stickers where code = public.sticker_code(p_code);
  if s.code is null then raise exception 'no such sticker'; end if;
  if not public.has_permission_in(s.body_id, s.discipline, 'void_stickers') then
    raise exception 'you aren''t allowed to void % stickers', upper(s.body_id);
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'say why it''s void'; end if;
  update public.stickers set voided_at = coalesce(voided_at, now()), voided_by = coalesce(voided_by, public.current_email()),
    void_reason = coalesce(void_reason, trim(p_reason))
  where code = s.code returning * into s;
  return public.sticker_json(s);
end $$;

revoke execute on function discipline_name, discipline_short, my_accreditation_for, my_permissions_in, has_permission_in,
  save_discipline from public, anon, authenticated;
grant execute on function discipline_name, discipline_short to anon, authenticated;
grant execute on function my_accreditation_for, my_permissions_in, has_permission_in, save_discipline, grant_accreditation to authenticated;

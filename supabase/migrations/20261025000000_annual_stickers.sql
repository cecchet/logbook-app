-- Season (annual) safety gear stickers.
--  - A gear sticker carries a season (a calendar year): issued at an event, the
--    event's year; issued in the Scrutineering site's "Annual safety stickers"
--    mode, the year the scrutineer picks. It's good for all of its body's
--    events that season, and shows as expired after it. A car's tech-pass
--    sticker is good for its event only.
--  - Fire extinguishers and fire suppression systems get gear stickers too.
--  - Annual stickers aren't tied to an event: a scrutineer of the body issues
--    them from the gear details and photos (one of the item, one of its tag or
--    label), often read off last season's sticker (p.replaces voids a sticker
--    of the same body and season it replaces).
--  - A competitor applies for one from PassTech (sticker_applications): the
--    gear as entered in My gear, with its photos; the body's scrutineers
--    review it, then issue the sticker from it or decline it.

alter table stickers add column if not exists season int;
update stickers s set season = extract(year from coalesce((select e.starts_on from events e where e.id = s.event_id), s.issued_at::date))::int
where s.season is null and s.kind = 'gear';

create or replace function sticker_gear(cat text) returns boolean
language sql immutable
set search_path = ''
as $$ select cat in ('helmet', 'hnr', 'seat', 'fire_extinguisher', 'fire_suppression') $$;

create or replace function sticker_json(s public.stickers) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object('code', s.code, 'kind', s.kind, 'logbook', s.logbook_id, 'techSheet', s.tech_sheet_id,
    'event', s.event_id, 'body', s.body_id, 'bodyName', (select b.name from public.bodies b where b.id = s.body_id),
    'eventName', (select e.name from public.events e where e.id = s.event_id), 'season', s.season,
    'item', s.item_key, 'snapshot', s.snapshot, 'issuedBy', s.issued_by, 'issuedAt', s.issued_at,
    'voidedAt', s.voided_at, 'voidReason', s.void_reason, 'replacedBy', s.replaced_by)
$$;

-- Applications for an annual sticker, from PassTech.
create table if not exists sticker_applications (
  id uuid primary key default gen_random_uuid(),
  body_id text not null references bodies(id),
  season int not null,
  category text not null,
  -- Who the gear belongs to (shown to the body's scrutineers only).
  owner_name text,
  gear jsonb not null,
  -- [{ sha256, kind: item | tag }] in the tech-sheet-photos bucket.
  photos jsonb not null,
  submitted_by text not null,
  submitted_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'issued', 'declined', 'withdrawn')),
  sticker_code text references stickers(code),
  handled_by text,
  handled_at timestamptz,
  note text
);
create index if not exists sticker_applications_body on sticker_applications (body_id, status);
create index if not exists sticker_applications_mine on sticker_applications (submitted_by);
alter table sticker_applications enable row level security;
revoke all on sticker_applications from anon, authenticated;

-- A sticker's photos from a list of { sha256, kind }: item or tag, valid hashes only, each once.
create or replace function sticker_photo_list(p jsonb) returns jsonb
language sql immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(distinct jsonb_build_object('sha256', x ->> 'sha256', 'kind', case when x ->> 'kind' = 'tag' then 'tag' else 'item' end)), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) x
  where x ->> 'sha256' ~ '^[0-9a-f]{64}$'
$$;

create or replace function sticker_photos_ok(photos jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select exists (select 1 from jsonb_array_elements(photos) x where x ->> 'kind' = 'tag')
     and exists (select 1 from jsonb_array_elements(photos) x where x ->> 'kind' = 'item')
$$;

-- Issues a sticker: p = { kind: "logbook", logbook }
--                      | { kind: "gear", techSheet, item, label }            (at an event)
--                      | { kind: "gear", annual: true, body, season?, gear, photos, label?, owner?, replaces?, application? }
--                      | { kind: "car", techSheet }.
-- A new gear or car sticker for the same line or sheet voids the earlier one;
-- an annual one voids the sticker it replaces (p.replaces) when that one is of
-- the same body and season. Logbook stickers add up unless p.replace.
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
    if body is null or not exists (select 1 from public.bodies b where b.id = body and b.disabled_at is null and b.deleted_at is null) then
      raise exception 'pick the sanctioning body';
    end if;
    if (public.my_accreditation(body)).id is null and not public.is_admin() then raise exception 'only its own scrutineers issue a body''s stickers'; end if;
    yr := coalesce(nullif(p ->> 'season', '')::int, extract(year from now())::int);
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

  acc := public.my_accreditation(body);
  if acc.id is null then
    select a.* into acc from public.accreditations a
    where a.email = public.current_email() and public.accreditation_active(a) order by a.granted_at limit 1;
  end if;
  if acc.id is null and not public.is_admin() then raise exception 'not an active scrutineer'; end if;

  insert into public.stickers (code, kind, logbook_id, tech_sheet_id, event_id, body_id, item_key, snapshot, issued_by, accreditation_id, season)
  values (public.new_sticker_code(), k, lb.id, sh.id, ev.id, body, case when k = 'gear' and not annual then key end, snap,
          public.current_email(), acc.id, case when k = 'gear' then yr end)
  returning * into s;
  insert into public.sticker_photos (code, sha256, kind)
  select s.code, x ->> 'sha256', x ->> 'kind' from jsonb_array_elements(coalesce(snap -> 'photos', '[]'::jsonb)) x
  on conflict do nothing;

  update public.stickers set voided_at = now(), voided_by = public.current_email(), void_reason = 'replaced', replaced_by = s.code
  where code <> s.code and voided_at is null and (
    (k = 'gear' and not annual and kind = 'gear' and tech_sheet_id = sh.id and item_key = key)
    or (k = 'gear' and annual and kind = 'gear' and code = public.sticker_code(p ->> 'replaces') and body_id = body and season = yr)
    or (k = 'car' and kind = 'car' and tech_sheet_id = sh.id)
    or (k = 'logbook' and kind = 'logbook' and logbook_id = lb.id and coalesce((p ->> 'replace')::boolean, false)));
  if app.id is not null then
    update public.sticker_applications set status = 'issued', sticker_code = s.code, handled_by = public.current_email(), handled_at = now()
    where id = app.id;
  end if;
  return public.sticker_json(s);
end $$;

-- The stickers of a tech sheet, a logbook, an event, or a body's annual ones
-- (p = { techSheet } | { logbook } | { event } | { body, season? }), for staff to print.
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
          and (not p ? 'season' or s.season = (p ->> 'season')::int)))
$$;

-- What a scanned sticker shows (anyone): valid, void, or expired (a gear
-- sticker after its season, a car's after its event). Names only to scrutineers.
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
    'season', s.season, 'voidedAt', s.voided_at, 'voidReason', s.void_reason, 'replacedBy', s.replaced_by,
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

-- ---- Applications (PassTech) ----------------------------------------------

-- The bodies a competitor can apply to: [{ id, name }].
create or replace function sticker_bodies() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name) order by b.name), '[]'::jsonb)
  from public.bodies b where b.disabled_at is null and b.deleted_at is null
$$;

-- p = { body, season?, category, owner?, gear, photos: [{ sha256, kind }] } -> its id.
create or replace function submit_sticker_application(p jsonb) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  me text := public.current_email();
  body text := nullif(p ->> 'body', '');
  photos jsonb := public.sticker_photo_list(p -> 'photos');
  cat text := coalesce(p ->> 'category', p -> 'gear' ->> 'category');
  new_id uuid;
begin
  if me is null then raise exception 'sign in to apply for a sticker'; end if;
  if body is null or not exists (select 1 from public.bodies b where b.id = body and b.disabled_at is null and b.deleted_at is null) then
    raise exception 'pick the sanctioning body';
  end if;
  if not public.sticker_gear(cat) then raise exception 'stickers go on helmets, HANS devices, seats, fire extinguishers and fire suppression systems'; end if;
  if jsonb_typeof(p -> 'gear') <> 'object' then raise exception 'the gear''s details are missing'; end if;
  if not public.sticker_photos_ok(photos) then raise exception 'add a photo of the whole item and one of its tag or label'; end if;
  insert into public.sticker_applications (body_id, season, category, owner_name, gear, photos, submitted_by)
  values (body, coalesce(nullif(p ->> 'season', '')::int, extract(year from now())::int), cat, nullif(trim(p ->> 'owner'), ''),
          (p -> 'gear') - 'photoDataUrls' - 'stickerCode', photos, me)
  returning sticker_applications.id into new_id;
  return new_id;
end $$;

create or replace function sticker_application_json(a public.sticker_applications, staff boolean) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object('id', a.id, 'body', a.body_id, 'bodyName', (select b.name from public.bodies b where b.id = a.body_id),
    'season', a.season, 'category', a.category, 'owner', a.owner_name, 'gear', a.gear, 'photos', a.photos,
    'submittedAt', a.submitted_at, 'status', a.status, 'stickerCode', a.sticker_code, 'handledAt', a.handled_at, 'note', a.note)
    || case when staff then jsonb_build_object('submittedBy', a.submitted_by, 'handledBy', a.handled_by) else '{}'::jsonb end
$$;

-- The signed-in competitor's applications.
create or replace function my_sticker_applications() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.sticker_application_json(a, false) order by a.submitted_at desc), '[]'::jsonb)
  from public.sticker_applications a where a.submitted_by = public.current_email()
$$;

create or replace function withdraw_sticker_application(p_id uuid) returns void
language sql security definer
set search_path = ''
as $$
  update public.sticker_applications set status = 'withdrawn', handled_at = now()
  where id = p_id and submitted_by = public.current_email() and status = 'pending'
$$;

-- A body's applications (its scrutineers): pending first.
create or replace function list_sticker_applications(p_body text, p_status text default 'pending') returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if (public.my_accreditation(p_body)).id is null and not public.is_admin() then raise exception 'only the body''s scrutineers see its applications'; end if;
  return (select coalesce(jsonb_agg(public.sticker_application_json(a, true) order by a.submitted_at), '[]'::jsonb)
          from public.sticker_applications a where a.body_id = p_body and (p_status is null or a.status = p_status));
end $$;

create or replace function decline_sticker_application(p_id uuid, p_note text) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  a public.sticker_applications;
begin
  select * into a from public.sticker_applications where id = p_id;
  if a.id is null or a.status <> 'pending' then raise exception 'that application isn''t pending'; end if;
  if (public.my_accreditation(a.body_id)).id is null and not public.is_admin() then raise exception 'only the body''s scrutineers decline its applications'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'say why, for the competitor'; end if;
  update public.sticker_applications set status = 'declined', note = trim(p_note), handled_by = public.current_email(), handled_at = now()
  where id = a.id;
end $$;

-- A team also reads back the photos of its sticker applications.
create or replace function tech_sheet_photo_mine(p_name text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_name ~ '^[0-9a-f]{64}$' and (
    exists (select 1 from public.tech_sheets s
            where s.submitted_by = public.current_email() and strpos(s.competitor::text, p_name) > 0)
    or exists (select 1 from public.sticker_applications a
               where a.submitted_by = public.current_email() and strpos(a.photos::text, p_name) > 0))
$$;

revoke execute on function sticker_photo_list, sticker_photos_ok, sticker_application_json, sticker_bodies,
  submit_sticker_application, my_sticker_applications, withdraw_sticker_application, list_sticker_applications,
  decline_sticker_application from public, anon, authenticated;
grant execute on function sticker_bodies to anon, authenticated;
grant execute on function submit_sticker_application, my_sticker_applications, withdraw_sticker_application,
  list_sticker_applications, decline_sticker_application to authenticated;

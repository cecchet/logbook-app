-- Bodies whose gear stickers have no season: the sticker only records the certifications read
-- off the gear's tags (e.g. PassTech by Frog Racing). It never expires; whoever scans it (PassTech's
-- scrutineer mode) judges those certifications against the rules of the body they're checking for.
--  - bodies.stickers_seasonless: set by System admins (Frog Racing).
--  - Its stickers still record the year they were issued (season), shown nowhere; they never show as
--    expired, are listed for every season's events, and a new one replaces one of any year.

alter table bodies add column if not exists stickers_seasonless boolean not null default false;
update bodies set stickers_seasonless = true where name ilike 'passtech%';

create or replace function sticker_seasonless(p_body text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((select b.stickers_seasonless from public.bodies b where b.id = p_body), false)
$$;

create or replace function save_sticker_seasonless(p_body text, p_value boolean) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'only Frog Racing sets whether a body''s stickers have a season'; end if;
  update public.bodies set stickers_seasonless = coalesce(p_value, false) where id = p_body;
  if not found then raise exception 'no such body'; end if;
end $$;

-- As before (20261109000100_annual_car_stickers.sql), with whether the body's stickers have a season.
create or replace function sticker_bodies() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'seasonless', b.stickers_seasonless, 'gear', to_jsonb(coalesce(b.annual_sticker_gear, '{}'::text[])),
    'carTemplate', public.template_json(public.annual_car_template(b.id, null)),
    'disciplines', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'gear', to_jsonb(coalesce(d.annual_sticker_gear, '{}'::text[])),
                      'carTemplate', public.template_json(public.annual_car_template(b.id, d.id)))
                      order by d.position, d.name), '[]'::jsonb)
                    from public.body_disciplines d where d.body_id = b.id and d.archived_at is null)) order by b.name), '[]'::jsonb)
  from public.bodies b where b.disabled_at is null and b.deleted_at is null
$$;

-- As before (20261026000000_disciplines.sql); a seasonless body's stickers whatever the season asked.
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
          and (not p ? 'season' or s.season = (p ->> 'season')::int or public.sticker_seasonless(s.body_id))))
$$;

-- As before (20261026000000_disciplines.sql), with seasonless.
create or replace function sticker_json(s public.stickers) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object('code', s.code, 'kind', s.kind, 'logbook', s.logbook_id, 'techSheet', s.tech_sheet_id,
    'event', s.event_id, 'body', s.body_id, 'bodyName', (select b.name from public.bodies b where b.id = s.body_id),
    'discipline', s.discipline, 'disciplineName', public.discipline_name(s.body_id, s.discipline),
    'disciplineShort', public.discipline_short(s.body_id, s.discipline),
    'eventName', (select e.name from public.events e where e.id = s.event_id), 'season', s.season, 'seasonless', s.kind = 'gear' and public.sticker_seasonless(s.body_id),
    'item', s.item_key, 'snapshot', s.snapshot, 'issuedBy', s.issued_by, 'issuedAt', s.issued_at,
    'voidedAt', s.voided_at, 'voidReason', s.void_reason, 'replacedBy', s.replaced_by)
$$;

-- As before (20261026000000_disciplines.sql), with seasonless.
create or replace function sticker_application_json(a public.sticker_applications, staff boolean) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object('id', a.id, 'body', a.body_id, 'bodyName', (select b.name from public.bodies b where b.id = a.body_id),
    'discipline', a.discipline, 'disciplineName', public.discipline_name(a.body_id, a.discipline),
    'season', a.season, 'seasonless', public.sticker_seasonless(a.body_id), 'category', a.category, 'owner', a.owner_name, 'gear', a.gear, 'photos', a.photos,
    'submittedAt', a.submitted_at, 'status', a.status, 'stickerCode', a.sticker_code, 'handledAt', a.handled_at, 'note', a.note)
    || case when staff then jsonb_build_object('submittedBy', a.submitted_by, 'handledBy', a.handled_by) else '{}'::jsonb end
$$;

-- As before (20261109000100_annual_car_stickers.sql); a seasonless body's gear sticker never expires.
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
                   when s.kind = 'gear' and s.season < extract(year from now())::int and not public.sticker_seasonless(s.body_id) then 'expired'
                   when s.kind = 'car' and ev.id is not null and current_date > ev.ends_on + 1 then 'expired'
                   when s.kind = 'car' and ev.id is null and s.season < extract(year from now())::int then 'expired'
                   else 'valid' end,
    'season', s.season, 'seasonless', s.kind = 'gear' and public.sticker_seasonless(s.body_id), 'discipline', s.discipline, 'disciplineName', public.discipline_name(s.body_id, s.discipline),
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
      'template', sh.template, 'annual', sh.event_id is null,
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

-- As before (20261027000000_offline_scrutineering.sql); a seasonless body's new sticker replaces one of any year.
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
  r public.sticker_code_reservations;
  key text := p ->> 'item';
  rcode text := nullif(public.sticker_code(p ->> 'code'), '');
  t timestamptz := public.offline_time(p);
  it jsonb;
  dec jsonb;
  gear jsonb;
  photos jsonb;
  snap jsonb;
  body text;
  disc text;
  yr int;
begin
  if rcode is not null and not ((k = 'gear' and not annual) or k = 'car') then
    raise exception 'a reserved sticker code is only for an event''s gear and car stickers';
  end if;
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
    if nullif(p ->> 'techSheet', '') is not null then
      select * into sh from public.tech_sheets where id = (p ->> 'techSheet')::uuid;
    elsif nullif(p ->> 'event', '') is not null and trim(coalesce(p ->> 'carNumber', '')) <> '' then
      -- A sheet created offline: the device knows its event and car number, not its id.
      select * into sh from public.tech_sheets where event_id = (p ->> 'event')::uuid and car_number = trim(p ->> 'carNumber');
    end if;
    if sh.id is null then raise exception 'save the tech sheet first'; end if;
    select * into ev from public.events where id = sh.event_id;
    if public.event_role(ev.id) is null and not public.is_admin() then raise exception 'only the event''s staff issue its stickers'; end if;
    -- A reserved code: issued once; sending the same sticker again (a retried sync) returns it unchanged.
    if rcode is not null then
      select * into s from public.stickers where stickers.code = rcode;
      if s.code is not null then
        if s.issued_by = public.current_email() and s.kind = k and s.tech_sheet_id = sh.id
           and (k = 'car' or s.item_key = key) then
          return public.sticker_json(s);
        end if;
        raise exception 'sticker code % is already on another sticker', rcode;
      end if;
      select * into r from public.sticker_code_reservations where sticker_code_reservations.code = rcode;
      if r.code is null or r.reserved_by <> public.current_email() or r.event_id <> ev.id then
        raise exception 'sticker code % isn''t one you reserved for this event', rcode;
      end if;
      if r.used_at is not null then raise exception 'sticker code % is already used', rcode; end if;
    end if;
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

  insert into public.stickers (code, kind, logbook_id, tech_sheet_id, event_id, body_id, discipline, item_key, snapshot, issued_by, accreditation_id, season, issued_at)
  values (coalesce(rcode, public.new_sticker_code()), k, lb.id, sh.id, ev.id, body, disc, case when k = 'gear' and not annual then key end, snap,
          public.current_email(), acc.id, case when k = 'gear' then yr end, t)
  returning * into s;
  if rcode is not null then
    update public.sticker_code_reservations set used_at = now() where sticker_code_reservations.code = s.code;
  end if;
  insert into public.sticker_photos (code, sha256, kind)
  select s.code, x ->> 'sha256', x ->> 'kind' from jsonb_array_elements(coalesce(snap -> 'photos', '[]'::jsonb)) x
  on conflict do nothing;

  update public.stickers set voided_at = now(), voided_by = public.current_email(), void_reason = 'replaced', replaced_by = s.code
  where stickers.code <> s.code and voided_at is null and (
    (k = 'gear' and not annual and kind = 'gear' and tech_sheet_id = sh.id and item_key = key)
    or (k = 'gear' and annual and kind = 'gear' and stickers.code = public.sticker_code(p ->> 'replaces') and body_id = body and discipline is not distinct from disc and (season = yr or public.sticker_seasonless(body)))
    or (k = 'car' and kind = 'car' and tech_sheet_id = sh.id)
    or (k = 'logbook' and kind = 'logbook' and logbook_id = lb.id and coalesce((p ->> 'replace')::boolean, false)));
  if app.id is not null then
    update public.sticker_applications set status = 'issued', sticker_code = s.code, handled_by = public.current_email(), handled_at = now()
    where id = app.id;
  end if;
  return public.sticker_json(s);
end $$;

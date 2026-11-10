-- Annual (season) car stickers, from an annual inspection tech sheet.
--  - Each body (without disciplines) or discipline can pick one of its tech sheets as its annual
--    car inspection sheet (bodies / body_disciplines.annual_car_template): the cage, seats, belts,
--    fire suppression... whatever it lists, with photos. None: no annual car stickers there.
--  - An annual inspection is a tech sheet without an event (tech_sheets.event_id null), for a body,
--    discipline and season, about a car: its logbook when it has one, else its VIN and details
--    (tech_sheets.car_info). A competitor can pre-fill it from PassTech (submit_annual_tech_sheet);
--    the body's scrutineers fill in their results and sign it off (save_annual_tech_sheet), or
--    start one themselves.
--  - Passed, a scrutineer issues the car's annual sticker (issue_annual_car_sticker): kind car,
--    with the season and no event, pointing to the sheet -- good for all of the body's (or
--    discipline's) events that season. At an event, the scrutineers see a car's valid annual
--    sticker (event_annual_car_stickers); the event's own sign-off stays required.

alter table bodies add column if not exists annual_car_template uuid references tech_sheet_templates(id);
alter table body_disciplines add column if not exists annual_car_template uuid references tech_sheet_templates(id);

alter table tech_sheets alter column event_id drop not null;
alter table tech_sheets add column if not exists body_id text references bodies(id);
alter table tech_sheets add column if not exists discipline text;
alter table tech_sheets add column if not exists season int;
alter table tech_sheets add column if not exists logbook_id uuid references logbooks(id);
-- The car, for an annual inspection: { vin, make, model, year, owner } ('car' would clash with
-- the event functions' variable of that name).
alter table tech_sheets add column if not exists car_info jsonb;
alter table tech_sheets drop constraint if exists tech_sheets_event_or_annual;
alter table tech_sheets add constraint tech_sheets_event_or_annual check (event_id is not null or (body_id is not null and season is not null));
create index if not exists tech_sheets_annual on tech_sheets (body_id, discipline, season) where event_id is null;

-- The annual car inspection sheet of a body (p_discipline null) or one of its disciplines.
create or replace function annual_car_template(p_body text, p_discipline text) returns public.tech_sheet_templates
language sql stable security definer
set search_path = ''
as $$
  select t.* from public.tech_sheet_templates t
  where t.active and t.id = case when p_discipline is null
    then (select b.annual_car_template from public.bodies b where b.id = p_body)
    else (select d.annual_car_template from public.body_disciplines d where d.body_id = p_body and d.id = p_discipline) end
$$;

create or replace function save_annual_car_template(p_body text, p_discipline text, p_template uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  disc text := nullif(trim(coalesce(p_discipline, '')), '');
begin
  if not (public.is_admin() or exists (
    select 1 from public.accreditations a where a.email = public.current_email() and a.body_id = p_body
      and a.role = 'technical_director' and public.accreditation_active(a) and (a.discipline is null or a.discipline = disc))) then
    raise exception 'only Frog Racing and the body''s technical directors choose its annual car inspection sheet';
  end if;
  if p_template is not null and not exists (select 1 from public.tech_sheet_templates t where t.id = p_template and t.active and t.body_id = p_body) then
    raise exception 'pick one of the body''s own tech sheets';
  end if;
  if disc is null then
    update public.bodies set annual_car_template = p_template where id = p_body;
  else
    update public.body_disciplines set annual_car_template = p_template where body_id = p_body and id = disc;
    if not found then raise exception 'no such discipline'; end if;
  end if;
end $$;

-- As before (20261109000000_annual_sticker_gear.sql), with each body's and discipline's annual
-- car inspection sheet (null: none).
create or replace function sticker_bodies() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'gear', to_jsonb(coalesce(b.annual_sticker_gear, '{}'::text[])),
    'carTemplate', public.template_json(public.annual_car_template(b.id, null)),
    'disciplines', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'gear', to_jsonb(coalesce(d.annual_sticker_gear, '{}'::text[])),
                      'carTemplate', public.template_json(public.annual_car_template(b.id, d.id)))
                      order by d.position, d.name), '[]'::jsonb)
                    from public.body_disciplines d where d.body_id = b.id and d.archived_at is null)) order by b.name), '[]'::jsonb)
  from public.bodies b where b.disabled_at is null and b.deleted_at is null
$$;

create or replace function annual_tech_sheet_json(s public.tech_sheets) returns jsonb
language sql stable
set search_path = ''
as $$
  select public.tech_sheet_json(s) || jsonb_build_object('body', s.body_id, 'bodyName', (select b.name from public.bodies b where b.id = s.body_id),
    'discipline', s.discipline, 'disciplineName', public.discipline_name(s.body_id, s.discipline), 'season', s.season,
    'car', s.car_info, 'logbook', s.logbook_id,
    'logbookNumber', (select l.digital_number from public.logbooks l where l.id = s.logbook_id),
    'sticker', (select public.sticker_json(k) from public.stickers k where k.tech_sheet_id = s.id and k.kind = 'car' and k.voided_at is null
                order by k.issued_at desc limit 1))
$$;

-- The car of an annual sheet, cleaned: { vin (upper case), make, model, year, owner }, and its
-- logbook (from its digital number, else its VIN).
create or replace function annual_car_of(p jsonb) returns jsonb
language sql immutable
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object('vin', nullif(upper(trim(coalesce(p ->> 'vin', ''))), ''),
    'make', nullif(trim(coalesce(p ->> 'make', '')), ''), 'model', nullif(trim(coalesce(p ->> 'model', '')), ''),
    'year', nullif(trim(coalesce(p ->> 'year', '')), ''), 'owner', nullif(trim(coalesce(p ->> 'owner', '')), '')))
$$;
create or replace function annual_car_logbook(p_number text, p_car jsonb) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
    (select l.id from public.logbooks l where nullif(trim(coalesce(p_number, '')), '') is not null and upper(l.digital_number) = upper(trim(p_number)) and l.status <> 'closed' limit 1),
    (select l.id from public.logbooks l where p_car ->> 'vin' is not null and l.vin = p_car ->> 'vin' and l.status <> 'closed' limit 1))
$$;

-- A competitor's annual inspection, from PassTech: p = { id? (to update their own), body,
-- discipline (for a body that has them), season?, header, variant, competitor, car, logbookNumber? }.
create or replace function submit_annual_tech_sheet(p jsonb) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  me text := public.current_email();
  body text := nullif(p ->> 'body', '');
  disc text := nullif(p ->> 'discipline', '');
  yr int := coalesce(nullif(p ->> 'season', '')::int, extract(year from now())::int);
  tpl public.tech_sheet_templates;
  sh public.tech_sheets;
  v_car jsonb := public.annual_car_of(coalesce(p -> 'car', '{}'::jsonb));
  declared jsonb := coalesce(p -> 'competitor', '{}'::jsonb) || jsonb_build_object('submittedAt', now(), 'by', me);
begin
  if me is null then raise exception 'sign in to submit an annual inspection'; end if;
  if body is null or not exists (select 1 from public.bodies b where b.id = body and b.disabled_at is null and b.deleted_at is null) then
    raise exception 'pick the sanctioning body';
  end if;
  if disc is null and exists (select 1 from public.body_disciplines d where d.body_id = body and d.archived_at is null) then
    raise exception 'pick the discipline';
  end if;
  if v_car ->> 'vin' is null and nullif(trim(coalesce(p ->> 'logbookNumber', '')), '') is null then
    raise exception 'enter the car''s VIN (or its logbook number)';
  end if;
  if nullif(p ->> 'id', '') is not null then
    select * into sh from public.tech_sheets where id = (p ->> 'id')::uuid and event_id is null;
    if sh.id is null or sh.submitted_by is distinct from me then raise exception 'no such annual inspection of yours'; end if;
    if sh.status = 'passed' then raise exception 'this annual inspection passed: it''s final'; end if;
    if sh.locked_until > now() then raise exception 'a scrutineer is inspecting this car right now -- re-submit once they''re done'; end if;
    update public.tech_sheets set header = coalesce(p -> 'header', header), variant = coalesce(p ->> 'variant', variant),
      competitor = declared, car_info = v_car, logbook_id = coalesce(public.annual_car_logbook(p ->> 'logbookNumber', v_car), logbook_id),
      status = case when sh.status = 'failed' then 'inspecting' else sh.status end, submitted_at = now(), updated_at = now()
    where id = sh.id;
    return sh.id;
  end if;
  tpl := public.annual_car_template(body, disc);
  if tpl.id is null then raise exception 'this sanctioning body doesn''t give annual car stickers%', case when disc is null then '' else ' in that discipline' end; end if;
  if exists (select 1 from public.tech_sheets s where s.event_id is null and s.submitted_by = me and s.body_id = body
             and s.discipline is not distinct from disc and s.season = yr and s.status in ('submitted', 'inspecting')
             and coalesce(s.car_info ->> 'vin', '') = coalesce(v_car ->> 'vin', '')) then
    raise exception 'this car already has an annual inspection waiting for that body, discipline and season: update it instead';
  end if;
  insert into public.tech_sheets (event_id, car_number, body_id, discipline, season, logbook_id, car_info, template_id, template, variant, header, competitor, submitted_by, submitted_at)
  values (null, coalesce(v_car ->> 'vin', 'annual'), body, disc, yr, public.annual_car_logbook(p ->> 'logbookNumber', v_car), v_car,
          tpl.id, tpl.definition, p ->> 'variant', coalesce(p -> 'header', '{}'::jsonb), declared, me, now())
  returning id into sh.id;
  return sh.id;
end $$;

create or replace function my_annual_tech_sheets() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.annual_tech_sheet_json(s) order by s.season desc, s.submitted_at desc), '[]'::jsonb)
  from public.tech_sheets s where s.event_id is null and s.submitted_by = public.current_email()
$$;

-- Whether the caller is one of a body's (discipline's) active scrutineers.
create or replace function annual_inspector(p_body text, p_discipline text) returns public.accreditations
language sql stable security definer
set search_path = ''
as $$ select * from public.my_accreditation_for(p_body, p_discipline) $$;

-- A body's annual inspections of a season (its scrutineers): p_discipline null for a body
-- without disciplines.
create or replace function annual_tech_sheets(p_body text, p_discipline text, p_season int) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if (public.annual_inspector(p_body, p_discipline)).id is null and not public.is_admin() then
    raise exception 'only the body''s scrutineers see its annual inspections';
  end if;
  return (select coalesce(jsonb_agg(public.annual_tech_sheet_json(s) order by s.updated_at desc), '[]'::jsonb)
    from public.tech_sheets s where s.event_id is null and s.body_id = p_body and s.discipline is not distinct from nullif(p_discipline, '') and s.season = p_season);
end $$;

-- A scrutineer's results on an annual inspection: p = { id? (none: a new one, for the car below),
-- body, discipline, season?, header, variant, car, logbookNumber?, inspection, finish? }.
create or replace function save_annual_tech_sheet(p jsonb) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  sh public.tech_sheets;
  tpl public.tech_sheet_templates;
  acc public.accreditations;
  body text := nullif(p ->> 'body', '');
  disc text := nullif(p ->> 'discipline', '');
  yr int := coalesce(nullif(p ->> 'season', '')::int, extract(year from now())::int);
  fin text := p ->> 'finish';
  v_car jsonb := public.annual_car_of(coalesce(p -> 'car', '{}'::jsonb));
  insp jsonb := coalesce(p -> 'inspection', '{}'::jsonb);
  sig jsonb;
begin
  if nullif(p ->> 'id', '') is not null then
    select * into sh from public.tech_sheets where id = (p ->> 'id')::uuid and event_id is null;
    if sh.id is null then raise exception 'no such annual inspection'; end if;
    body := sh.body_id; disc := sh.discipline; yr := sh.season;
  end if;
  acc := public.annual_inspector(body, disc);
  if acc.id is null then raise exception 'only the body''s scrutineers fill in its annual inspections'; end if;
  if fin is not null and fin not in ('pass', 'fail') then raise exception 'finish: pass or fail'; end if;
  if fin is not null and not public.accreditation_can(acc, 'sign_off_tech_sheets') then
    raise exception 'you aren''t allowed to sign off tech sheets (Passed / Failed) -- save it, and a scrutineer who is signs it';
  end if;
  if sh.id is null then
    tpl := public.annual_car_template(body, disc);
    if tpl.id is null then raise exception 'this sanctioning body has no annual car inspection sheet%', case when disc is null then '' else ' for that discipline' end; end if;
    if v_car ->> 'vin' is null and nullif(trim(coalesce(p ->> 'logbookNumber', '')), '') is null then
      raise exception 'enter the car''s VIN (or its logbook number)';
    end if;
    insert into public.tech_sheets (event_id, car_number, body_id, discipline, season, logbook_id, car_info, template_id, template, variant, header, status)
    values (null, coalesce(v_car ->> 'vin', 'annual'), body, disc, yr, public.annual_car_logbook(p ->> 'logbookNumber', v_car), v_car,
            tpl.id, tpl.definition, p ->> 'variant', coalesce(p -> 'header', '{}'::jsonb), 'inspecting')
    returning * into sh;
  elsif sh.status in ('passed', 'failed') then
    raise exception 'this annual inspection is signed: it can''t change';
  end if;
  sig := coalesce(sh.inspection -> 'signatures', '{}'::jsonb);
  if fin is not null then
    sig := sig || jsonb_build_object('scrutineer', jsonb_build_object('name', acc.name, 'license', acc.license_number,
      'email', acc.email, 'body', acc.body_id, 'at', now()));
  end if;
  insp := insp || jsonb_build_object('signatures', sig) || case when fin is null then '{}'::jsonb else jsonb_build_object('result', fin) end;
  update public.tech_sheets set
    header = coalesce(p -> 'header', header), variant = coalesce(p ->> 'variant', variant),
    car_info = case when v_car = '{}'::jsonb then tech_sheets.car_info else v_car end,
    logbook_id = coalesce(public.annual_car_logbook(p ->> 'logbookNumber', case when v_car = '{}'::jsonb then tech_sheets.car_info else v_car end), logbook_id),
    inspection = insp,
    status = case fin when 'pass' then 'passed' when 'fail' then 'failed' else 'inspecting' end,
    inspected_by = public.current_email(), inspected_at = case when fin is null then inspected_at else now() end, updated_at = now()
  where id = sh.id
  returning * into sh;
  return public.annual_tech_sheet_json(sh);
end $$;

-- The annual car sticker of a passed annual inspection (a new one voids the sheet's earlier one).
create or replace function issue_annual_car_sticker(p_sheet uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  sh public.tech_sheets;
  acc public.accreditations;
  s public.stickers;
  photos jsonb;
  snap jsonb;
begin
  select * into sh from public.tech_sheets where id = p_sheet and event_id is null;
  if sh.id is null then raise exception 'no such annual inspection'; end if;
  if sh.status <> 'passed' then raise exception 'the car must pass its annual inspection first'; end if;
  acc := public.annual_inspector(sh.body_id, sh.discipline);
  if (acc.id is null or not public.accreditation_can(acc, 'issue_annual_stickers')) and not public.is_admin() then
    raise exception 'you aren''t allowed to issue annual stickers for this body';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('sha256', x ->> 'sha256', 'kind', 'car')), '[]'::jsonb) into photos
  from jsonb_array_elements(coalesce(sh.competitor -> 'pictures' -> 'car', '[]'::jsonb) || coalesce(sh.inspection -> 'pictures' -> 'car', '[]'::jsonb)) x
  where x ->> 'sha256' ~ '^[0-9a-f]{64}$';
  snap := jsonb_build_object('annual', true, 'make', coalesce(sh.car_info ->> 'make', sh.header ->> 'make'), 'model', coalesce(sh.car_info ->> 'model', sh.header ->> 'model'),
    'year', coalesce(sh.car_info ->> 'year', sh.header ->> 'year'), 'vin', sh.car_info ->> 'vin',
    'logbookNumber', (select l.digital_number from public.logbooks l where l.id = sh.logbook_id),
    'driver', coalesce(sh.car_info ->> 'owner', sh.header ->> 'driver'), 'photos', photos);
  insert into public.stickers (code, kind, logbook_id, tech_sheet_id, event_id, body_id, discipline, snapshot, issued_by, accreditation_id, season)
  values (public.new_sticker_code(), 'car', sh.logbook_id, sh.id, null, sh.body_id, sh.discipline, snap, public.current_email(), acc.id, sh.season)
  returning * into s;
  insert into public.sticker_photos (code, sha256, kind)
  select s.code, x ->> 'sha256', x ->> 'kind' from jsonb_array_elements(photos) x
  on conflict do nothing;
  update public.stickers set voided_at = now(), voided_by = public.current_email(), void_reason = 'replaced', replaced_by = s.code
  where stickers.code <> s.code and voided_at is null and kind = 'car' and tech_sheet_id = sh.id;
  return public.sticker_json(s);
end $$;

-- At an event (its staff): each entry's valid annual car sticker for the event's body, discipline
-- and season -- by the car's logbook, else its VIN. { carNumber: { code, season, issuedAt, sheet } }.
create or replace function event_annual_car_stickers(p_event uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  ev public.events;
begin
  select * into ev from public.events where id = p_event;
  if ev.id is null then raise exception 'no such event'; end if;
  if public.event_role(ev.id) is null and not public.is_admin() then raise exception 'you are not on this event''s staff'; end if;
  return (select coalesce(jsonb_object_agg(x.car_number, x.info), '{}'::jsonb) from (
    select distinct on (en.car_number) en.car_number,
      jsonb_build_object('code', s.code, 'season', s.season, 'issuedAt', s.issued_at, 'sheet', s.tech_sheet_id,
        'make', s.snapshot ->> 'make', 'model', s.snapshot ->> 'model', 'year', s.snapshot ->> 'year') as info
    from public.event_entries en
    join public.stickers s on s.kind = 'car' and s.event_id is null and s.voided_at is null and s.body_id = ev.body_id
      and s.discipline is not distinct from ev.discipline and s.season = extract(year from ev.starts_on)::int
    left join public.logbooks l on l.id = en.logbook_id
    where en.event_id = ev.id and (
      (en.logbook_id is not null and s.logbook_id = en.logbook_id)
      or (s.snapshot ->> 'vin' is not null and s.snapshot ->> 'vin' in (l.vin, upper(en.vehicle ->> 'vin'))))
    order by en.car_number, s.issued_at desc) x);
end $$;

-- As before (20261026000000_disciplines.sql); an annual car sticker (no event) is good for its season.
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
                   when s.kind = 'car' and ev.id is null and s.season < extract(year from now())::int then 'expired'
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

-- New functions: callable only as intended.
revoke execute on function annual_car_template, save_annual_car_template, annual_tech_sheet_json, annual_car_of, annual_car_logbook,
  submit_annual_tech_sheet, my_annual_tech_sheets, annual_inspector, annual_tech_sheets, save_annual_tech_sheet,
  issue_annual_car_sticker, event_annual_car_stickers from public, anon, authenticated;
grant execute on function save_annual_car_template, submit_annual_tech_sheet, my_annual_tech_sheets, annual_tech_sheets,
  save_annual_tech_sheet, issue_annual_car_sticker, event_annual_car_stickers to authenticated;

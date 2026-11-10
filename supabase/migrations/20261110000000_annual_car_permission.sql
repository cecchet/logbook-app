-- Annual car stickers take their own permission: issue_annual_car_stickers (an annual car
-- inspection -- cage, seat, belts, fire system -- takes other training than checking gear).
--  - Technical directors hold it (all_permissions); it isn't one of the standard scrutineer ones,
--    so a scrutineer gets it only when someone holding it grants it.
--  - issue_annual_stickers stays the gear stickers' permission.
--  - Seeing, filling in and issuing annual car inspections checks it in the sheet's discipline
--    (any of the caller's accreditations there, or their all-disciplines one); signing one off
--    also takes sign_off_tech_sheets there.

create or replace function all_permissions() returns text[]
language sql immutable
set search_path = ''
as $$ select array['add_scrutineers', 'renew_licenses', 'edit_permissions', 'delete_scrutineers',
  'issue_annual_stickers', 'issue_annual_car_stickers', 'void_stickers', 'sign_off_tech_sheets', 'issue_logbooks', 'add_logbook_entries'] $$;

create or replace function annual_tech_sheets(p_body text, p_discipline text, p_season int) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not public.has_permission_in(p_body, nullif(p_discipline, ''), 'issue_annual_car_stickers') then
    raise exception 'only the body''s scrutineers allowed to do annual car inspections see them';
  end if;
  return (select coalesce(jsonb_agg(public.annual_tech_sheet_json(s) order by s.updated_at desc), '[]'::jsonb)
    from public.tech_sheets s where s.event_id is null and s.body_id = p_body and s.discipline is not distinct from nullif(p_discipline, '') and s.season = p_season);
end $$;

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
  if not public.has_permission_in(body, disc, 'issue_annual_car_stickers') then
    raise exception 'you aren''t allowed to do annual car inspections%', case when disc is null then '' else ' for this discipline' end;
  end if;
  if acc.id is null and public.is_admin() then acc.name := 'Frog Racing'; acc.email := public.current_email(); acc.body_id := body; end if;
  if fin is not null and fin not in ('pass', 'fail') then raise exception 'finish: pass or fail'; end if;
  if fin is not null and not public.has_permission_in(body, disc, 'sign_off_tech_sheets') then
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
  if not public.has_permission_in(sh.body_id, sh.discipline, 'issue_annual_car_stickers') then
    raise exception 'you aren''t allowed to issue annual car stickers%', case when sh.discipline is null then '' else ' for this discipline' end;
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

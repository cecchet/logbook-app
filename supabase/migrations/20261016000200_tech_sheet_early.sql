-- Tech sheets can be filled in before scrutineering opens: the event's staff
-- save a car's sheet (header, gear details, notes, photos) any time until
-- scrutineering ends; only the result (Passed / Failed, which signs the sheet,
-- sets the car's tech status and adds the logbook record) waits for the
-- scrutineering window. A team's submitted sheet saved early stays theirs to
-- update until scrutineering opens.
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
  acc := public.my_accreditation(ev.body_id);
  if acc.id is null then
    select a.* into acc from public.accreditations a
    where a.email = public.current_email() and public.accreditation_active(a) order by a.granted_at limit 1;
  end if;
  if acc.id is null then raise exception 'not an active scrutineer'; end if;
  select * into en from public.event_entries where event_id = ev.id and car_number = car;

  select * into sh from public.tech_sheets where event_id = ev.id and car_number = car;
  if sh.id is null then
    tpl := public.event_tech_template(ev.id);
    if tpl.id is null then raise exception 'this event has no tech sheet yet'; end if;
    insert into public.tech_sheets (event_id, car_number, entry_id, template_id, template, variant, header, competitor, status)
    values (ev.id, car, en.id, tpl.id, tpl.definition, p ->> 'variant', coalesce(p -> 'header', '{}'::jsonb), p -> 'competitor', 'inspecting')
    returning * into sh;
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
  insp := insp || jsonb_build_object('signatures', sig) || case when fin is null then '{}'::jsonb else jsonb_build_object('result', fin) end;

  update public.tech_sheets set
    header = coalesce(p -> 'header', header), variant = coalesce(p ->> 'variant', variant),
    competitor = coalesce(p -> 'competitor', competitor), entry_id = coalesce(en.id, entry_id),
    inspection = insp,
    -- Before scrutineering opens, a team's submitted sheet stays theirs to update.
    status = case fin when 'pass' then 'passed' when 'fail' then 'failed'
             else case when public.event_open(ev) or sh.status <> 'submitted' then 'inspecting' else sh.status end end,
    inspected_by = public.current_email(), inspected_at = case when fin is null then inspected_at else now() end,
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

-- An event can use several tech sheets -- one per group of classes (NEHA X and
-- non-X, formula cars and GT...), each kept by the scrutineers who know those
-- classes. event_tech_sheets lists them in order with the event classes each
-- covers; a car gets the sheet listing its class (else the first), and the
-- team (PassTech) or the scrutineer can pick another of the event's sheets.
-- An event without a list keeps using its single sheet (events.tech_sheet_template,
-- else its body's), which is also set to the list's first sheet for older callers.

create table event_tech_sheets (
  event_id uuid not null references events(id) on delete cascade,
  template_id uuid not null references tech_sheet_templates(id),
  classes text[] not null default '{}',
  position int not null default 0,
  primary key (event_id, template_id)
);
alter table event_tech_sheets enable row level security;
revoke all on event_tech_sheets from anon, authenticated;

-- The event's sheets, in order, each with its classes: [{ id, key, title, version, body, definition, classes }].
create or replace function event_tech_templates(p_event uuid) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select case when exists (select 1 from public.event_tech_sheets s where s.event_id = p_event) then
    (select coalesce(jsonb_agg(public.template_json(t) || jsonb_build_object('classes', to_jsonb(s.classes)) order by s.position), '[]'::jsonb)
     from public.event_tech_sheets s join public.tech_sheet_templates t on t.id = s.template_id and t.active
     where s.event_id = p_event)
  else
    (select case when x.id is null then '[]'::jsonb else jsonb_build_array(public.template_json(x) || jsonb_build_object('classes', '[]'::jsonb)) end
     from public.event_tech_template(p_event) x)
  end
$$;

-- Which of the event's sheets a car uses: the one asked for (it has to be one of the event's),
-- else the one listing its class (case-insensitive), else the first.
create or replace function event_template_for(p_event uuid, p_template uuid, p_class text) returns public.tech_sheet_templates
language plpgsql stable security definer
set search_path = ''
as $$
declare
  tpl public.tech_sheet_templates;
  cls text := lower(trim(coalesce(p_class, '')));
begin
  if not exists (select 1 from public.event_tech_sheets s where s.event_id = p_event) then
    tpl := public.event_tech_template(p_event);
    if p_template is not null and p_template is distinct from tpl.id then raise exception 'that tech sheet isn''t one of this event''s'; end if;
    return tpl;
  end if;
  if p_template is not null then
    select t.* into tpl from public.event_tech_sheets s join public.tech_sheet_templates t on t.id = s.template_id and t.active
    where s.event_id = p_event and t.id = p_template;
    if tpl.id is null then raise exception 'that tech sheet isn''t one of this event''s'; end if;
    return tpl;
  end if;
  select t.* into tpl from public.event_tech_sheets s join public.tech_sheet_templates t on t.id = s.template_id and t.active
  where s.event_id = p_event
  order by (cls <> '' and cls = any (select lower(trim(c)) from unnest(s.classes) c)) desc, s.position
  limit 1;
  return tpl;
end $$;

-- Organizers: the event's sheets. p_sheets: [{ template, classes: [...] }], in order ([] = back
-- to the body's default sheet).
create or replace function set_event_tech_sheets(p_event uuid, p_sheets jsonb) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  ev public.events;
  x jsonb;
  tpl public.tech_sheet_templates;
  n int := 0;
begin
  select * into ev from public.events where id = p_event;
  if ev.id is null or not public.can_organize(ev.body_id) then raise exception 'not allowed'; end if;
  delete from public.event_tech_sheets where event_id = p_event;
  for x in select * from jsonb_array_elements(coalesce(p_sheets, '[]'::jsonb)) loop
    select * into tpl from public.tech_sheet_templates where id = nullif(x ->> 'template', '')::uuid and active;
    if tpl.id is null then raise exception 'no such tech sheet'; end if;
    if tpl.body_id is not null and tpl.body_id <> ev.body_id then raise exception 'that tech sheet belongs to another body'; end if;
    insert into public.event_tech_sheets (event_id, template_id, classes, position)
    values (p_event, tpl.id, array(select trim(c) from jsonb_array_elements_text(coalesce(x -> 'classes', '[]'::jsonb)) c where trim(c) <> ''), n)
    on conflict (event_id, template_id) do nothing;
    n := n + 1;
  end loop;
  update public.events set tech_sheet_template = (select s.template_id from public.event_tech_sheets s where s.event_id = p_event order by s.position limit 1)
  where id = p_event;
end $$;

-- The events PassTech lists gain all their sheets (template: the first, as before).
create or replace function tech_sheet_events() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id, 'name', e.name, 'location', e.location, 'body', e.body_id,
    'bodyName', (select b.name from public.bodies b where b.id = e.body_id),
    'scrutineeringStartsOn', e.scrutineering_starts_on, 'startsOn', e.starts_on, 'endsOn', e.ends_on,
    'template', public.template_json(public.event_tech_template(e.id)),
    'templates', public.event_tech_templates(e.id)
  ) order by e.starts_on), '[]'::jsonb)
  from public.events e
  where e.cancelled_at is null and current_date <= e.ends_on
$$;

create or replace function submit_tech_sheet(p jsonb) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  ev public.events;
  want uuid := nullif(p ->> 'template', '')::uuid;
  sh public.tech_sheets;
  tpl public.tech_sheet_templates;
  car text := trim(coalesce(p ->> 'carNumber', ''));
  me text := public.current_email();
  declared jsonb;
begin
  if me is null then raise exception 'sign in to submit a tech sheet'; end if;
  select * into ev from public.events where id = nullif(p ->> 'event', '')::uuid;
  if ev.id is null or ev.cancelled_at is not null then raise exception 'no such event'; end if;
  if current_date > ev.ends_on then raise exception 'this event is over'; end if;
  if car = '' then raise exception 'enter the car number'; end if;
  declared := coalesce(p -> 'competitor', '{}'::jsonb) || jsonb_build_object('submittedAt', now(), 'by', me);
  select * into sh from public.tech_sheets where event_id = ev.id and car_number = car;
  if sh.id is not null then
    if sh.submitted_by is distinct from me then raise exception 'car % already has a tech sheet for this event', car; end if;
    if sh.status <> 'submitted' then raise exception 'car % is already being inspected', car; end if;
    if want is not null and want is distinct from sh.template_id then
      tpl := public.event_template_for(ev.id, want, null);
      update public.tech_sheets set template_id = tpl.id, template = tpl.definition where id = sh.id;
    end if;
    update public.tech_sheets set header = coalesce(p -> 'header', '{}'::jsonb), variant = p ->> 'variant',
      competitor = declared, submitted_at = now(), updated_at = now()
    where id = sh.id;
    return sh.id;
  end if;
  -- The sheet asked for, else the one for the car's class (entry list, else what the team wrote).
  tpl := public.event_template_for(ev.id, want, coalesce((select x.class from public.event_entries x where x.event_id = ev.id and x.car_number = car), p -> 'header' ->> 'class'));
  if tpl.id is null then raise exception 'this event has no tech sheet yet'; end if;
  insert into public.tech_sheets (event_id, car_number, entry_id, template_id, template, variant, header, competitor, submitted_by, submitted_at)
  values (ev.id, car, (select x.id from public.event_entries x where x.event_id = ev.id and x.car_number = car),
          tpl.id, tpl.definition, p ->> 'variant', coalesce(p -> 'header', '{}'::jsonb), declared, me, now())
  returning id into sh.id;
  return sh.id;
end $$;

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
  acc := public.my_accreditation(ev.body_id);
  if acc.id is null then
    select a.* into acc from public.accreditations a
    where a.email = public.current_email() and public.accreditation_active(a) order by a.granted_at limit 1;
  end if;
  if acc.id is null then raise exception 'not an active scrutineer'; end if;
  select * into en from public.event_entries where event_id = ev.id and car_number = car;

  select * into sh from public.tech_sheets where event_id = ev.id and car_number = car;
  if sh.id is null then
    -- The sheet the scrutineer picked, else the one for the car's class.
    tpl := public.event_template_for(ev.id, want, coalesce(en.class, p -> 'header' ->> 'class'));
    if tpl.id is null then raise exception 'this event has no tech sheet yet'; end if;
    insert into public.tech_sheets (event_id, car_number, entry_id, template_id, template, variant, header, competitor, status)
    values (ev.id, car, en.id, tpl.id, tpl.definition, p ->> 'variant', coalesce(p -> 'header', '{}'::jsonb), p -> 'competitor', 'inspecting')
    returning * into sh;
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
      from public.event_entries x where x.event_id = p_event),
    'techTemplate', public.template_json(public.event_tech_template(p_event)),
    'techTemplates', public.event_tech_templates(p_event),
    'techSheets', (select coalesce(jsonb_agg(public.tech_sheet_json(s) order by s.car_number), '[]'::jsonb)
      from public.tech_sheets s where s.event_id = p_event));
end $$;

revoke execute on function event_tech_templates, event_template_for, set_event_tech_sheets from public, anon, authenticated;
grant execute on function event_tech_templates, event_template_for to anon, authenticated;
grant execute on function set_event_tech_sheets to authenticated;

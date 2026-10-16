-- Digital tech inspection sheets (see tech-sheets/FORMAT.md).
--
-- Templates: the built-in library (body_id null, seeded from
-- tech-sheets/templates) and each body's own copies, which its technical
-- director edits. Anyone can read the active ones (PassTech pre-fills
-- them without signing in).
--
-- Tech sheets: one per car per event, holding the template it was filled
-- against (a snapshot -- a template edited later doesn't change it), what the
-- team declared (competitor, from PassTech: signed in, or imported from a
-- file by the staff) and the scrutineer's results (inspection). A finished
-- sheet sets the car's tech status, and adds a signed inspection record to
-- its logbook when it has one.

create table tech_sheet_templates (
  id uuid primary key default gen_random_uuid(),
  -- null: the built-in library a body starts from.
  body_id text references bodies(id),
  key text not null,
  title text not null,
  definition jsonb not null,
  version int not null default 1,
  active boolean not null default true,
  updated_by text not null default 'frog-racing',
  updated_at timestamptz not null default now()
);
create unique index tech_sheet_templates_key on tech_sheet_templates (coalesce(body_id, ''), key);

-- The sheet an event uses (null: its body's newest active one).
alter table events add column tech_sheet_template uuid references tech_sheet_templates(id);

create table tech_sheets (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id),
  car_number text not null,
  entry_id uuid references event_entries(id),
  template_id uuid references tech_sheet_templates(id),
  template jsonb not null,
  variant text,
  header jsonb not null default '{}',
  competitor jsonb,
  inspection jsonb,
  status text not null default 'submitted' check (status in ('submitted', 'inspecting', 'passed', 'failed')),
  submitted_by text,
  submitted_at timestamptz,
  inspected_by text,
  inspected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, car_number)
);

alter table tech_sheet_templates enable row level security;
alter table tech_sheets enable row level security;
revoke all on tech_sheet_templates, tech_sheets from anon, authenticated;
grant select on tech_sheet_templates to anon, authenticated;
create policy tech_sheet_templates_read on tech_sheet_templates for select to anon, authenticated using (active);
-- Tech sheets are only read and written through the functions below.

-- ---------------------------------------------------------------------------
-- Which template an event uses
-- ---------------------------------------------------------------------------

create or replace function event_tech_template(p_event uuid) returns public.tech_sheet_templates
language sql stable security definer
set search_path = ''
as $$
  select t.* from public.events e
  join public.tech_sheet_templates t on t.active and (
    t.id = e.tech_sheet_template
    or (e.tech_sheet_template is null and (t.body_id = e.body_id or (t.body_id is null and t.definition ->> 'bodyId' = e.body_id))))
  where e.id = p_event
  -- The event's own choice, then the body's copy, then the built-in one.
  order by (t.id = e.tech_sheet_template) desc, (t.body_id is not null) desc, t.updated_at desc
  limit 1
$$;

create or replace function template_json(t public.tech_sheet_templates) returns jsonb
language sql stable
set search_path = ''
as $$
  select case when t.id is null then null else jsonb_build_object('id', t.id, 'key', t.key, 'title', t.title,
    'version', t.version, 'body', t.body_id, 'definition', t.definition) end
$$;

-- Organizers: create or update their body's template (the library's when
-- body is null -- Frog Racing admins only). p: { id?, body, key, title,
-- definition, active? }. A save bumps the version.
create or replace function save_tech_sheet_template(p jsonb) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  body text := nullif(p ->> 'body', '');
  result uuid;
begin
  if body is null and not public.is_admin() then raise exception 'not allowed'; end if;
  if body is not null and not public.can_organize(body) then raise exception 'not allowed'; end if;
  if coalesce(p ->> 'key', '') = '' or coalesce(p ->> 'title', '') = '' or jsonb_typeof(p -> 'definition') <> 'object' then
    raise exception 'a template needs a key, a title and its definition';
  end if;
  update public.tech_sheet_templates set title = p ->> 'title', definition = p -> 'definition',
    active = coalesce((p ->> 'active')::boolean, active), version = version + 1,
    updated_by = public.current_email(), updated_at = now()
  where coalesce(body_id, '') = coalesce(body, '')
    and (id = nullif(p ->> 'id', '')::uuid or (p ->> 'id' is null and key = p ->> 'key'))
  returning id into result;
  if result is null then
    insert into public.tech_sheet_templates (body_id, key, title, definition, active, updated_by)
    values (body, p ->> 'key', p ->> 'title', p -> 'definition', coalesce((p ->> 'active')::boolean, true), public.current_email())
    returning id into result;
  end if;
  return result;
end $$;

-- Organizers: the sheet their event uses (null: the body's default).
create or replace function set_event_tech_sheet(p_event uuid, p_template uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  ev public.events;
begin
  select * into ev from public.events where id = p_event;
  if ev.id is null or not public.can_organize(ev.body_id) then raise exception 'not allowed'; end if;
  update public.events set tech_sheet_template = p_template where id = p_event;
end $$;

-- ---------------------------------------------------------------------------
-- Competitors (PassTech)
-- ---------------------------------------------------------------------------

-- The events a competitor can submit a tech sheet to: not cancelled, not
-- over yet -- with the sheet each uses. Anyone can list them.
create or replace function tech_sheet_events() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id, 'name', e.name, 'location', e.location, 'body', e.body_id,
    'bodyName', (select b.name from public.bodies b where b.id = e.body_id),
    'scrutineeringStartsOn', e.scrutineering_starts_on, 'startsOn', e.starts_on, 'endsOn', e.ends_on,
    'template', public.template_json(public.event_tech_template(e.id))
  ) order by e.starts_on), '[]'::jsonb)
  from public.events e
  where e.cancelled_at is null and current_date <= e.ends_on
$$;

-- A competitor submits (or updates) their car's sheet for an event, until
-- its inspection starts. p: { event, carNumber, header, variant?, competitor: { items } }
create or replace function submit_tech_sheet(p jsonb) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  ev public.events;
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
    update public.tech_sheets set header = coalesce(p -> 'header', '{}'::jsonb), variant = p ->> 'variant',
      competitor = declared, submitted_at = now(), updated_at = now()
    where id = sh.id;
    return sh.id;
  end if;
  tpl := public.event_tech_template(ev.id);
  if tpl.id is null then raise exception 'this event has no tech sheet yet'; end if;
  insert into public.tech_sheets (event_id, car_number, entry_id, template_id, template, variant, header, competitor, submitted_by, submitted_at)
  values (ev.id, car, (select x.id from public.event_entries x where x.event_id = ev.id and x.car_number = car),
          tpl.id, tpl.definition, p ->> 'variant', coalesce(p -> 'header', '{}'::jsonb), declared, me, now())
  returning id into sh.id;
  return sh.id;
end $$;

-- A competitor's own sheets, with the scrutineer's results once inspected.
create or replace function my_tech_sheets() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'event', s.event_id, 'eventName', e.name, 'body', e.body_id, 'startsOn', e.starts_on,
    'carNumber', s.car_number, 'status', s.status, 'variant', s.variant, 'header', s.header,
    'template', s.template, 'competitor', s.competitor, 'inspection', s.inspection,
    'submittedAt', s.submitted_at, 'inspectedAt', s.inspected_at
  ) order by e.starts_on desc), '[]'::jsonb)
  from public.tech_sheets s join public.events e on e.id = s.event_id
  where s.submitted_by = public.current_email()
$$;

-- ---------------------------------------------------------------------------
-- Scrutineers (Digital logbooks, Event mode)
-- ---------------------------------------------------------------------------

create or replace function tech_sheet_json(s public.tech_sheets) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object('id', s.id, 'event', s.event_id, 'carNumber', s.car_number, 'entry', s.entry_id,
    'templateId', s.template_id, 'template', s.template, 'variant', s.variant, 'header', s.header,
    'competitor', s.competitor, 'inspection', s.inspection, 'status', s.status,
    'submittedBy', s.submitted_by, 'submittedAt', s.submitted_at, 'inspectedBy', s.inspected_by,
    'inspectedAt', s.inspected_at, 'updatedAt', s.updated_at)
$$;

-- The event's sheets (its staff and organizers).
create or replace function event_tech_sheets(p_event uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  ev public.events;
begin
  select * into ev from public.events where id = p_event;
  if ev.id is null or not (public.event_role(p_event) is not null or public.can_organize(ev.body_id)) then raise exception 'not allowed'; end if;
  return (select coalesce(jsonb_agg(public.tech_sheet_json(s) order by s.car_number), '[]'::jsonb)
          from public.tech_sheets s where s.event_id = p_event);
end $$;

-- The event's staff fill or review a car's sheet, during the event's window.
-- p: { carNumber, header?, variant?, competitor? (a team's sheet imported from
-- a file), inspection: { items, corrections }, finish?: 'pass' | 'fail',
-- signAs?: 'chief' }. Finishing signs the sheet as the scrutineer (and as the
-- chief scrutineer when asked by them), sets the car's tech status and, for a
-- car with a logbook the event accepts, adds the inspection record to it.
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
  if not public.event_open(ev) then raise exception 'this event is not open for records (scrutineering % to the day after %)', ev.scrutineering_starts_on, ev.ends_on; end if;
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
    status = case fin when 'pass' then 'passed' when 'fail' then 'failed' else 'inspecting' end,
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

-- The offline bundle gains the event's sheets and its template.
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
    'techSheets', (select coalesce(jsonb_agg(public.tech_sheet_json(s) order by s.car_number), '[]'::jsonb)
      from public.tech_sheets s where s.event_id = p_event));
end $$;

-- ---------------------------------------------------------------------------
-- Photos on tech sheets: gear and tag photos (the competitor's, from
-- PassTech) and the scrutineer's. Named by their SHA-256 like logbook
-- photos; anyone signed in uploads, scrutineers and admins read.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public) values ('tech-sheet-photos', 'tech-sheet-photos', false)
  on conflict (id) do nothing;
create policy tech_sheet_photos_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'tech-sheet-photos' and name ~ '^[0-9a-f]{64}$');
create policy tech_sheet_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'tech-sheet-photos' and (public.is_admin() or public.is_scrutineer()));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function event_tech_template, template_json, tech_sheet_json, save_tech_sheet_template,
  set_event_tech_sheet, tech_sheet_events, submit_tech_sheet, my_tech_sheets, event_tech_sheets, save_tech_sheet
  from public, anon, authenticated;
grant execute on function save_tech_sheet_template, set_event_tech_sheet, tech_sheet_events, submit_tech_sheet,
  my_tech_sheets, event_tech_sheets, save_tech_sheet, event_tech_template, template_json, tech_sheet_json to authenticated;
grant execute on function tech_sheet_events, event_tech_template, template_json to anon;

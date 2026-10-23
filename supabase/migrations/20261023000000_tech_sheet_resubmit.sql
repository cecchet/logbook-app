-- A team edits and re-submits its tech sheet until tech gives its verdict --
-- except while a scrutineer has the sheet open (a lock of a few minutes,
-- renewed while it stays open) -- and after a Failed verdict re-submits the
-- lines that failed, for them to be inspected again. A Passed sheet is final.
--  - Lines the team changes after the inspection started lose their result
--    (and the scrutineer's copy of their gear details): they're checked again,
--    marked teamUpdatedAt.
--  - Re-submitting after a fail moves the verdict (result, signatures,
--    corrections) to inspection.history, puts the sheet back to inspecting and
--    the car back to "to inspect". The logbook keeps its Failed record; passing
--    later adds a Passed one.
--  - A scrutineer's save is refused when the team re-submitted since the
--    scrutineer opened the sheet (p.seenSubmittedAt), instead of overwriting it.

alter table tech_sheets add column if not exists locked_by text;
alter table tech_sheets add column if not exists locked_until timestamptz;

create or replace function tech_sheet_json(s public.tech_sheets) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object('id', s.id, 'event', s.event_id, 'carNumber', s.car_number, 'entry', s.entry_id,
    'templateId', s.template_id, 'template', s.template, 'variant', s.variant, 'header', s.header,
    'competitor', s.competitor, 'inspection', s.inspection, 'status', s.status,
    'submittedBy', s.submitted_by, 'submittedAt', s.submitted_at, 'inspectedBy', s.inspected_by,
    'inspectedAt', s.inspected_at, 'updatedAt', s.updated_at,
    'lockedBy', case when s.locked_until > now() then s.locked_by end)
$$;

-- A scrutineer opens (p_lock) or closes a car's sheet: while open, the team can't re-submit.
-- The lock lasts 15 minutes and is renewed by the open sheet (and each save).
create or replace function lock_tech_sheet(p_sheet uuid, p_lock boolean) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  sh public.tech_sheets;
  me text := public.current_email();
begin
  select * into sh from public.tech_sheets where id = p_sheet;
  if sh.id is null then raise exception 'no such tech sheet'; end if;
  if public.event_role(sh.event_id) is null and not public.is_admin() then raise exception 'you are not on this event''s staff'; end if;
  if p_lock then
    if sh.status in ('passed', 'failed') then return jsonb_build_object('lockedBy', null); end if;
    update public.tech_sheets set locked_by = me, locked_until = now() + interval '15 minutes' where id = sh.id returning * into sh;
  else
    update public.tech_sheets set locked_until = null where id = sh.id and locked_by = me returning * into sh;
  end if;
  return jsonb_build_object('lockedBy', case when sh.locked_until > now() then sh.locked_by end, 'lockedUntil', sh.locked_until);
end $$;

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
  old_items jsonb;
  new_items jsonb;
  merged jsonb;
  failed_keys jsonb;
  changed jsonb;
  insp jsonb;
  k text;
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
    if sh.status = 'passed' then raise exception 'car % passed tech: its sheet is final', car; end if;
    if sh.locked_until > now() then
      raise exception 'a scrutineer is inspecting car % right now -- re-submit once they''re done (a few minutes), or show them your changes', car;
    end if;

    old_items := coalesce(sh.competitor -> 'items', '{}'::jsonb);
    new_items := coalesce(p -> 'competitor' -> 'items', '{}'::jsonb);
    merged := new_items;
    -- Failed: only its failed lines change (all of them when the fail was for corrections alone).
    if sh.status = 'failed' then
      select coalesce(jsonb_agg(i.k), '[]'::jsonb) into failed_keys
      from jsonb_each(coalesce(sh.inspection -> 'items', '{}'::jsonb)) as i(k, v) where i.v ->> 'result' = 'fail';
      if jsonb_array_length(failed_keys) > 0 then
        merged := old_items;
        for k in select jsonb_array_elements_text(failed_keys) loop
          if new_items ? k then merged := jsonb_set(merged, array[k], new_items -> k, true); end if;
        end loop;
      end if;
    end if;
    declared := declared || jsonb_build_object('items', merged);

    insp := coalesce(sh.inspection, '{}'::jsonb);
    if sh.status <> 'submitted' then
      -- What the team changed since the inspection started: checked again.
      select coalesce(jsonb_agg(x.k), '[]'::jsonb) into changed
      from (select a.k from jsonb_object_keys(merged) as a(k) union select b.k from jsonb_object_keys(old_items) as b(k)) x
      where merged -> x.k is distinct from old_items -> x.k;
      for k in select jsonb_array_elements_text(changed) loop
        if insp -> 'items' ? k then
          insp := jsonb_set(insp, array['items', k], ((insp -> 'items' -> k) - 'result' - 'gear') || jsonb_build_object('teamUpdatedAt', now()));
        end if;
      end loop;
      declared := declared || jsonb_build_object('changed', changed);
      if sh.status = 'failed' then
        insp := (insp - 'result' - 'signatures' - 'corrections') || jsonb_build_object('history',
          coalesce(insp -> 'history', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('result', insp ->> 'result',
            'signatures', insp -> 'signatures', 'corrections', insp ->> 'corrections', 'at', sh.inspected_at, 'resubmittedAt', now())));
        update public.event_entries set tech_status = 'pending', updated_at = now() where id = sh.entry_id and tech_status = 'failed';
      end if;
    end if;

    if want is not null and want is distinct from sh.template_id and sh.status <> 'failed' then
      tpl := public.event_template_for(ev.id, want, null);
      update public.tech_sheets set template_id = tpl.id, template = tpl.definition where id = sh.id;
    end if;
    update public.tech_sheets set
      header = case when sh.status = 'failed' then header else coalesce(p -> 'header', '{}'::jsonb) end,
      variant = case when sh.status = 'failed' then variant else p ->> 'variant' end,
      competitor = declared, inspection = insp,
      status = case when sh.status = 'failed' then 'inspecting' else sh.status end,
      submitted_at = now(), updated_at = now()
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

-- A competitor's own sheets, with the scrutineer's results once inspected, and whether a
-- scrutineer has it open right now (re-submitting waits).
create or replace function my_tech_sheets() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'event', s.event_id, 'eventName', e.name, 'body', e.body_id, 'startsOn', e.starts_on,
    'carNumber', s.car_number, 'status', s.status, 'variant', s.variant, 'header', s.header,
    'template', s.template, 'competitor', s.competitor, 'inspection', s.inspection,
    'submittedAt', s.submitted_at, 'inspectedAt', s.inspected_at,
    'lockedNow', coalesce(s.locked_until > now(), false)
  ) order by e.starts_on desc), '[]'::jsonb)
  from public.tech_sheets s join public.events e on e.id = s.event_id
  where s.submitted_by = public.current_email()
$$;

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

revoke execute on function lock_tech_sheet from public, anon;
grant execute on function lock_tech_sheet to authenticated;

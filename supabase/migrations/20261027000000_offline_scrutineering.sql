-- Scrutineering offline: a scrutineer works an event's tech sheets without a connection and
-- syncs later; stickers print offline with codes reserved in advance.
--  - save_tech_sheet: p.baseUpdatedAt -- the sheet's updatedAt (tech_sheet_json, sent back as
--    it came) the device's edit started from; "" when the device had no sheet for the car. When
--    given, a sheet changed since (or created meanwhile) is refused with an error starting
--    "conflict:" (SQLSTATE TS409), before anything is written. Absent: no check (older clients).
--  - p.offlineAt (save_tech_sheet, issue_sticker): when the change was made offline. Synced up to
--    3 days later; the event's windows, the signatures' time, inspected_at and a sticker's
--    issued_at go by it (never later than now).
--  - sticker_code_reservations: codes a scrutineer reserves for an event (reserve_sticker_codes)
--    to print stickers offline; issue_sticker's p.code issues the sticker under one of them.
--    new_sticker_code never hands out a reserved code.
--  - issue_sticker finds a sheet by p.event + p.carNumber when there's no p.techSheet (a sheet
--    created offline has no id on the device yet).

create table if not exists sticker_code_reservations (
  code text primary key check (code ~ '^[2-9A-HJ-NP-Z]{8}$'),
  event_id uuid not null references events(id),
  reserved_by text not null,
  reserved_at timestamptz not null default now(),
  used_at timestamptz
);
create index if not exists sticker_code_reservations_mine on sticker_code_reservations (event_id, reserved_by) where used_at is null;
alter table sticker_code_reservations enable row level security;
revoke all on sticker_code_reservations from anon, authenticated;

-- 8 characters, no 0/O, 1/I/L, U: neither a sticker's nor a reserved code.
create or replace function new_sticker_code() returns text
language plpgsql volatile
set search_path = ''
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  candidate text;
  bytes bytea;
begin
  loop
    bytes := extensions.gen_random_bytes(8);
    candidate := '';
    for i in 0..7 loop
      candidate := candidate || substr(alphabet, (get_byte(bytes, i) % 30) + 1, 1);
    end loop;
    exit when not exists (select 1 from public.stickers where code = candidate)
      and not exists (select 1 from public.sticker_code_reservations where code = candidate);
  end loop;
  return candidate;
end $$;

-- event_open on a given day (the day an offline change was made).
create or replace function event_open_on(e public.events, d date) returns boolean
language sql stable
set search_path = ''
as $$ select e.cancelled_at is null and d between e.scrutineering_starts_on and e.ends_on + 1 $$;

-- When an offline change was made (p.offlineAt), never later than now; now() without it.
-- Refused more than 3 days later.
create or replace function offline_time(p jsonb) returns timestamptz
language plpgsql stable
set search_path = ''
as $$
declare
  t timestamptz := nullif(p ->> 'offlineAt', '')::timestamptz;
begin
  if t is null then return now(); end if;
  if t < now() - interval '3 days' then raise exception 'this change was made offline more than 3 days ago -- it can''t be synced'; end if;
  return least(now(), t);
end $$;

-- Reserves up to p_count sticker codes for an event (the caller's unused ones capped at 200);
-- returns all the caller's unused codes for it, oldest first.
create or replace function reserve_sticker_codes(p_event uuid, p_count int) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  ev public.events;
  me text := public.current_email();
  have int;
begin
  select * into ev from public.events where id = p_event;
  if ev.id is null then raise exception 'no such event'; end if;
  if public.event_role(ev.id) is null and not public.is_admin() then raise exception 'only the event''s staff reserve its sticker codes'; end if;
  if ev.cancelled_at is not null or current_date > ev.ends_on + 1 then raise exception 'this event is over'; end if;
  if p_count is null or p_count < 1 or p_count > 100 then raise exception 'reserve 1 to 100 codes at a time'; end if;
  select count(*) into have from public.sticker_code_reservations where event_id = ev.id and reserved_by = me and used_at is null;
  for i in 1..least(p_count, 200 - have) loop
    insert into public.sticker_code_reservations (code, event_id, reserved_by) values (public.new_sticker_code(), ev.id, me);
  end loop;
  return (select coalesce(jsonb_agg(r.code order by r.reserved_at, r.code), '[]'::jsonb)
          from public.sticker_code_reservations r where r.event_id = ev.id and r.reserved_by = me and r.used_at is null);
end $$;

-- A tech sheet: p.baseUpdatedAt (conflicts) and p.offlineAt (see the top).
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
  base text := coalesce(p ->> 'baseUpdatedAt', '');
  t timestamptz;
  sig jsonb;
  failed jsonb;
  record_id uuid;
begin
  select * into ev from public.events where id = p_event;
  if ev.id is null then raise exception 'no such event'; end if;
  if role is null then raise exception 'you are not on this event''s staff'; end if;
  t := public.offline_time(p);
  -- Filling in: any time until scrutineering ends. The result (finish): only during it.
  if ev.cancelled_at is not null or t::date > ev.ends_on + 1 then raise exception 'this event is over'; end if;
  if fin is not null and not public.event_open_on(ev, t::date) then
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
  -- The sheet changed since the device last had it (or was created meanwhile): nothing is saved.
  if p ? 'baseUpdatedAt' and sh.id is not null and (base = '' or base::timestamptz <> sh.updated_at) then
    raise exception 'conflict: car %''s sheet changed since this device last had it (by %, at %)', car,
      coalesce(case when sh.submitted_at >= sh.updated_at then sh.submitted_by end, sh.inspected_by, sh.submitted_by, 'someone'),
      to_jsonb(sh.updated_at) #>> '{}'
      using errcode = 'TS409';
  end if;
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

  -- Signatures: kept from earlier saves, added when finishing (at the time it was done, offline or not).
  sig := coalesce(sh.inspection -> 'signatures', '{}'::jsonb);
  if fin is not null then
    sig := sig || jsonb_build_object('scrutineer', jsonb_build_object('name', acc.name, 'license', acc.license_number,
      'email', acc.email, 'body', acc.body_id, 'at', t));
    if p ->> 'signAs' = 'chief' then
      sig := sig || jsonb_build_object('chief', jsonb_build_object('name', acc.name, 'license', acc.license_number,
        'email', acc.email, 'body', acc.body_id, 'at', t));
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
             else case when public.event_open_on(ev, t::date) or sh.status <> 'submitted' then 'inspecting' else sh.status end end,
    inspected_by = public.current_email(), inspected_at = case when fin is null then inspected_at else t end,
    -- The open sheet keeps its lock; a verdict releases it.
    locked_by = public.current_email(), locked_until = case when fin is null then now() + interval '15 minutes' end,
    -- (Always the time of the sync: what baseUpdatedAt is checked against.)
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

-- Stickers: p.code (a reserved code, event stickers only), p.event + p.carNumber (no p.techSheet)
-- and p.offlineAt (see the top).
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
    or (k = 'gear' and annual and kind = 'gear' and stickers.code = public.sticker_code(p ->> 'replaces') and body_id = body and discipline is not distinct from disc and season = yr)
    or (k = 'car' and kind = 'car' and tech_sheet_id = sh.id)
    or (k = 'logbook' and kind = 'logbook' and logbook_id = lb.id and coalesce((p ->> 'replace')::boolean, false)));
  if app.id is not null then
    update public.sticker_applications set status = 'issued', sticker_code = s.code, handled_by = public.current_email(), handled_at = now()
    where id = app.id;
  end if;
  return public.sticker_json(s);
end $$;

revoke execute on function event_open_on, offline_time, reserve_sticker_codes from public, anon, authenticated;
grant execute on function event_open_on, reserve_sticker_codes to authenticated;

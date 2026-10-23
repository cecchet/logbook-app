-- A scrutineer removes a team photo from a tech sheet line (the wrong tag,
-- say): the line's inspection lists it in removedPhotos (the team's own
-- submission is left as they sent it). A gear sticker issued from the line
-- leaves those photos out.
create or replace function issue_sticker(p jsonb) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  k text := p ->> 'kind';
  lb public.logbooks;
  sh public.tech_sheets;
  ev public.events;
  acc public.accreditations;
  s public.stickers;
  key text := p ->> 'item';
  it jsonb;
  dec jsonb;
  gear jsonb;
  photos jsonb;
  snap jsonb;
  body text;
begin
  if k = 'logbook' then
    select * into lb from public.logbooks where id = (p ->> 'logbook')::uuid;
    if lb.id is null then raise exception 'no such logbook'; end if;
    if not public.is_scrutineer() then raise exception 'only scrutineers issue stickers'; end if;
    if lb.status <> 'active' then raise exception 'this logbook is %', lb.status; end if;
    body := lb.issuing_body;
    snap := jsonb_build_object('digitalNumber', lb.digital_number, 'make', lb.make, 'model', lb.model, 'year', lb.year);
  elsif k in ('gear', 'car') then
    select * into sh from public.tech_sheets where id = (p ->> 'techSheet')::uuid;
    if sh.id is null then raise exception 'save the tech sheet first'; end if;
    select * into ev from public.events where id = sh.event_id;
    if public.event_role(ev.id) is null and not public.is_admin() then raise exception 'only the event''s staff issue its stickers'; end if;
    body := ev.body_id;
    if k = 'gear' then
      it := sh.inspection -> 'items' -> key;
      dec := sh.competitor -> 'items' -> key;
      if coalesce(it ->> 'result', '') <> 'pass' then raise exception 'mark this line Pass and save the sheet first'; end if;
      gear := coalesce(it -> 'gear', dec -> 'gear');
      if gear is null or not public.sticker_gear(gear ->> 'category') then raise exception 'stickers go on helmets, HANS devices and seats'; end if;
      select coalesce(jsonb_agg(distinct jsonb_build_object('sha256', x ->> 'sha256', 'kind', case when x ->> 'kind' = 'tag' then 'tag' else 'item' end)), '[]'::jsonb)
        into photos
      from jsonb_array_elements(coalesce(dec -> 'photos', '[]'::jsonb) || coalesce(it -> 'photos', '[]'::jsonb)) x
      where x ->> 'sha256' ~ '^[0-9a-f]{64}$'
        -- (Not a team photo the scrutineer removed from the line.)
        and not coalesce(it -> 'removedPhotos', '[]'::jsonb) ? (x ->> 'sha256');
      if not exists (select 1 from jsonb_array_elements(photos) x where x ->> 'kind' = 'tag')
         or not exists (select 1 from jsonb_array_elements(photos) x where x ->> 'kind' = 'item') then
        raise exception 'a gear sticker needs a photo of the item and one of its tag';
      end if;
      snap := jsonb_build_object('category', gear ->> 'category', 'label', coalesce(nullif(p ->> 'label', ''), key),
        'occupant', case when key like '%.codriver' then 'codriver' when key like '%.driver' then 'driver' else null end,
        'gear', gear - 'photoDataUrls' - 'key', 'photos', photos, 'carNumber', sh.car_number,
        'driver', case when key like '%.codriver' then sh.header ->> 'codriver' else sh.header ->> 'driver' end);
    else
      if sh.status <> 'passed' then raise exception 'the car must pass tech first'; end if;
      select coalesce(jsonb_agg(jsonb_build_object('sha256', x ->> 'sha256', 'kind', 'car')), '[]'::jsonb) into photos
      from jsonb_array_elements(coalesce(sh.competitor -> 'pictures' -> 'car', '[]'::jsonb)) x
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

  insert into public.stickers (code, kind, logbook_id, tech_sheet_id, event_id, body_id, item_key, snapshot, issued_by, accreditation_id)
  values (public.new_sticker_code(), k, lb.id, sh.id, ev.id, body, case when k = 'gear' then key end, snap,
          public.current_email(), acc.id)
  returning * into s;
  insert into public.sticker_photos (code, sha256, kind)
  select s.code, x ->> 'sha256', x ->> 'kind' from jsonb_array_elements(coalesce(snap -> 'photos', '[]'::jsonb)) x
  on conflict do nothing;

  update public.stickers set voided_at = now(), voided_by = public.current_email(), void_reason = 'replaced', replaced_by = s.code
  where code <> s.code and voided_at is null and (
    (k = 'gear' and kind = 'gear' and tech_sheet_id = sh.id and item_key = key)
    or (k = 'car' and kind = 'car' and tech_sheet_id = sh.id)
    or (k = 'logbook' and kind = 'logbook' and logbook_id = lb.id and coalesce((p ->> 'replace')::boolean, false)));
  return public.sticker_json(s);
end $$;

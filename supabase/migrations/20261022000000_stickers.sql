-- Tech stickers: printable QR codes a scrutineer issues.
--   logbook -- on the cage or logbook cover: opens the car's digital logbook
--              (its public view, by the owner's privacy settings).
--   gear    -- on a helmet, HANS or seat that passed on a tech sheet with a photo
--              of the item and one of its tag: shows those photos and the
--              certifications read off the tag (standard, homologation, serial,
--              dates), who inspected it and when. The sticker has no expiry of
--              its own: whoever scans it checks those certifications against
--              their own body's rules (PassTech scrutineer mode does it for them).
--   car     -- for a car that passed tech at an event: that tech sheet's
--              results (harnesses, suits, gloves... can't carry a sticker).
-- The QR code holds <site>?s=<code>, never the data itself: a code keeps
-- working when a logbook's public link changes, and a sticker can be voided
-- (re-issued, failed later, a photocopy spotted). Scanning it is public; the
-- driver's name only shows to a signed-in scrutineer.

create table stickers (
  code text primary key check (code ~ '^[2-9A-HJ-NP-Z]{8}$'),
  kind text not null check (kind in ('logbook', 'gear', 'car')),
  logbook_id uuid references logbooks(id),
  tech_sheet_id uuid references tech_sheets(id),
  event_id uuid references events(id),
  body_id text references bodies(id),
  -- gear: the tech sheet line ("helmet.driver").
  item_key text,
  -- What the sticker vouches for, as it was when issued (see issue_sticker).
  snapshot jsonb not null default '{}'::jsonb,
  issued_by text not null,
  accreditation_id uuid references accreditations(id),
  issued_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by text,
  void_reason text,
  replaced_by text references stickers(code)
);
create index stickers_sheet on stickers (tech_sheet_id);
create index stickers_logbook on stickers (logbook_id);
create index stickers_event on stickers (event_id);
alter table stickers enable row level security;
revoke all on stickers from anon, authenticated;

-- The tech sheet photos a sticker shows: readable by anyone while it's valid.
create table sticker_photos (
  code text not null references stickers(code),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('item', 'tag', 'car')),
  primary key (code, sha256)
);
create index sticker_photos_sha on sticker_photos (sha256);
alter table sticker_photos enable row level security;
revoke all on sticker_photos from anon, authenticated;

-- The gear categories a sticker can go on.
create or replace function sticker_gear(cat text) returns boolean
language sql immutable
set search_path = ''
as $$ select cat in ('helmet', 'hnr', 'seat') $$;

-- 8 characters, no 0/O, 1/I/L, U: printed as XXXX-XXXX under the code.
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
    exit when not exists (select 1 from public.stickers where code = candidate);
  end loop;
  return candidate;
end $$;

create or replace function sticker_code(p text) returns text
language sql immutable
set search_path = ''
as $$ select upper(regexp_replace(coalesce(p, ''), '[^0-9A-Za-z]', '', 'g')) $$;

create or replace function sticker_photo_public(p_name text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.sticker_photos sp join public.stickers s on s.code = sp.code
                 where sp.sha256 = p_name and s.voided_at is null)
$$;

create policy tech_sheet_photos_sticker_read on storage.objects for select to anon, authenticated
  using (bucket_id = 'tech-sheet-photos' and public.sticker_photo_public(name));

-- A sticker for the people who issue and print them (staff view: names included).
create or replace function sticker_json(s public.stickers) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object('code', s.code, 'kind', s.kind, 'logbook', s.logbook_id, 'techSheet', s.tech_sheet_id,
    'event', s.event_id, 'body', s.body_id, 'bodyName', (select b.name from public.bodies b where b.id = s.body_id),
    'eventName', (select e.name from public.events e where e.id = s.event_id),
    'item', s.item_key, 'snapshot', s.snapshot, 'issuedBy', s.issued_by, 'issuedAt', s.issued_at,
    'voidedAt', s.voided_at, 'voidReason', s.void_reason, 'replacedBy', s.replaced_by)
$$;

-- Issues a sticker: p = { kind, logbook } | { kind: "gear", techSheet, item, label } | { kind: "car", techSheet }.
-- A new gear or car sticker for the same line or sheet voids the earlier one
-- (replaced); logbook stickers add up (cage and cover), unless p.replace.
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
      where x ->> 'sha256' ~ '^[0-9a-f]{64}$';
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

-- Voids a sticker: its body's scrutineers, whoever issued it, or an admin.
create or replace function void_sticker(p_code text, p_reason text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  s public.stickers;
begin
  select * into s from public.stickers where code = public.sticker_code(p_code);
  if s.code is null then raise exception 'no such sticker'; end if;
  if not (public.is_admin() or s.issued_by = public.current_email() or (public.my_accreditation(s.body_id)).id is not null) then
    raise exception 'only its body''s scrutineers void a sticker';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'say why it''s void'; end if;
  update public.stickers set voided_at = coalesce(voided_at, now()), voided_by = coalesce(voided_by, public.current_email()),
    void_reason = coalesce(void_reason, trim(p_reason))
  where code = s.code returning * into s;
  return public.sticker_json(s);
end $$;

-- The stickers of a tech sheet, a logbook or an event (p = { techSheet } | { logbook } | { event }), for staff to print.
create or replace function list_stickers(p jsonb) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.sticker_json(s) order by s.issued_at), '[]'::jsonb)
  from public.stickers s
  where (public.is_admin() or public.is_scrutineer())
    and ((p ? 'techSheet' and s.tech_sheet_id = (p ->> 'techSheet')::uuid)
      or (p ? 'logbook' and s.logbook_id = (p ->> 'logbook')::uuid)
      or (p ? 'event' and s.event_id = (p ->> 'event')::uuid))
$$;

-- What a scanned sticker shows (anyone). Names (driver, owner) only to scrutineers.
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
  res := jsonb_build_object('code', s.code, 'kind', s.kind, 'status', case when s.voided_at is null then 'valid' else 'void' end,
    'voidedAt', s.voided_at, 'voidReason', s.void_reason, 'replacedBy', s.replaced_by,
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

revoke execute on function sticker_gear, new_sticker_code, sticker_code, sticker_photo_public, sticker_json,
  issue_sticker, void_sticker, list_stickers, sticker_view from public, anon, authenticated;
grant execute on function sticker_photo_public, sticker_view, sticker_code to anon, authenticated;
grant execute on function issue_sticker, void_sticker, list_stickers to authenticated;

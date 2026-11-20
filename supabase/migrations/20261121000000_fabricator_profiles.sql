-- Fabricators list themselves: their own listing (fabricator_profiles), with every sanctioning
-- body and discipline they build cages for -- picked from PassTech's (passtech-bodies.json) -- and
-- it's in the directory right away. A sanctioning body's approval (fabricators, from
-- 20261119000000_fabricators_directory.sql) becomes an extra: "Certified by ..." on the listing.
--  - fabricator_profiles.builds_for: [{ id, body, bodyName, discipline }] as picked (PassTech's
--    ruleset ids and names, kept as they were when saved).
--  - Design reviews go to a fabricator's listing (design_requests.fabricator_profile_id).
--  - (Ratings of fabricators and scrutineers may come later: they'd hang off a listing's id.)

create table if not exists fabricator_profiles (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email)),
  business text not null check (length(trim(business)) > 0),
  contact_name text,
  city text not null,
  region text not null,
  country text,
  website text,
  phone text,
  about text,
  builds_for jsonb not null default '[]'::jsonb,
  listed boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table fabricator_profiles enable row level security;
revoke all on fabricator_profiles from anon, authenticated;

-- Those who applied before: a listing from their latest application (nothing picked yet).
insert into fabricator_profiles (email, business, contact_name, city, region, country, website, phone, about)
select distinct on (f.email) f.email, f.business, f.contact_name, coalesce(f.city, ''), coalesce(f.region, ''), f.country, f.website, f.phone, f.note
from fabricators f where f.status in ('pending', 'approved')
order by f.email, f.applied_at desc
on conflict (email) do nothing;

alter table design_requests add column if not exists fabricator_profile_id uuid references fabricator_profiles(id);

create or replace function fabricator_profile_json(p public.fabricator_profiles, p_full boolean) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object('id', p.id, 'business', p.business, 'contactName', p.contact_name, 'city', p.city, 'region', p.region,
    'country', p.country, 'website', p.website, 'phone', p.phone, 'about', p.about, 'buildsFor', p.builds_for,
    -- Approved by a sanctioning body (on the Scrutineering site).
    'certifications', (select coalesce(jsonb_agg(jsonb_build_object('body', f.body_id, 'bodyName', b.name, 'discipline', f.discipline,
        'disciplineName', public.discipline_name(f.body_id, f.discipline)) order by b.name), '[]'::jsonb)
      from public.fabricators f join public.bodies b on b.id = f.body_id and b.disabled_at is null and b.deleted_at is null
      where f.email = p.email and f.status = 'approved'))
    || case when p_full then jsonb_build_object('listed', p.listed, 'updatedAt', p.updated_at) else '{}'::jsonb end
$$;

create or replace function my_fabricator_profile() returns jsonb
language sql stable security definer
set search_path = ''
as $$ select public.fabricator_profile_json(p, true) from public.fabricator_profiles p where p.email = public.current_email() $$;

-- p = { business, contactName?, city, region, country?, website?, phone?, about?, buildsFor: [{ id, body,
-- bodyName, discipline }], listed } -- also updates the details on the caller's certification applications.
create or replace function save_fabricator_profile(p jsonb) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  me text := public.current_email();
  builds jsonb;
  t text := nullif(trim(coalesce(p ->> 'business', '')), '');
begin
  if me is null or me = '' then raise exception 'sign in first'; end if;
  if t is null then raise exception 'the business name is required'; end if;
  if nullif(trim(coalesce(p ->> 'city', '')), '') is null or nullif(trim(coalesce(p ->> 'region', '')), '') is null then
    raise exception 'the city and state/province are required: they''re how people find you';
  end if;
  -- Only what a pick holds, each well-formed.
  select coalesce(jsonb_agg(jsonb_build_object('id', x ->> 'id', 'body', x ->> 'body', 'bodyName', left(x ->> 'bodyName', 120), 'discipline', left(x ->> 'discipline', 120))), '[]'::jsonb)
  into builds from jsonb_array_elements(coalesce(p -> 'buildsFor', '[]'::jsonb)) x
  where (x ->> 'id') ~ '^[a-z0-9-]{1,80}$';
  if jsonb_array_length(builds) = 0 then raise exception 'pick at least one sanctioning body you build cages for'; end if;
  insert into public.fabricator_profiles (email, business, contact_name, city, region, country, website, phone, about, builds_for, listed, updated_at)
  values (me, t, nullif(trim(coalesce(p ->> 'contactName', '')), ''), trim(p ->> 'city'), trim(p ->> 'region'),
    nullif(trim(coalesce(p ->> 'country', '')), ''), nullif(trim(coalesce(p ->> 'website', '')), ''), nullif(trim(coalesce(p ->> 'phone', '')), ''),
    nullif(trim(coalesce(p ->> 'about', '')), ''), builds, coalesce((p ->> 'listed')::boolean, true), now())
  on conflict (email) do update set business = excluded.business, contact_name = excluded.contact_name, city = excluded.city,
    region = excluded.region, country = excluded.country, website = excluded.website, phone = excluded.phone, about = excluded.about,
    builds_for = excluded.builds_for, listed = excluded.listed, updated_at = now();
  update public.fabricators set business = t, contact_name = nullif(trim(coalesce(p ->> 'contactName', '')), ''),
    city = trim(p ->> 'city'), region = trim(p ->> 'region'), country = nullif(trim(coalesce(p ->> 'country', '')), ''),
    website = nullif(trim(coalesce(p ->> 'website', '')), ''), phone = nullif(trim(coalesce(p ->> 'phone', '')), '')
  where email = me and status in ('pending', 'approved');
  return public.fabricator_profile_json((select x from public.fabricator_profiles x where x.email = me), true);
end $$;

-- Applying for a sanctioning body's certification takes a listing first (its details are copied).
create or replace function apply_fabricator(p jsonb) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  me text := public.current_email();
  prof public.fabricator_profiles;
  t jsonb;
  body text;
  disc text;
  ids jsonb := '[]'::jsonb;
  new_id uuid;
begin
  if me is null or me = '' then raise exception 'sign in to apply'; end if;
  select * into prof from public.fabricator_profiles x where x.email = me;
  if prof.id is null then raise exception 'save your fabricator listing first'; end if;
  if jsonb_array_length(coalesce(p -> 'targets', '[]'::jsonb)) = 0 then raise exception 'pick at least one sanctioning body'; end if;
  for t in select * from jsonb_array_elements(p -> 'targets') loop
    body := t ->> 'body';
    disc := nullif(t ->> 'discipline', '');
    if not exists (select 1 from public.bodies b where b.id = body and b.disabled_at is null and b.deleted_at is null) then
      raise exception 'no such sanctioning body';
    end if;
    if disc is not null and not exists (select 1 from public.body_disciplines d where d.body_id = body and d.id = disc and d.archived_at is null) then
      raise exception 'no such discipline';
    end if;
    if exists (select 1 from public.fabricators f where f.email = me and f.body_id = body and f.discipline is not distinct from disc
               and f.status in ('pending', 'approved')) then
      raise exception 'you already applied to % (or are certified there)', concat_ws(' ', (select b.name from public.bodies b where b.id = body), public.discipline_name(body, disc));
    end if;
    insert into public.fabricators (body_id, discipline, email, business, contact_name, city, region, country, website, phone, note)
    values (body, disc, me, prof.business, prof.contact_name, prof.city, prof.region, prof.country, prof.website, prof.phone,
      nullif(trim(coalesce(p ->> 'note', '')), ''))
    returning id into new_id;
    ids := ids || to_jsonb(new_id);
  end loop;
  return ids;
end $$;

-- The public fabricator directory: every listed fabricator, with what they build for and who certified them.
create or replace function fabricator_directory(p_body text default null, p_discipline text default null) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.fabricator_profile_json(p, false) order by p.region, p.city, p.business), '[]'::jsonb)
  from public.fabricator_profiles p where p.listed
$$;

-- As before (20261120000000_design_reviews.sql); fabricatorId is now a fabricator's listing.
create or replace function submit_design_request(p jsonb) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  me text := public.current_email();
  did uuid := (p ->> 'designId')::uuid;
  k text := p ->> 'kind';
  f public.fabricator_profiles;
  a public.accreditations;
  seq int;
  rid uuid;
begin
  if public.design_role(did) is distinct from 'owner' then raise exception 'only the design''s owner sends it'; end if;
  if k not in ('review', 'logbook') then raise exception 'a review or a logbook'; end if;
  if exists (select 1 from public.design_requests r where r.design_id = did and r.status = 'open') then
    raise exception 'it''s already sent: withdraw that request first';
  end if;
  select max(v.seq) into seq from public.design_versions v where v.design_id = did;
  if seq is null then raise exception 'the design has no version yet'; end if;
  if nullif(p ->> 'fabricatorId', '') is not null then
    if k = 'logbook' then raise exception 'only a scrutineer issues logbooks'; end if;
    select * into f from public.fabricator_profiles x where x.id = (p ->> 'fabricatorId')::uuid and x.listed;
    if f.id is null then raise exception 'that fabricator isn''t listed (any more)'; end if;
    if f.email = me then raise exception 'that''s you'; end if;
    insert into public.design_requests (design_id, kind, reviewer_email, reviewer_name, reviewer_kind, fabricator_profile_id, message, version_seq)
    values (did, k, f.email, f.business, 'fabricator', f.id, nullif(trim(coalesce(p ->> 'message', '')), ''), seq)
    returning id into rid;
  else
    select * into a from public.accreditations x where x.id = (p ->> 'accreditationId')::uuid;
    if a.id is null or not public.accreditation_active(a)
       or not exists (select 1 from public.staff_profiles s where s.email = a.email and s.listed) then
      raise exception 'that scrutineer isn''t listed (any more)';
    end if;
    if k = 'logbook' and not ('issue_logbooks' = any (public.accreditation_permissions(a))) then
      raise exception '% doesn''t issue logbooks', a.name;
    end if;
    if a.email = me then raise exception 'that''s you'; end if;
    insert into public.design_requests (design_id, kind, reviewer_email, reviewer_name, reviewer_kind, accreditation_id, body_id, discipline, message, version_seq, keep_history)
    values (did, k, a.email, a.name, 'scrutineer', a.id, a.body_id, a.discipline, nullif(trim(coalesce(p ->> 'message', '')), ''), seq,
      k = 'logbook' and coalesce((p ->> 'keepHistory')::boolean, false))
    returning id into rid;
  end if;
  update public.designs set updated_at = now() where id = did;
  return rid;
end $$;

-- A fabricator's name on the versions they save: their listing's business.
create or replace function my_display_name() returns text
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
    (select a.name from public.accreditations a where a.email = public.current_email() and a.deleted_at is null order by a.granted_at desc limit 1),
    (select p.business from public.fabricator_profiles p where p.email = public.current_email()))
$$;

revoke execute on function fabricator_profile_json, my_display_name from public, anon, authenticated;
revoke execute on function my_fabricator_profile, save_fabricator_profile, apply_fabricator, submit_design_request from public, anon;
grant execute on function my_fabricator_profile, save_fabricator_profile, apply_fabricator, submit_design_request to authenticated;
grant execute on function fabricator_directory to anon, authenticated;

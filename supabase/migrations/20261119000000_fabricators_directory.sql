-- Approved fabricators and a public directory of fabricators and scrutineers, with their location
-- (city and state/province), so someone building a roll cage can find one near them.
--  - fabricators: a roll cage fabricator's application to be approved by a sanctioning body, for
--    one of its disciplines (null: all of them, or a body without disciplines). Fabricators apply
--    themselves (signed in with their email); the body's technical directors -- or whoever may add
--    scrutineers in that discipline -- approve or decline it, and can remove one later. Only
--    approved ones are listed. (Design reviews come later: fabricators sign nothing.)
--  - staff_profiles: a scrutineer's own location, and whether they're listed in the public
--    scrutineer directory (off until they turn it on). Set by the person themselves.
--  - fabricator_directory() / scrutineer_directory(): what anyone sees, signed in or not. No
--    email addresses: the business's website / phone for a fabricator; a scrutineer's name, city
--    and what they do.

create table if not exists fabricators (
  id uuid primary key default gen_random_uuid(),
  body_id text not null references bodies(id),
  discipline text,
  email text not null check (email = lower(email)),
  business text not null check (length(trim(business)) > 0),
  contact_name text,
  city text,
  region text,
  country text,
  website text,
  phone text,
  -- What the applicant tells the body (experience, certifications...).
  note text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'withdrawn', 'removed')),
  applied_at timestamptz not null default now(),
  handled_by text,
  handled_at timestamptz,
  -- Why it was declined or removed (the applicant sees it).
  decision_note text,
  foreign key (body_id, discipline) references body_disciplines (body_id, id)
);
-- One live application or listing per business email, body and discipline.
create unique index if not exists fabricators_one_live on fabricators (email, body_id, coalesce(discipline, ''))
  where status in ('pending', 'approved');
alter table fabricators enable row level security;
revoke all on fabricators from anon, authenticated;

create table if not exists staff_profiles (
  email text primary key check (email = lower(email)),
  city text,
  region text,
  country text,
  -- Shown in the public scrutineer directory.
  listed boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table staff_profiles enable row level security;
revoke all on staff_profiles from anon, authenticated;

create or replace function fabricator_json(f public.fabricators, p_full boolean) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object('id', f.id, 'body', f.body_id, 'bodyName', (select b.name from public.bodies b where b.id = f.body_id),
    'discipline', f.discipline, 'disciplineName', public.discipline_name(f.body_id, f.discipline),
    'business', f.business, 'contactName', f.contact_name, 'city', f.city, 'region', f.region, 'country', f.country,
    'website', f.website, 'phone', f.phone)
    || case when p_full then jsonb_build_object('email', f.email, 'note', f.note, 'status', f.status, 'appliedAt', f.applied_at,
         'handledBy', f.handled_by, 'handledAt', f.handled_at, 'decisionNote', f.decision_note) else '{}'::jsonb end
$$;

-- Applying: p = { business, contactName?, city, region, country?, website?, phone?, note?,
-- targets: [{ body, discipline? }] } -> the new applications' ids.
create or replace function apply_fabricator(p jsonb) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  me text := public.current_email();
  t jsonb;
  body text;
  disc text;
  ids jsonb := '[]'::jsonb;
  new_id uuid;
begin
  if me is null or me = '' then raise exception 'sign in to apply'; end if;
  if nullif(trim(coalesce(p ->> 'business', '')), '') is null then raise exception 'the business name is required'; end if;
  if nullif(trim(coalesce(p ->> 'city', '')), '') is null or nullif(trim(coalesce(p ->> 'region', '')), '') is null then
    raise exception 'the city and state/province are required: they''re how people find you';
  end if;
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
      raise exception 'you already applied to % (or are approved there)', concat_ws(' ', (select b.name from public.bodies b where b.id = body), public.discipline_name(body, disc));
    end if;
    insert into public.fabricators (body_id, discipline, email, business, contact_name, city, region, country, website, phone, note)
    values (body, disc, me, trim(p ->> 'business'), nullif(trim(coalesce(p ->> 'contactName', '')), ''),
      trim(p ->> 'city'), trim(p ->> 'region'), nullif(trim(coalesce(p ->> 'country', '')), ''),
      nullif(trim(coalesce(p ->> 'website', '')), ''), nullif(trim(coalesce(p ->> 'phone', '')), ''), nullif(trim(coalesce(p ->> 'note', '')), ''))
    returning id into new_id;
    ids := ids || to_jsonb(new_id);
  end loop;
  return ids;
end $$;

-- The caller's own applications and listings, newest first.
create or replace function my_fabricator_applications() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.fabricator_json(f, true) order by f.applied_at desc), '[]'::jsonb)
  from public.fabricators f where f.email = public.current_email()
$$;

-- The applicant updates their listing's details (business, contact, location, website, phone) on
-- all their applications and listings at once.
create or replace function update_my_fabricator(p jsonb) returns void
language plpgsql security definer
set search_path = ''
as $$
declare me text := public.current_email();
begin
  if me is null or me = '' then raise exception 'not signed in'; end if;
  if nullif(trim(coalesce(p ->> 'business', '')), '') is null then raise exception 'the business name is required'; end if;
  if nullif(trim(coalesce(p ->> 'city', '')), '') is null or nullif(trim(coalesce(p ->> 'region', '')), '') is null then
    raise exception 'the city and state/province are required';
  end if;
  update public.fabricators set business = trim(p ->> 'business'), contact_name = nullif(trim(coalesce(p ->> 'contactName', '')), ''),
    city = trim(p ->> 'city'), region = trim(p ->> 'region'), country = nullif(trim(coalesce(p ->> 'country', '')), ''),
    website = nullif(trim(coalesce(p ->> 'website', '')), ''), phone = nullif(trim(coalesce(p ->> 'phone', '')), '')
  where email = me and status in ('pending', 'approved');
end $$;

-- Withdrawing one's own application, or leaving a body's list.
create or replace function withdraw_fabricator(p_id uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.fabricators set status = 'withdrawn', handled_by = public.current_email(), handled_at = now()
  where id = p_id and email = public.current_email() and status in ('pending', 'approved');
  if not found then raise exception 'nothing to withdraw'; end if;
end $$;

-- Who manages a body's fabricators in a discipline: System admins, and whoever may add scrutineers
-- there (the technical directors hold it).
create or replace function can_manage_fabricators(p_body text, p_discipline text) returns boolean
language sql stable security definer
set search_path = ''
as $$ select public.is_admin() or public.has_permission_in(p_body, p_discipline, 'add_scrutineers') $$;

-- A body's fabricators (every status) in the disciplines the caller manages.
create or replace function body_fabricators(p_body text) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.fabricator_json(f, true) order by f.status <> 'pending', f.business), '[]'::jsonb)
  from public.fabricators f where f.body_id = p_body and public.can_manage_fabricators(f.body_id, f.discipline)
$$;

-- Approving, declining (a pending application) or removing (an approved one), saying why.
create or replace function decide_fabricator(p_id uuid, p_status text, p_note text default null) returns void
language plpgsql security definer
set search_path = ''
as $$
declare f public.fabricators;
begin
  select * into f from public.fabricators where id = p_id;
  if f.id is null then raise exception 'no such fabricator'; end if;
  if not public.can_manage_fabricators(f.body_id, f.discipline) then
    raise exception 'only the body''s technical directors (and whoever may add scrutineers) approve fabricators';
  end if;
  if not ((p_status in ('approved', 'declined') and f.status = 'pending') or (p_status = 'removed' and f.status = 'approved')) then
    raise exception 'can''t % a fabricator that is %', p_status, f.status;
  end if;
  if p_status in ('declined', 'removed') and nullif(trim(coalesce(p_note, '')), '') is null then raise exception 'say why'; end if;
  update public.fabricators set status = p_status, handled_by = public.current_email(), handled_at = now(),
    decision_note = nullif(trim(coalesce(p_note, '')), '')
  where id = p_id;
end $$;

-- The public fabricator directory: approved fabricators, by body and discipline (null: all).
create or replace function fabricator_directory(p_body text default null, p_discipline text default null) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.fabricator_json(f, false) order by f.region, f.city, f.business), '[]'::jsonb)
  from public.fabricators f join public.bodies b on b.id = f.body_id
  where f.status = 'approved' and b.disabled_at is null and b.deleted_at is null
    and (p_body is null or f.body_id = p_body)
    and (p_discipline is null or f.discipline is null or f.discipline = p_discipline)
$$;

-- The caller's own directory profile (location, listed), or null.
create or replace function my_staff_profile() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object('city', p.city, 'region', p.region, 'country', p.country, 'listed', p.listed)
  from public.staff_profiles p where p.email = public.current_email()
$$;

-- p = { city, region, country?, listed }: accredited scrutineers and technical directors only.
create or replace function save_staff_profile(p jsonb) returns void
language plpgsql security definer
set search_path = ''
as $$
declare me text := public.current_email();
begin
  if not exists (select 1 from public.accreditations a where a.email = me and public.accreditation_active(a)) then
    raise exception 'only accredited scrutineers have a directory listing';
  end if;
  if coalesce((p ->> 'listed')::boolean, false) and (nullif(trim(coalesce(p ->> 'city', '')), '') is null or nullif(trim(coalesce(p ->> 'region', '')), '') is null) then
    raise exception 'to be listed, give your city and state/province';
  end if;
  insert into public.staff_profiles (email, city, region, country, listed, updated_at)
  values (me, nullif(trim(coalesce(p ->> 'city', '')), ''), nullif(trim(coalesce(p ->> 'region', '')), ''),
    nullif(trim(coalesce(p ->> 'country', '')), ''), coalesce((p ->> 'listed')::boolean, false), now())
  on conflict (email) do update set city = excluded.city, region = excluded.region, country = excluded.country,
    listed = excluded.listed, updated_at = now();
end $$;

-- The public scrutineer directory: listed people with an active accreditation, one entry per
-- accreditation (body / discipline), with whether they may issue logbooks there.
-- p_logbooks: only those who may issue logbooks.
create or replace function scrutineer_directory(p_body text default null, p_discipline text default null, p_logbooks boolean default false) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', a.name, 'body', a.body_id, 'bodyName', b.name,
      'discipline', a.discipline, 'disciplineName', public.discipline_name(a.body_id, a.discipline),
      'role', a.role, 'city', p.city, 'region', p.region, 'country', p.country,
      'issuesLogbooks', 'issue_logbooks' = any (public.accreditation_permissions(a)))
    order by p.region, p.city, a.name), '[]'::jsonb)
  from public.accreditations a
  join public.staff_profiles p on p.email = a.email and p.listed
  join public.bodies b on b.id = a.body_id and b.disabled_at is null and b.deleted_at is null
  where public.accreditation_active(a)
    and (p_body is null or a.body_id = p_body)
    and (p_discipline is null or a.discipline is null or a.discipline = p_discipline)
    and (not coalesce(p_logbooks, false) or 'issue_logbooks' = any (public.accreditation_permissions(a)))
$$;

revoke execute on function fabricator_json, can_manage_fabricators from public, anon, authenticated;
revoke execute on function apply_fabricator, my_fabricator_applications, update_my_fabricator, withdraw_fabricator,
  body_fabricators, decide_fabricator, my_staff_profile, save_staff_profile from public, anon;
grant execute on function apply_fabricator, my_fabricator_applications, update_my_fabricator, withdraw_fabricator,
  body_fabricators, decide_fabricator, my_staff_profile, save_staff_profile to authenticated;
grant execute on function fabricator_directory, scrutineer_directory to anon, authenticated;

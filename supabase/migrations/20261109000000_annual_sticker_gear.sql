-- Which gear a sanctioning body gives annual (season) stickers for, per discipline: none, just
-- helmets, helmets and HANS... Competitors can only apply from PassTech for what's accepted.
--  - bodies.annual_sticker_gear: for a body without disciplines.
--  - body_disciplines.annual_sticker_gear: for each discipline of a body that has them.
--  - null (not set) or empty: no annual stickers there. Bodies and disciplines that already had
--    annual stickers or applications keep every kind of gear until their technical director
--    narrows it.
--  - Set by System admins, the body's all-disciplines technical directors, and (for a
--    discipline) that discipline's technical directors.

alter table bodies add column if not exists annual_sticker_gear text[];
alter table body_disciplines add column if not exists annual_sticker_gear text[];

-- Who already uses annual stickers: every kind of gear, as before.
update bodies b set annual_sticker_gear = array['helmet', 'hnr', 'seat', 'fire_extinguisher', 'fire_suppression']
where b.annual_sticker_gear is null and (
  exists (select 1 from sticker_applications a where a.body_id = b.id and a.discipline is null)
  or exists (select 1 from stickers s where s.body_id = b.id and s.kind = 'gear' and s.event_id is null and s.discipline is null));
update body_disciplines d set annual_sticker_gear = array['helmet', 'hnr', 'seat', 'fire_extinguisher', 'fire_suppression']
where d.annual_sticker_gear is null and (
  exists (select 1 from sticker_applications a where a.body_id = d.body_id and a.discipline = d.id)
  or exists (select 1 from stickers s where s.body_id = d.body_id and s.kind = 'gear' and s.event_id is null and s.discipline = d.id));

-- The gear a body (p_discipline null) or one of its disciplines gives annual stickers for.
create or replace function annual_sticker_gear(p_body text, p_discipline text) returns text[]
language sql stable security definer
set search_path = ''
as $$
  select coalesce(case when p_discipline is null
    then (select b.annual_sticker_gear from public.bodies b where b.id = p_body)
    else (select d.annual_sticker_gear from public.body_disciplines d where d.body_id = p_body and d.id = p_discipline) end, '{}'::text[])
$$;

create or replace function save_annual_sticker_gear(p_body text, p_discipline text, p_gear text[]) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  disc text := nullif(trim(coalesce(p_discipline, '')), '');
  gear text[];
begin
  if not (public.is_admin() or exists (
    select 1 from public.accreditations a where a.email = public.current_email() and a.body_id = p_body
      and a.role = 'technical_director' and public.accreditation_active(a) and (a.discipline is null or a.discipline = disc))) then
    raise exception 'only Frog Racing and the body''s technical directors choose its annual stickers';
  end if;
  select coalesce(array_agg(distinct g order by g), '{}'::text[]) into gear from unnest(coalesce(p_gear, '{}'::text[])) g;
  if exists (select 1 from unnest(gear) g where not public.sticker_gear(g)) then
    raise exception 'stickers go on helmets, HANS devices, seats, fire extinguishers and fire suppression systems';
  end if;
  if disc is null then
    update public.bodies set annual_sticker_gear = gear where id = p_body;
  else
    update public.body_disciplines set annual_sticker_gear = gear where body_id = p_body and id = disc;
    if not found then raise exception 'no such discipline'; end if;
  end if;
end $$;

-- The bodies (and disciplines) a competitor can apply to, with the gear each accepts.
create or replace function sticker_bodies() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'gear', to_jsonb(coalesce(b.annual_sticker_gear, '{}'::text[])),
    'disciplines', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'gear', to_jsonb(coalesce(d.annual_sticker_gear, '{}'::text[])))
                      order by d.position, d.name), '[]'::jsonb)
                    from public.body_disciplines d where d.body_id = b.id and d.archived_at is null)) order by b.name), '[]'::jsonb)
  from public.bodies b where b.disabled_at is null and b.deleted_at is null
$$;

-- As before (20261026000000_disciplines.sql), and only for the gear the body or discipline accepts.
create or replace function submit_sticker_application(p jsonb) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  me text := public.current_email();
  body text := nullif(p ->> 'body', '');
  disc text := nullif(p ->> 'discipline', '');
  photos jsonb := public.sticker_photo_list(p -> 'photos');
  cat text := coalesce(p ->> 'category', p -> 'gear' ->> 'category');
  yr int := coalesce(nullif(p ->> 'season', '')::int, extract(year from now())::int);
  new_gear jsonb := (p -> 'gear') - 'photoDataUrls' - 'stickerCode';
  new_id uuid;
begin
  if me is null then raise exception 'sign in to apply for a sticker'; end if;
  if body is null or not exists (select 1 from public.bodies b where b.id = body and b.disabled_at is null and b.deleted_at is null) then
    raise exception 'pick the sanctioning body';
  end if;
  if disc is null and exists (select 1 from public.body_disciplines d where d.body_id = body and d.archived_at is null) then
    raise exception 'pick the discipline';
  end if;
  if disc is not null and not exists (select 1 from public.body_disciplines d where d.body_id = body and d.id = disc and d.archived_at is null) then
    raise exception 'no such discipline';
  end if;
  if not public.sticker_gear(cat) then raise exception 'stickers go on helmets, HANS devices, seats, fire extinguishers and fire suppression systems'; end if;
  if not (cat = any (public.annual_sticker_gear(body, disc))) then
    raise exception 'this sanctioning body doesn''t give annual stickers for that gear%', case when disc is null then '' else ' in that discipline' end;
  end if;
  if jsonb_typeof(p -> 'gear') <> 'object' then raise exception 'the gear''s details are missing'; end if;
  if not public.sticker_photos_ok(photos) then raise exception 'add a photo of the whole item and one of its tag or label'; end if;
  if exists (
    select 1 from public.sticker_applications a
    where a.submitted_by = me and a.status = 'pending' and a.body_id = body and a.discipline is not distinct from disc
      and a.season = yr and a.category = cat
      and (a.gear = new_gear or exists (
        select 1 from jsonb_array_elements(coalesce(a.gear -> 'certifications', '[]'::jsonb)) x,
                      jsonb_array_elements(coalesce(new_gear -> 'certifications', '[]'::jsonb)) y
        where coalesce(x ->> 'serialNumber', '') <> '' and x ->> 'serialNumber' = y ->> 'serialNumber'))) then
    raise exception 'this item already has a pending application for that body, discipline and season: wait until it''s processed, or withdraw it to send a new one';
  end if;
  insert into public.sticker_applications (body_id, discipline, season, category, owner_name, gear, photos, submitted_by)
  values (body, disc, yr, cat, nullif(trim(p ->> 'owner'), ''), new_gear, photos, me)
  returning sticker_applications.id into new_id;
  return new_id;
end $$;

-- New functions: callable only as intended.
revoke execute on function annual_sticker_gear, save_annual_sticker_gear from public, anon, authenticated;
grant execute on function save_annual_sticker_gear to authenticated;

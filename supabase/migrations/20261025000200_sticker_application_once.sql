-- One pending application per item: a competitor can't apply again for the same item (same gear
-- details, or a certification serial number in common) with the same body for the same season
-- until the pending one is issued, declined or withdrawn. Another item of the same kind (the
-- co-driver's helmet) can still apply.
create or replace function submit_sticker_application(p jsonb) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  me text := public.current_email();
  body text := nullif(p ->> 'body', '');
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
  if not public.sticker_gear(cat) then raise exception 'stickers go on helmets, HANS devices, seats, fire extinguishers and fire suppression systems'; end if;
  if jsonb_typeof(p -> 'gear') <> 'object' then raise exception 'the gear''s details are missing'; end if;
  if not public.sticker_photos_ok(photos) then raise exception 'add a photo of the whole item and one of its tag or label'; end if;
  if exists (
    select 1 from public.sticker_applications a
    where a.submitted_by = me and a.status = 'pending' and a.body_id = body and a.season = yr and a.category = cat
      and (a.gear = new_gear or exists (
        select 1 from jsonb_array_elements(coalesce(a.gear -> 'certifications', '[]'::jsonb)) x,
                      jsonb_array_elements(coalesce(new_gear -> 'certifications', '[]'::jsonb)) y
        where coalesce(x ->> 'serialNumber', '') <> '' and x ->> 'serialNumber' = y ->> 'serialNumber'))) then
    raise exception 'this item already has a pending application for that body and season: wait until it''s processed, or withdraw it to send a new one';
  end if;
  insert into public.sticker_applications (body_id, season, category, owner_name, gear, photos, submitted_by)
  values (body, yr, cat, nullif(trim(p ->> 'owner'), ''), new_gear, photos, me)
  returning sticker_applications.id into new_id;
  return new_id;
end $$;

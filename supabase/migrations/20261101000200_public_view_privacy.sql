-- Digital logbooks -- finer privacy for a car's public view (its link and QR sticker).
-- privacy (logbooks.privacy) now holds:
--   owner           boolean  the owner's name and email            (default false)
--   vin             'full' | 'partial' | 'hidden'                  (default 'hidden')
--   builder         boolean  the cage's builder                    (default true)
--   tubing          boolean  the primary and secondary tubing specs (default true)
--   model_3d        boolean  the cage's 3D model                   (default true)
--   vehicle_photos  boolean  the 3/4 front and rear vehicle photos (default true)
--   cage_photos     'all' | 'some' | 'none': the rollcage pictures (default 'all';
--                   the old true / false read as 'all' / 'none')
--   cage_photo_list the SHA-256s of the rollcage pictures shown, for 'some'
-- The VIN is now hidden unless the owner shows it: logbooks still on the old
-- default privacy hide it too. Owners can no longer make a new public link
-- (reset_public_link): links already shared would stop working.

create or replace function privacy_norm(pv jsonb) returns jsonb
language sql immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'owner', coalesce((pv ->> 'owner')::boolean, false),
    'vin', case when pv ->> 'vin' in ('full', 'partial', 'hidden') then pv ->> 'vin' else 'hidden' end,
    'builder', coalesce((pv ->> 'builder')::boolean, true),
    'tubing', coalesce((pv ->> 'tubing')::boolean, true),
    'model_3d', coalesce((pv ->> 'model_3d')::boolean, true),
    'vehicle_photos', coalesce((pv ->> 'vehicle_photos')::boolean, true),
    'cage_photos', case
      when pv ->> 'cage_photos' in ('all', 'some', 'none') then pv ->> 'cage_photos'
      when pv ->> 'cage_photos' = 'false' then 'none'
      else 'all' end,
    'cage_photo_list', case when jsonb_typeof(pv -> 'cage_photo_list') = 'array'
      then (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements_text(pv -> 'cage_photo_list') x where x ~ '^[0-9a-f]{64}$')
      else '[]'::jsonb end)
$$;

update logbooks set privacy = privacy || '{"vin": "hidden"}'
  where privacy = '{"owner": false, "vin": "partial", "builder": true, "cage_photos": true}'::jsonb;
alter table logbooks alter column privacy set default '{"owner": false, "vin": "hidden", "builder": true, "tubing": true, "model_3d": true, "vehicle_photos": true, "cage_photos": "all", "cage_photo_list": []}';

create or replace function set_privacy(p_logbook uuid, p_privacy jsonb, p_public_enabled boolean) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.logbooks set privacy = public.privacy_norm(p_privacy), public_enabled = p_public_enabled
  where id = p_logbook and owner_email = public.current_email();
  if not found then raise exception 'not your logbook'; end if;
end $$;

create or replace function my_garage() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', l.id, 'digitalNumber', l.digital_number, 'vin', l.vin, 'body', l.issuing_body, 'status', l.status,
    'publicToken', l.public_token, 'publicEnabled', l.public_enabled, 'privacy', public.privacy_norm(l.privacy),
    'bodyNumbers', (select coalesce(jsonb_object_agg(n.body_id, n.number), '{}'::jsonb) from public.logbook_numbers n where n.logbook_id = l.id),
    'vehicle', (select r.body -> 'vehicle' from public.records r where r.logbook_id = l.id and r.kind = 'issue')
  ) order by l.issued_at), '[]'::jsonb)
  from public.logbooks l where l.owner_email = public.current_email()
$$;

create or replace function public_logbook(p_token text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  lb public.logbooks;
  pv jsonb;
  shown_vin text;
begin
  select * into lb from public.logbooks where public_token = p_token and public_enabled;
  if lb.id is null then return null; end if;
  pv := public.privacy_norm(lb.privacy);
  shown_vin := case pv ->> 'vin' when 'full' then lb.vin
                    when 'partial' then repeat('*', greatest(length(lb.vin) - 6, 0)) || right(lb.vin, 6) end;
  return jsonb_build_object(
    'digitalNumber', lb.digital_number,
    'vin', shown_vin,
    'body', lb.issuing_body,
    'bodyName', (select name from public.bodies where id = lb.issuing_body),
    'status', lb.status,
    'issuedAt', lb.issued_at,
    'shows', jsonb_build_object('model3d', pv -> 'model_3d', 'tubing', pv -> 'tubing'),
    'bodyNumbers', (select coalesce(jsonb_object_agg(n.body_id, n.number), '{}'::jsonb) from public.logbook_numbers n where n.logbook_id = lb.id),
    'records', (select coalesce(jsonb_agg(jsonb_build_object(
        'seq', r.seq, 'kind', r.kind, 'createdAt', r.created_at, 'author', a.name, 'license', a.license_number,
        'authorBody', a.body_id, 'hash', r.hash, 'prevHash', r.prev_hash,
        'body', public.public_record_body(r.body, pv)) order by r.seq), '[]'::jsonb)
      from public.records r join public.accreditations a on a.id = r.accreditation_id
      where r.logbook_id = lb.id));
end $$;

-- A record's content as the public view shows it (pv: privacy_norm'ed):
-- never the paper pages, damage photos or tech sheets, nor the owner's and
-- VIN answers; the owner, builder, vehicle photos and rollcage pictures as
-- the owner allows; the cage's answers only for its 3D model -- just its
-- tubing specs when the model is hidden, none when both are.
create or replace function public_record_body(b jsonb, pv jsonb) returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  out jsonb := b;
  answers jsonb;
  shown jsonb;
begin
  pv := public.privacy_norm(pv);
  shown := pv -> 'cage_photo_list';
  if not (pv ->> 'owner')::boolean then out := out - 'owner'; end if;
  out := out - 'techSheets' - 'paperPages' - 'damagePhotos';
  if not (pv ->> 'vehicle_photos')::boolean then out := out - 'vehiclePhotos'; end if;
  if pv ->> 'cage_photos' = 'none' then out := out - 'pictures';
  elsif pv ->> 'cage_photos' = 'some' and jsonb_typeof(out -> 'pictures') = 'array' then
    out := jsonb_set(out, '{pictures}', (select coalesce(jsonb_agg(p), '[]'::jsonb)
      from jsonb_array_elements(out -> 'pictures') p where shown ? (p ->> 'sha256')));
  end if;
  answers := out #> '{cage,answers}';
  if answers is not null then
    if not (pv ->> 'model_3d')::boolean then
      answers := (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(answers) e(k, v)
                  where k in ('primary_tubing', 'secondary_tubing'));
    end if;
    if not (pv ->> 'tubing')::boolean then answers := answers - 'primary_tubing' - 'secondary_tubing'; end if;
    answers := answers - 'vehicle_vin';
    if not (pv ->> 'builder')::boolean then
      answers := answers - 'vehicle_builder' - 'vehicle_builder_name' - 'vehicle_builder_address'
                         - 'vehicle_builder_email' - 'vehicle_builder_phone';
    end if;
    answers := answers - 'vehicle_owner_name' - 'vehicle_owner_address' - 'vehicle_owner_email' - 'vehicle_owner_phone';
    out := case when answers = '{}'::jsonb then out - 'cage' else jsonb_set(out, '{cage,answers}', answers) end;
  end if;
  return out;
end $$;

-- A stored photo anyone may see: a vehicle photo or rollcage picture of a
-- public logbook, as its owner allows.
create or replace function photo_public(p_name text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.logbook_photos lp join public.logbooks l on l.id = lp.logbook_id
    cross join lateral (select public.privacy_norm(l.privacy) as pv) x
    where lp.sha256 = p_name and l.public_enabled
      and ((lp.kind = 'vehicle' and (x.pv ->> 'vehicle_photos')::boolean)
        or (lp.kind = 'cage' and (x.pv ->> 'cage_photos' = 'all'
                                  or (x.pv ->> 'cage_photos' = 'some' and x.pv -> 'cage_photo_list' ? p_name)))))
$$;

revoke execute on function privacy_norm from public, anon, authenticated;
revoke execute on function reset_public_link from public, anon, authenticated;

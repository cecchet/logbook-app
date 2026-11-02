-- Digital logbooks -- a car's thumbnail and public link in search results.
-- search_logbooks also returns, for each logbook:
--  - photo: the SHA-256 of its car photo (the latest record's 3/4 front, else
--    rear; else its latest rollcage picture, overview first), for a thumbnail;
--  - publicToken / publicEnabled: its public link, to see what a QR sticker
--    scan shows (the owner's privacy choices applied).
-- And public_logbook, the public view, opens for signed-in users too (the
-- owner checking their public link, a scrutineer's Public view): it was
-- granted to anon only, so they got "permission denied".

create or replace function search_logbooks(f jsonb) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  t text := '%' || coalesce(nullif(trim(f ->> 'text'), ''), '') || '%';
  has_text boolean := coalesce(nullif(trim(f ->> 'text'), ''), '') <> '';
  issuer text := '%' || coalesce(nullif(trim(f ->> 'issuer'), ''), '') || '%';
  has_issuer boolean := coalesce(nullif(trim(f ->> 'issuer'), ''), '') <> '';
  mine boolean := coalesce((f ->> 'mine')::boolean, false);
begin
  if not (public.is_admin() or public.is_scrutineer()) then raise exception 'not allowed'; end if;
  return coalesce((select jsonb_agg(x order by x ->> 'issuedAt' desc) from (
    select jsonb_build_object(
      'id', l.id, 'digitalNumber', l.digital_number, 'vin', l.vin, 'hasVin', l.has_vin, 'body', l.issuing_body,
      'status', l.status, 'make', l.make, 'model', l.model, 'year', l.year, 'carName', l.car_name,
      'ownerName', l.owner_name, 'ownerEmail', l.owner_email, 'issuedAt', l.issued_at,
      'issuedBy', jsonb_build_object('name', a.name, 'email', ir.author_email),
      'publicToken', l.public_token, 'publicEnabled', l.public_enabled,
      'photo', coalesce(
        (select coalesce(r.body -> 'vehiclePhotos' -> 'front' ->> 'sha256', r.body -> 'vehiclePhotos' -> 'rear' ->> 'sha256')
          from public.records r
          where r.logbook_id = l.id and jsonb_typeof(r.body -> 'vehiclePhotos') = 'object'
            and coalesce(r.body -> 'vehiclePhotos' -> 'front' ->> 'sha256', r.body -> 'vehiclePhotos' -> 'rear' ->> 'sha256') is not null
          order by r.seq desc limit 1),
        (select p ->> 'sha256'
          from public.records r, jsonb_array_elements(case when jsonb_typeof(r.body -> 'pictures') = 'array' then r.body -> 'pictures' else '[]' end) p
          where r.logbook_id = l.id and p ->> 'sha256' is not null
          order by r.seq desc, (p ->> 'category' = 'overview') desc nulls last limit 1)),
      'bodyNumbers', (select coalesce(jsonb_object_agg(n.body_id, n.number), '{}'::jsonb) from public.logbook_numbers n where n.logbook_id = l.id)) as x
    from public.logbooks l
    left join public.records ir on ir.logbook_id = l.id and ir.kind = 'issue'
    left join public.accreditations a on a.id = ir.accreditation_id
    where (not has_text or l.digital_number ilike t or l.vin ilike t or l.car_name ilike t or l.make ilike t
           or l.model ilike t or l.owner_name ilike t or l.owner_email ilike t
           or exists (select 1 from public.logbook_numbers n where n.logbook_id = l.id and n.number ilike t))
      and (coalesce(f ->> 'body', '') = '' or l.issuing_body = f ->> 'body')
      and (coalesce(f ->> 'make', '') = '' or l.make ilike '%' || (f ->> 'make') || '%')
      and (coalesce(f ->> 'model', '') = '' or l.model ilike '%' || (f ->> 'model') || '%')
      and (coalesce(f ->> 'year', '') = '' or l.year = f ->> 'year')
      and (coalesce(f ->> 'owner', '') = '' or l.owner_name ilike '%' || (f ->> 'owner') || '%' or l.owner_email ilike '%' || (f ->> 'owner') || '%')
      and (coalesce(f ->> 'status', '') = '' or l.status = f ->> 'status')
      and (not has_issuer or a.name ilike issuer or ir.author_email ilike issuer)
      and (not mine or ir.author_email = public.current_email())
    order by l.issued_at desc limit 50) s), '[]'::jsonb);
end $$;

revoke execute on function search_logbooks from public, anon;
grant execute on function search_logbooks to authenticated;

grant execute on function public_logbook to authenticated;

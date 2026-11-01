-- Digital logbooks -- finding logbooks by who issued them.
-- search_logbooks takes two more filters and says who issued each logbook
-- (the author of its issue record):
--  - issuer: part of the issuing scrutineer's name or email;
--  - mine: true for the logbooks the caller issued.

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

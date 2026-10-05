-- Digital logbooks -- fourth migration: photos.
--
-- Photos live in the private storage bucket "logbook-photos", each named by
-- the SHA-256 of its bytes (64 hex characters, no extension): the same
-- photo is stored once, and a record that lists a photo's hash pins its
-- exact content (a viewer can re-hash what it downloads). Records list
-- their photos in their body:
--   pictures: [{ sha256, screenshotSha256?, category, elements }]  (rollcage pictures)
--   vehiclePhotos: { front: { sha256 }, rear: { sha256 } }
--   paperPages / damagePhotos: [{ sha256 }]
-- logbook_photos indexes them per logbook, for the access rules below:
--  - scrutineers upload (and only add: no update or delete, ever);
--  - a photo is readable by whoever can read a logbook that lists it;
--  - the public link shows a logbook's rollcage and vehicle photos when its
--    owner allows them (privacy.cage_photos), never paper pages or damage.

insert into storage.buckets (id, name, public) values ('logbook-photos', 'logbook-photos', false)
  on conflict (id) do nothing;

create table logbook_photos (
  logbook_id uuid not null references logbooks(id),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('cage', 'vehicle', 'paper', 'damage')),
  record_id uuid not null references records(id),
  primary key (logbook_id, sha256, record_id)
);
create index logbook_photos_sha on logbook_photos (sha256);
alter table logbook_photos enable row level security;
revoke all on logbook_photos from anon, authenticated;

-- Indexes the photos a new record lists.
create or replace function records_index_photos() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  b jsonb := new.body;
  arr jsonb;
begin
  insert into public.logbook_photos (logbook_id, sha256, kind, record_id)
  select distinct new.logbook_id, x.sha, x.kind, new.id from (
    select p ->> 'sha256' as sha, 'cage' as kind from jsonb_array_elements(case when jsonb_typeof(b -> 'pictures') = 'array' then b -> 'pictures' else '[]' end) p
    union all
    select p ->> 'screenshotSha256', 'cage' from jsonb_array_elements(case when jsonb_typeof(b -> 'pictures') = 'array' then b -> 'pictures' else '[]' end) p
    union all
    select v.value ->> 'sha256', 'vehicle' from jsonb_each(case when jsonb_typeof(b -> 'vehiclePhotos') = 'object' then b -> 'vehiclePhotos' else '{}' end) v
      where jsonb_typeof(v.value) = 'object'
    union all
    select p ->> 'sha256', 'paper' from jsonb_array_elements(case when jsonb_typeof(b -> 'paperPages') = 'array' then b -> 'paperPages' else '[]' end) p
    union all
    select p ->> 'sha256', 'damage' from jsonb_array_elements(case when jsonb_typeof(b -> 'damagePhotos') = 'array' then b -> 'damagePhotos' else '[]' end) p
  ) x
  where x.sha ~ '^[0-9a-f]{64}$'
  on conflict do nothing;
  return new;
end $$;

create trigger records_photos after insert on records
  for each row execute function records_index_photos();

-- A stored photo's name is its hash.
create or replace function photo_readable(p_name text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select public.is_admin() or public.is_scrutineer()
      or exists (select 1 from public.logbook_photos lp where lp.sha256 = p_name and public.can_read_logbook(lp.logbook_id))
$$;

create or replace function photo_public(p_name text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.logbook_photos lp join public.logbooks l on l.id = lp.logbook_id
    where lp.sha256 = p_name and lp.kind in ('cage', 'vehicle')
      and l.public_enabled and coalesce((l.privacy ->> 'cage_photos')::boolean, true))
$$;

create policy logbook_photos_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'logbook-photos' and name ~ '^[0-9a-f]{64}$' and public.is_scrutineer());
create policy logbook_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'logbook-photos' and (public.photo_readable(name) or public.photo_public(name)));
create policy logbook_photos_public_read on storage.objects for select to anon
  using (bucket_id = 'logbook-photos' and public.photo_public(name));
-- (No update or delete policy: a stored photo never changes or goes away.)

revoke execute on function records_index_photos, photo_readable, photo_public from public, anon, authenticated;
grant execute on function photo_readable, photo_public to authenticated;
grant execute on function photo_public to anon;

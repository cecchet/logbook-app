-- A team reads back the photos of the sheets it submitted: PassTech rebuilds a
-- draft from a submitted sheet ("Edit and re-submit") on a device that doesn't
-- have it, e.g. to fix what failed tech from a phone.
create or replace function tech_sheet_photo_mine(p_name text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_name ~ '^[0-9a-f]{64}$' and exists (
    select 1 from public.tech_sheets s
    where s.submitted_by = public.current_email() and strpos(s.competitor::text, p_name) > 0)
$$;

create policy tech_sheet_photos_own_read on storage.objects for select to authenticated
  using (bucket_id = 'tech-sheet-photos' and public.tech_sheet_photo_mine(name));

revoke execute on function tech_sheet_photo_mine from public, anon;
grant execute on function tech_sheet_photo_mine to authenticated;

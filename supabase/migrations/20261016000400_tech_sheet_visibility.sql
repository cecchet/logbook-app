-- Tech sheets: Private or Public. A body's sheet is Private by default -- it's
-- only used through the events it's attached to (they reach PassTech with the
-- event). A Public one is also listed in PassTech as the body's generic sheet,
-- for a competitor to pre-fill without an event. The automatic sheets made from
-- the rulesets (the library: body_id null) are never listed.
alter table tech_sheet_templates add column if not exists public boolean not null default false;
update tech_sheet_templates set public = false where body_id is null;

-- Signed out (PassTech), only the Public sheets can be read directly; signed in
-- (the logbook's staff), every active one.
drop policy if exists tech_sheet_templates_read on tech_sheet_templates;
create policy tech_sheet_templates_read on tech_sheet_templates for select to authenticated using (active);
create policy tech_sheet_templates_read_public on tech_sheet_templates for select to anon using (active and public);

-- The Public sheets, for PassTech: [{ id, key, title, version, body, bodyName, definition }].
create or replace function public_tech_sheets() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.template_json(t) || jsonb_build_object('bodyName', b.name) order by b.name, t.title), '[]'::jsonb)
  from public.tech_sheet_templates t join public.bodies b on b.id = t.body_id
  where t.active and t.public and b.disabled_at is null and b.deleted_at is null
$$;

-- Organizers save a sheet with its visibility (p.public; kept as it was when not given).
create or replace function save_tech_sheet_template(p jsonb) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  body text := nullif(p ->> 'body', '');
  result uuid;
begin
  if body is null and not public.is_admin() then raise exception 'not allowed'; end if;
  if body is not null and not public.can_organize(body) then raise exception 'not allowed'; end if;
  if coalesce(p ->> 'key', '') = '' or coalesce(p ->> 'title', '') = '' or jsonb_typeof(p -> 'definition') <> 'object' then
    raise exception 'a template needs a key, a title and its definition';
  end if;
  update public.tech_sheet_templates set title = p ->> 'title', definition = p -> 'definition',
    active = coalesce((p ->> 'active')::boolean, active), version = version + 1,
    public = body is not null and coalesce((p ->> 'public')::boolean, public),
    updated_by = public.current_email(), updated_at = now()
  where coalesce(body_id, '') = coalesce(body, '')
    and (id = nullif(p ->> 'id', '')::uuid or (p ->> 'id' is null and key = p ->> 'key'))
  returning id into result;
  if result is null then
    insert into public.tech_sheet_templates (body_id, key, title, definition, active, public, updated_by)
    values (body, p ->> 'key', p ->> 'title', p -> 'definition', coalesce((p ->> 'active')::boolean, true),
            body is not null and coalesce((p ->> 'public')::boolean, false), public.current_email())
    returning id into result;
  end if;
  return result;
end $$;

-- The template a sheet carries says whether it's Public.
create or replace function template_json(t public.tech_sheet_templates) returns jsonb
language sql stable
set search_path = ''
as $$
  select case when t.id is null then null else jsonb_build_object('id', t.id, 'key', t.key, 'title', t.title,
    'version', t.version, 'body', t.body_id, 'public', t.public, 'definition', t.definition) end
$$;

revoke execute on function public_tech_sheets from public;
grant execute on function public_tech_sheets to anon, authenticated;

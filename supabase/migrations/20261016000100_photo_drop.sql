-- Photo drop: a phone sends photos to a laptop (photo-capture.js / photo-drop.html in the shared
-- app). The laptop opens a session and shows its id in a QR code; the phone posts photos into it;
-- the laptop takes them (which deletes them). The id is the only key -- an unguessable uuid, valid
-- for two hours -- and the tables are reachable only through these functions, signed in or not
-- (the rollcage app has no accounts).
create table photo_drop_sessions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 hours'
);
create table photo_drop_items (
  id bigint generated always as identity primary key,
  session_id uuid not null references photo_drop_sessions(id) on delete cascade,
  data text not null,
  created_at timestamptz not null default now()
);
create index photo_drop_items_session on photo_drop_items (session_id, id);
alter table photo_drop_sessions enable row level security;
alter table photo_drop_items enable row level security;
revoke all on photo_drop_sessions, photo_drop_items from anon, authenticated;

-- A new session (expired ones are cleared on the way).
create or replace function photo_drop_open() returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  result uuid;
begin
  delete from public.photo_drop_sessions where expires_at < now();
  if (select count(*) from public.photo_drop_sessions) >= 2000 then
    raise exception 'too many photo transfers open right now -- try again in a few minutes';
  end if;
  insert into public.photo_drop_sessions default values returning id into result;
  return result;
end $$;

-- The phone sends one photo (a JPEG/PNG/WebP data URL). Returns how many are waiting.
create or replace function photo_drop_put(p_session uuid, p_data text) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  waiting integer;
begin
  if not exists (select 1 from public.photo_drop_sessions where id = p_session and expires_at > now()) then
    raise exception 'this photo link has expired -- scan the new QR code on the laptop';
  end if;
  if p_data !~ '^data:image/(jpeg|png|webp);base64,' then raise exception 'not a photo'; end if;
  if length(p_data) > 6000000 then raise exception 'photo too large (about 4 MB at most)'; end if;
  select count(*) into waiting from public.photo_drop_items where session_id = p_session;
  if waiting >= 40 then raise exception 'too many photos waiting -- let the laptop catch up'; end if;
  insert into public.photo_drop_items (session_id, data) values (p_session, p_data);
  return waiting + 1;
end $$;

-- The laptop takes what has arrived (deleting it). { open: still valid, photos: [data URL...] }
create or replace function photo_drop_take(p_session uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  photos jsonb;
begin
  with taken as (delete from public.photo_drop_items where session_id = p_session returning id, data)
  select coalesce(jsonb_agg(data order by id), '[]'::jsonb) into photos from taken;
  return jsonb_build_object('photos', photos,
    'open', exists (select 1 from public.photo_drop_sessions where id = p_session and expires_at > now()));
end $$;

-- The laptop is done with the session (its photos go with it).
create or replace function photo_drop_close(p_session uuid) returns void
language sql security definer
set search_path = ''
as $$ delete from public.photo_drop_sessions where id = p_session $$;

grant execute on function photo_drop_open, photo_drop_put, photo_drop_take, photo_drop_close to anon, authenticated;

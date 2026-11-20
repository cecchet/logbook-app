-- Roll cage design reviews and logbook requests, from the Rollcage assessment tool, and the emails
-- that go with them; and the scrutineers' opt-in daily digest of annual sticker applications.
--
-- Design reviews:
--  - designs: a roll cage design, owned by whoever first submitted it (signed in to the Rollcage
--    assessment tool). Its versions are kept for good: the design's history.
--  - design_versions: each version, as the rollcage file the tool exports (photos included), in
--    the design-files bucket under its SHA-256 -- who saved it (the owner, or the reviewer during
--    a review), when, and their note.
--  - design_requests: the owner sends the design to an approved fabricator or a listed scrutineer
--    (picked from the public directory, by id -- the owner never sees their email) for a review,
--    or to a listed scrutineer who may issue logbooks for a logbook. One open request at a time.
--    The reviewer may save new versions while it's open, then returns it (with a note) or
--    declines it; the owner may withdraw it. The design then goes back to the owner, who can
--    change it and send it again -- to the same reviewer or another -- with its whole history.
--  - A logbook request is issued on the Scrutineering site: the scrutineer opens the design,
--    inspects the car, issues the logbook and completes the request with it. keep_history: the
--    owner lets the logbook keep the design's history (readable by whoever can read the logbook).
--  - Who reads a design: its owner, and everyone it was sent to (they see all its history).
--
-- Emails (api/notify.js, through Resend): claim_design_notification records each one first --
-- the request's reviewer when it's sent, its owner when it comes back -- so each goes out once.
--
-- Annual sticker digest: a scrutineer who may issue annual gear stickers opts in, per body and
-- discipline (sticker_alerts); once a day api/sticker-digest.js (a Vercel cron job) asks
-- sticker_digest() what's new since each one's last digest, with the shared secret in
-- app_settings ('digest_secret'), which the cron job holds too (DIGEST_SECRET).

insert into storage.buckets (id, name, public) values ('design-files', 'design-files', false)
  on conflict (id) do nothing;

create table if not exists designs (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null check (owner_email = lower(owner_email)),
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists designs_owner on designs (owner_email);

create table if not exists design_requests (
  id uuid primary key default gen_random_uuid(),
  design_id uuid not null references designs(id),
  kind text not null check (kind in ('review', 'logbook')),
  reviewer_email text not null check (reviewer_email = lower(reviewer_email)),
  reviewer_name text not null,
  reviewer_kind text not null check (reviewer_kind in ('fabricator', 'scrutineer')),
  fabricator_id uuid references fabricators(id),
  accreditation_id uuid references accreditations(id),
  body_id text references bodies(id),
  discipline text,
  message text,
  -- The version sent, and (returned) the latest when it came back.
  version_seq int not null,
  returned_seq int,
  status text not null default 'open' check (status in ('open', 'returned', 'declined', 'withdrawn', 'issued')),
  return_note text,
  keep_history boolean not null default false,
  logbook_id uuid references logbooks(id),
  created_at timestamptz not null default now(),
  handled_at timestamptz
);
create unique index if not exists design_requests_one_open on design_requests (design_id) where status = 'open';
create index if not exists design_requests_reviewer on design_requests (reviewer_email);

create table if not exists design_versions (
  design_id uuid not null references designs(id),
  seq int not null,
  author_email text not null,
  author_name text,
  role text not null check (role in ('owner', 'reviewer')),
  request_id uuid references design_requests(id),
  note text,
  file_sha text not null check (file_sha ~ '^[0-9a-f]{64}$'),
  file_size int,
  created_at timestamptz not null default now(),
  primary key (design_id, seq)
);
create index if not exists design_versions_sha on design_versions (file_sha);

create table if not exists design_notifications (
  request_id uuid not null references design_requests(id),
  kind text not null check (kind in ('submitted', 'returned')),
  recipient text not null,
  created_at timestamptz not null default now(),
  primary key (request_id, kind)
);

alter table designs enable row level security;
alter table design_requests enable row level security;
alter table design_versions enable row level security;
alter table design_notifications enable row level security;
revoke all on designs, design_requests, design_versions, design_notifications from anon, authenticated;

-- The directory now gives each scrutineer listing its id (to send them a request, without their email).
create or replace function scrutineer_directory(p_body text default null, p_discipline text default null, p_logbooks boolean default false) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'body', a.body_id, 'bodyName', b.name,
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

-- 'owner', 'reviewer' (it was sent to the caller), or null.
create or replace function design_role(p_design uuid) returns text
language sql stable security definer
set search_path = ''
as $$
  select case when exists (select 1 from public.designs d where d.id = p_design and d.owner_email = public.current_email()) then 'owner'
              when exists (select 1 from public.design_requests r where r.design_id = p_design and r.reviewer_email = public.current_email()) then 'reviewer'
         end
$$;

-- A design file is readable by whoever reads a design it's a version of -- or a logbook that kept
-- that design's history.
create or replace function design_file_readable(p_name text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_name ~ '^[0-9a-f]{64}$' and exists (
    select 1 from public.design_versions v
    where v.file_sha = p_name and (public.design_role(v.design_id) is not null or exists (
      select 1 from public.design_requests r where r.design_id = v.design_id and r.status = 'issued' and r.keep_history
        and r.logbook_id is not null and public.can_read_logbook(r.logbook_id))))
$$;

drop policy if exists design_files_upload on storage.objects;
create policy design_files_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'design-files' and name ~ '^[0-9a-f]{64}$');
drop policy if exists design_files_read on storage.objects;
create policy design_files_read on storage.objects for select to authenticated
  using (bucket_id = 'design-files' and public.design_file_readable(name));
-- (No update or delete: a stored version never changes.)

create or replace function design_request_json(r public.design_requests) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object('id', r.id, 'designId', r.design_id, 'kind', r.kind, 'reviewerName', r.reviewer_name, 'reviewerKind', r.reviewer_kind,
    'body', r.body_id, 'bodyName', (select b.name from public.bodies b where b.id = r.body_id),
    'discipline', r.discipline, 'disciplineName', public.discipline_name(r.body_id, r.discipline),
    'message', r.message, 'versionSeq', r.version_seq, 'returnedSeq', r.returned_seq, 'status', r.status, 'returnNote', r.return_note,
    'keepHistory', r.keep_history, 'logbookId', r.logbook_id,
    'logbookNumber', (select l.digital_number from public.logbooks l where l.id = r.logbook_id),
    'createdAt', r.created_at, 'handledAt', r.handled_at,
    'mine', r.reviewer_email = public.current_email())
$$;

-- A design with its versions and requests, oldest first. The owner's email shows to its reviewers.
create or replace function design_json(d public.designs) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object('id', d.id, 'title', d.title, 'ownerEmail', d.owner_email, 'createdAt', d.created_at, 'updatedAt', d.updated_at,
    'versions', (select coalesce(jsonb_agg(jsonb_build_object('seq', v.seq, 'authorName', coalesce(v.author_name, v.author_email), 'role', v.role,
        'requestId', v.request_id, 'note', v.note, 'fileSha', v.file_sha, 'fileSize', v.file_size, 'createdAt', v.created_at) order by v.seq), '[]'::jsonb)
      from public.design_versions v where v.design_id = d.id),
    'requests', (select coalesce(jsonb_agg(public.design_request_json(r) order by r.created_at), '[]'::jsonb)
      from public.design_requests r where r.design_id = d.id))
$$;

-- The caller's name, as a scrutineer or fabricator knows it (else null).
create or replace function my_display_name() returns text
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
    (select a.name from public.accreditations a where a.email = public.current_email() and a.deleted_at is null order by a.granted_at desc limit 1),
    (select coalesce(f.contact_name, f.business) from public.fabricators f where f.email = public.current_email() and f.status = 'approved' order by f.applied_at desc limit 1))
$$;

-- Saves a new version: p = { designId?, title?, fileSha, fileSize?, note? } -> { designId, seq }.
-- Without designId, a new design (the caller owns it). The owner saves one while no request is open;
-- a reviewer, while the request to them is open (the version is part of their review).
create or replace function save_design_version(p jsonb) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  me text := public.current_email();
  did uuid := nullif(p ->> 'designId', '')::uuid;
  sha text := p ->> 'fileSha';
  req public.design_requests;
  who text;
  n int;
begin
  if me is null or me = '' then raise exception 'sign in first'; end if;
  if sha is null or sha !~ '^[0-9a-f]{64}$' then raise exception 'no design file'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'design-files' and o.name = sha) then
    raise exception 'the design file isn''t uploaded';
  end if;
  if did is null then
    insert into public.designs (owner_email, title) values (me, coalesce(nullif(trim(coalesce(p ->> 'title', '')), ''), 'Roll cage design'))
    returning id into did;
    who := 'owner';
  else
    who := public.design_role(did);
    select * into req from public.design_requests r where r.design_id = did and r.status = 'open';
    if who = 'owner' then
      if req.id is not null and req.reviewer_email <> me then
        raise exception 'it''s with % for review: withdraw the request first, or wait until it comes back', req.reviewer_name;
      end if;
      req := null;
    elsif who = 'reviewer' then
      if req.id is null or req.reviewer_email <> me then raise exception 'the design isn''t with you for review'; end if;
      if req.kind <> 'review' then raise exception 'a logbook request doesn''t take new versions'; end if;
    else
      raise exception 'no such design';
    end if;
    if p ? 'title' and who = 'owner' and nullif(trim(p ->> 'title'), '') is not null then
      update public.designs set title = trim(p ->> 'title') where id = did;
    end if;
  end if;
  select coalesce(max(v.seq), 0) + 1 into n from public.design_versions v where v.design_id = did;
  insert into public.design_versions (design_id, seq, author_email, author_name, role, request_id, note, file_sha, file_size)
  values (did, n, me, public.my_display_name(), who, req.id, nullif(trim(coalesce(p ->> 'note', '')), ''), sha, nullif(p ->> 'fileSize', '')::int);
  update public.designs set updated_at = now() where id = did;
  return jsonb_build_object('designId', did, 'seq', n);
end $$;

-- Sends the design's latest version: p = { designId, kind: review | logbook, fabricatorId? |
-- accreditationId?, message?, keepHistory? } -> the request's id. Only its owner, one at a time.
-- A review: an approved fabricator, or a listed scrutineer. A logbook: a listed scrutineer who may
-- issue logbooks.
create or replace function submit_design_request(p jsonb) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  me text := public.current_email();
  did uuid := (p ->> 'designId')::uuid;
  k text := p ->> 'kind';
  f public.fabricators;
  a public.accreditations;
  seq int;
  rid uuid;
begin
  if public.design_role(did) is distinct from 'owner' then raise exception 'only the design''s owner sends it'; end if;
  if k not in ('review', 'logbook') then raise exception 'a review or a logbook'; end if;
  if exists (select 1 from public.design_requests r where r.design_id = did and r.status = 'open') then
    raise exception 'it''s already sent: withdraw that request first';
  end if;
  select max(v.seq) into seq from public.design_versions v where v.design_id = did;
  if seq is null then raise exception 'the design has no version yet'; end if;
  if nullif(p ->> 'fabricatorId', '') is not null then
    if k = 'logbook' then raise exception 'only a scrutineer issues logbooks'; end if;
    select * into f from public.fabricators x where x.id = (p ->> 'fabricatorId')::uuid and x.status = 'approved';
    if f.id is null then raise exception 'that fabricator isn''t approved (any more)'; end if;
    if f.email = me then raise exception 'that''s you'; end if;
    insert into public.design_requests (design_id, kind, reviewer_email, reviewer_name, reviewer_kind, fabricator_id, body_id, discipline, message, version_seq)
    values (did, k, f.email, f.business, 'fabricator', f.id, f.body_id, f.discipline, nullif(trim(coalesce(p ->> 'message', '')), ''), seq)
    returning id into rid;
  else
    select * into a from public.accreditations x where x.id = (p ->> 'accreditationId')::uuid;
    if a.id is null or not public.accreditation_active(a)
       or not exists (select 1 from public.staff_profiles s where s.email = a.email and s.listed) then
      raise exception 'that scrutineer isn''t listed (any more)';
    end if;
    if k = 'logbook' and not ('issue_logbooks' = any (public.accreditation_permissions(a))) then
      raise exception '% doesn''t issue logbooks', a.name;
    end if;
    if a.email = me then raise exception 'that''s you'; end if;
    insert into public.design_requests (design_id, kind, reviewer_email, reviewer_name, reviewer_kind, accreditation_id, body_id, discipline, message, version_seq, keep_history)
    values (did, k, a.email, a.name, 'scrutineer', a.id, a.body_id, a.discipline, nullif(trim(coalesce(p ->> 'message', '')), ''), seq,
      k = 'logbook' and coalesce((p ->> 'keepHistory')::boolean, false))
    returning id into rid;
  end if;
  update public.designs set updated_at = now() where id = did;
  return rid;
end $$;

-- The owner takes an open request back.
create or replace function withdraw_design_request(p_id uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.design_requests r set status = 'withdrawn', handled_at = now()
  where r.id = p_id and r.status = 'open' and public.design_role(r.design_id) = 'owner';
  if not found then raise exception 'nothing to withdraw'; end if;
end $$;

-- The reviewer returns a review (p_decline: declines it, a review or a logbook request), with a note.
create or replace function return_design_request(p_id uuid, p_note text, p_decline boolean default false) returns void
language plpgsql security definer
set search_path = ''
as $$
declare r public.design_requests;
begin
  select * into r from public.design_requests x where x.id = p_id;
  if r.id is null or r.reviewer_email <> public.current_email() then raise exception 'that request isn''t yours'; end if;
  if r.status <> 'open' then raise exception 'that request is %', r.status; end if;
  if r.kind = 'logbook' and not p_decline then raise exception 'a logbook request is completed by issuing the logbook'; end if;
  if p_decline and nullif(trim(coalesce(p_note, '')), '') is null then raise exception 'say why'; end if;
  update public.design_requests set status = case when p_decline then 'declined' else 'returned' end, handled_at = now(),
    return_note = nullif(trim(coalesce(p_note, '')), ''),
    returned_seq = (select max(v.seq) from public.design_versions v where v.design_id = r.design_id)
  where id = p_id;
  update public.designs set updated_at = now() where id = r.design_id;
end $$;

-- The scrutineer completes a logbook request with the logbook they issued from it.
create or replace function complete_logbook_request(p_id uuid, p_logbook uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare r public.design_requests;
begin
  select * into r from public.design_requests x where x.id = p_id;
  if r.id is null or r.reviewer_email <> public.current_email() or r.kind <> 'logbook' then raise exception 'that logbook request isn''t yours'; end if;
  if r.status <> 'open' then raise exception 'that request is %', r.status; end if;
  if not exists (select 1 from public.logbooks l where l.id = p_logbook and l.issued_by = public.current_email()) then
    raise exception 'that logbook wasn''t issued by you';
  end if;
  update public.design_requests set status = 'issued', logbook_id = p_logbook, handled_at = now(),
    returned_seq = (select max(v.seq) from public.design_versions v where v.design_id = r.design_id)
  where id = p_id;
  update public.designs set updated_at = now() where id = r.design_id;
end $$;

-- The caller's designs, latest first.
create or replace function my_designs() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.design_json(d) order by d.updated_at desc), '[]'::jsonb)
  from public.designs d where d.owner_email = public.current_email()
$$;

-- The designs sent to the caller (open requests first), each with its whole history.
create or replace function my_design_requests() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.design_json(d) order by d.updated_at desc), '[]'::jsonb)
  from public.designs d
  where exists (select 1 from public.design_requests r where r.design_id = d.id and r.reviewer_email = public.current_email())
$$;

-- A logbook's design history, when its owner let it keep it (else null).
create or replace function logbook_design_history(p_logbook uuid) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select public.design_json(d) from public.designs d
  where public.can_read_logbook(p_logbook) and exists (
    select 1 from public.design_requests r where r.design_id = d.id and r.logbook_id = p_logbook and r.status = 'issued' and r.keep_history)
  limit 1
$$;

-- Claims a request's email -- 'submitted' (by its owner, to the reviewer, within an hour) or
-- 'returned' (by the reviewer, to the owner, within an hour of returning or declining it) -- once.
-- Returns what the email says.
create or replace function claim_design_notification(p_request uuid, p_kind text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  me text := public.current_email();
  r public.design_requests;
  d public.designs;
  recipient text;
begin
  select * into r from public.design_requests x where x.id = p_request;
  if r.id is null then raise exception 'no such request'; end if;
  select * into d from public.designs x where x.id = r.design_id;
  if p_kind = 'submitted' then
    if d.owner_email <> me then raise exception 'only the design''s owner'; end if;
    if r.status <> 'open' or r.created_at < now() - interval '1 hour' then raise exception 'too late to notify'; end if;
    recipient := r.reviewer_email;
  elsif p_kind = 'returned' then
    if r.reviewer_email <> me then raise exception 'only its reviewer'; end if;
    if r.status not in ('returned', 'declined') or r.handled_at < now() - interval '1 hour' then raise exception 'too late to notify'; end if;
    recipient := d.owner_email;
  else
    raise exception 'unknown kind';
  end if;
  insert into public.design_notifications (request_id, kind, recipient) values (r.id, p_kind, recipient);
  return jsonb_build_object('to', recipient, 'kind', r.kind, 'status', r.status, 'title', d.title, 'ownerEmail', d.owner_email,
    'reviewerName', r.reviewer_name, 'reviewerKind', r.reviewer_kind,
    'scope', concat_ws(' ', (select b.name from public.bodies b where b.id = r.body_id), nullif(public.discipline_name(r.body_id, r.discipline), '')),
    'message', r.message, 'returnNote', r.return_note, 'keepHistory', r.keep_history,
    'versions', (select count(*) from public.design_versions v where v.design_id = d.id),
    'changed', r.returned_seq is not null and r.returned_seq > r.version_seq);
exception when unique_violation then
  raise exception 'already sent';
end $$;

-- ---- Annual sticker applications: the daily digest ----

create table if not exists sticker_alerts (
  email text not null check (email = lower(email)),
  body_id text not null references bodies(id),
  -- '' : all of the body's (or a body without disciplines).
  discipline text not null default '',
  created_at timestamptz not null default now(),
  last_sent_at timestamptz,
  primary key (email, body_id, discipline)
);
create table if not exists app_settings (key text primary key, value text not null);
alter table sticker_alerts enable row level security;
alter table app_settings enable row level security;
revoke all on sticker_alerts, app_settings from anon, authenticated;

-- Whether this person may issue annual gear stickers in this body and discipline.
create or replace function may_issue_annual(p_email text, p_body text, p_discipline text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.accreditations a where a.email = p_email and a.body_id = p_body and public.accreditation_active(a)
    and (a.discipline is null or a.discipline = nullif(p_discipline, ''))
    and 'issue_annual_stickers' = any (public.accreditation_permissions(a)))
$$;

create or replace function my_sticker_alerts() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('body', s.body_id, 'discipline', s.discipline)), '[]'::jsonb)
  from public.sticker_alerts s where s.email = public.current_email()
$$;

create or replace function set_sticker_alert(p_body text, p_discipline text, p_on boolean) returns void
language plpgsql security definer
set search_path = ''
as $$
declare me text := public.current_email(); disc text := coalesce(p_discipline, '');
begin
  if p_on then
    if not public.may_issue_annual(me, p_body, disc) then raise exception 'only scrutineers who issue annual stickers there get the digest'; end if;
    insert into public.sticker_alerts (email, body_id, discipline) values (me, p_body, disc) on conflict do nothing;
  else
    delete from public.sticker_alerts where email = me and body_id = p_body and discipline = disc;
  end if;
end $$;

-- The day's digests (called by the cron job, with the shared secret): for each opted-in scrutineer,
-- the applications pending where they opted in that arrived since their last digest -- marked
-- sent. [{ to, name, groups: [{ scope, newCount, pendingCount, items: [{ category, owner, submittedAt }] }] }]
create or replace function sticker_digest(p_secret text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  secret text := (select s.value from public.app_settings s where s.key = 'digest_secret');
  result jsonb := '[]'::jsonb;
  who text;
  grp jsonb;
begin
  if secret is null or length(secret) < 16 or p_secret is distinct from secret then raise exception 'not allowed'; end if;
  for who in select distinct s.email from public.sticker_alerts s loop
    select coalesce(jsonb_agg(g), '[]'::jsonb) into grp from (
      select jsonb_build_object(
        'scope', concat_ws(' ', b.name, nullif(public.discipline_name(s.body_id, nullif(s.discipline, '')), '')),
        'newCount', count(*) filter (where a.submitted_at > coalesce(s.last_sent_at, s.created_at)),
        'pendingCount', count(*),
        'items', jsonb_agg(jsonb_build_object('category', a.category, 'owner', a.owner_name, 'submittedAt', a.submitted_at) order by a.submitted_at)
          filter (where a.submitted_at > coalesce(s.last_sent_at, s.created_at))) as g
      from public.sticker_alerts s
      join public.bodies b on b.id = s.body_id
      join public.sticker_applications a on a.body_id = s.body_id and a.status = 'pending'
        and (s.discipline = '' or a.discipline = s.discipline)
      where s.email = who and public.may_issue_annual(s.email, s.body_id, s.discipline)
      group by s.body_id, s.discipline, b.name, s.last_sent_at, s.created_at
      having count(*) filter (where a.submitted_at > coalesce(s.last_sent_at, s.created_at)) > 0) x;
    if jsonb_array_length(grp) > 0 then
      result := result || jsonb_build_array(jsonb_build_object('to', who,
        'name', (select a.name from public.accreditations a where a.email = who and a.deleted_at is null order by a.granted_at desc limit 1),
        'groups', grp));
    end if;
  end loop;
  update public.sticker_alerts set last_sent_at = now() where last_sent_at is null or last_sent_at < now();
  return result;
end $$;

revoke execute on function design_role, design_file_readable, design_request_json, design_json, my_display_name, may_issue_annual
  from public, anon, authenticated;
grant execute on function design_file_readable to authenticated;
revoke execute on function save_design_version, submit_design_request, withdraw_design_request, return_design_request,
  complete_logbook_request, my_designs, my_design_requests, logbook_design_history, claim_design_notification,
  my_sticker_alerts, set_sticker_alert from public, anon;
grant execute on function save_design_version, submit_design_request, withdraw_design_request, return_design_request,
  complete_logbook_request, my_designs, my_design_requests, logbook_design_history, claim_design_notification,
  my_sticker_alerts, set_sticker_alert to authenticated;
revoke execute on function sticker_digest from public, authenticated;
grant execute on function sticker_digest to anon;

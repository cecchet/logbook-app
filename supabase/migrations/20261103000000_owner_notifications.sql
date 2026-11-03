-- Digital logbooks -- emails to a car's owner (sent by the app's /api/notify
-- function through Resend). Each one is claimed here first: claim_notification
-- checks the caller may trigger it, records it, and returns what the email
-- says. Recording it first means each one goes out at most once, and the
-- function can't be used to email anyone else.
--
-- Kinds (more to come: an amendment, an event added to the logbook...):
--   issued  the logbook was just issued -- the scrutineer who issued it,
--           within an hour of issuing it, once per logbook.

create table notifications (
  id uuid primary key default gen_random_uuid(),
  logbook_id uuid not null references logbooks(id),
  kind text not null check (kind in ('issued')),
  -- What it's about within the logbook (a record's seq for later kinds; '' for issued).
  ref text not null default '',
  recipient text not null,
  requested_by text not null,
  created_at timestamptz not null default now(),
  unique (logbook_id, kind, ref)
);
alter table notifications enable row level security;
-- Read and written only through claim_notification.
revoke all on notifications from anon, authenticated;

create or replace function claim_notification(p_logbook uuid, p_kind text, p_ref text default '') returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  lb public.logbooks;
  me text := public.current_email();
begin
  if me is null or me = '' then raise exception 'not signed in'; end if;
  select * into lb from public.logbooks where id = p_logbook;
  if lb.id is null then raise exception 'no such logbook'; end if;
  if p_kind = 'issued' then
    if lb.issued_by <> me then raise exception 'only the scrutineer who issued it can notify its owner'; end if;
    if lb.issued_at < now() - interval '1 hour' then raise exception 'too long after issuing it'; end if;
  else
    raise exception 'unknown notification %', p_kind;
  end if;
  begin
    insert into public.notifications (logbook_id, kind, ref, recipient, requested_by)
    values (lb.id, p_kind, coalesce(p_ref, ''), lb.owner_email, me);
  exception when unique_violation then
    raise exception 'already sent';
  end;
  return jsonb_build_object(
    'kind', p_kind,
    'to', lb.owner_email,
    'ownerName', lb.owner_name,
    'digitalNumber', lb.digital_number,
    'car', nullif(concat_ws(' ', lb.year, lb.make, lb.model), ''),
    'carName', lb.car_name,
    'body', (select b.name from public.bodies b where b.id = lb.issuing_body),
    'bodyNumber', (select n.number from public.logbook_numbers n where n.logbook_id = lb.id and n.body_id = lb.issuing_body),
    'issuedAt', lb.issued_at,
    'issuedBy', coalesce((select a.name from public.accreditations a where a.email = lb.issued_by and a.body_id = lb.issuing_body order by a.granted_at desc limit 1), lb.issued_by),
    'publicToken', case when lb.public_enabled then lb.public_token end
  );
end $$;
revoke execute on function claim_notification from public, anon;
grant execute on function claim_notification to authenticated;

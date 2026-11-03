-- Digital logbooks -- "Email owner": a scrutineer re-sends the owner how to
-- reach their logbook, any time (after a sale, the new owner on record).
--   reminder  the issuing scrutineer, an active scrutineer of the logbook's
--             body, or an admin; at most once every 5 minutes per logbook;
--             not for a closed logbook.

alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in ('issued', 'reminder'));

create or replace function claim_notification(p_logbook uuid, p_kind text, p_ref text default '') returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  lb public.logbooks;
  me text := public.current_email();
  ref text := coalesce(p_ref, '');
begin
  if me is null or me = '' then raise exception 'not signed in'; end if;
  select * into lb from public.logbooks where id = p_logbook;
  if lb.id is null then raise exception 'no such logbook'; end if;
  if p_kind = 'issued' then
    if lb.issued_by <> me then raise exception 'only the scrutineer who issued it can notify its owner'; end if;
    if lb.issued_at < now() - interval '1 hour' then raise exception 'too long after issuing it'; end if;
  elsif p_kind = 'reminder' then
    if not (lb.issued_by = me or public.is_admin() or (public.my_accreditation(lb.issuing_body)).id is not null) then
      raise exception 'only a scrutineer of its sanctioning body can email its owner';
    end if;
    if lb.status = 'closed' then raise exception 'this logbook is closed'; end if;
    if exists (select 1 from public.notifications n where n.logbook_id = lb.id and n.kind = 'reminder' and n.created_at > now() - interval '5 minutes') then
      raise exception 'the owner was emailed less than 5 minutes ago';
    end if;
    -- Each one its own (the unique key is for kinds sent once).
    ref := gen_random_uuid()::text;
  else
    raise exception 'unknown notification %', p_kind;
  end if;
  begin
    insert into public.notifications (logbook_id, kind, ref, recipient, requested_by)
    values (lb.id, p_kind, ref, lb.owner_email, me);
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
    'sentBy', coalesce((select a.name from public.accreditations a where a.email = me and a.body_id = lb.issuing_body order by a.granted_at desc limit 1), me),
    'publicToken', case when lb.public_enabled then lb.public_token end
  );
end $$;
revoke execute on function claim_notification from public, anon;
grant execute on function claim_notification to authenticated;

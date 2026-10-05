-- Digital logbooks -- third migration: syncing local copies.
--  - logbook_heads: the latest record number of each of a list of
--    logbooks, to tell which local copies are out of date in one call;
--  - logbook_full: a whole logbook in one call -- its numbers and every
--    record, with the author's name and license and the event's name -- for
--    whoever can read it (its owner, scrutineers, admins).

create or replace function logbook_heads(p_ids uuid[]) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', l.id, 'digitalNumber', l.digital_number, 'status', l.status,
    'lastSeq', (select max(r.seq) from public.records r where r.logbook_id = l.id))), '[]'::jsonb)
  from public.logbooks l
  where l.id = any (p_ids) and public.can_read_logbook(l.id)
$$;

create or replace function logbook_full(p_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  lb public.logbooks;
begin
  select * into lb from public.logbooks where id = p_id;
  if lb.id is null or not public.can_read_logbook(lb.id) then raise exception 'no such logbook'; end if;
  return jsonb_build_object(
    'logbook', to_jsonb(lb) - case when lb.owner_email = public.current_email() then '' else 'public_token' end,
    'bodyNumbers', (select coalesce(jsonb_object_agg(n.body_id, n.number), '{}'::jsonb) from public.logbook_numbers n where n.logbook_id = lb.id),
    'records', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'seq', r.seq, 'kind', r.kind, 'body', r.body, 'createdAt', r.created_at, 'corrects', r.corrects,
        'authorEmail', r.author_email, 'authorName', a.name, 'license', a.license_number, 'authorBody', a.body_id,
        'eventId', r.event_id, 'eventName', e.name, 'eventStartsOn', e.starts_on,
        'hash', r.hash, 'prevHash', r.prev_hash) order by r.seq), '[]'::jsonb)
      from public.records r
      join public.accreditations a on a.id = r.accreditation_id
      left join public.events e on e.id = r.event_id
      where r.logbook_id = lb.id));
end $$;

revoke execute on function logbook_heads, logbook_full from public, anon;
grant execute on function logbook_heads, logbook_full to authenticated;

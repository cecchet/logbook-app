-- Competitors' email (from the MotorsportReg entry list import, or typed
-- in): how the event reaches the team, and the address they sign in to
-- PassTech with to submit their tech sheet.
alter table event_entries add column if not exists email text;

create or replace function save_entry(p_event uuid, p jsonb) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  ev public.events;
  result uuid;
begin
  select * into ev from public.events where id = p_event;
  if ev.id is null or not (public.can_organize(ev.body_id) or public.event_role(p_event) = 'chief') then raise exception 'not allowed'; end if;
  insert into public.event_entries (event_id, car_number, driver, codriver, class, logbook_id, vehicle, email)
  values (p_event, p ->> 'carNumber', p ->> 'driver', p ->> 'codriver', p ->> 'class', nullif(p ->> 'logbookId', '')::uuid, p -> 'vehicle',
    nullif(lower(trim(p ->> 'email')), ''))
  on conflict (event_id, car_number) do update set driver = excluded.driver, codriver = excluded.codriver,
    class = excluded.class, logbook_id = excluded.logbook_id, vehicle = excluded.vehicle,
    -- An entry saved without an email keeps the one it had.
    email = coalesce(excluded.email, public.event_entries.email), updated_at = now()
  returning id into result;
  return result;
end $$;

-- PassTech: a competitor enters their car number and the tech sheet's car
-- and crew fill in from the event's entry list. Anyone may look a car up
-- for an event that hasn't ended -- what an entry list already shows
-- (names, class, car, logbook number), never the email. The VIN only for
-- the entry's own competitor or the logbook's owner (signed-in email).
create or replace function event_entry_lookup(p_event uuid, p_car text) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'carNumber', x.car_number, 'driver', x.driver, 'codriver', x.codriver, 'class', x.class,
    'make', coalesce(l.make, x.vehicle ->> 'make'), 'model', coalesce(l.model, x.vehicle ->> 'model'),
    'year', coalesce(l.year, x.vehicle ->> 'year'), 'color', x.vehicle ->> 'color',
    'logbookNumber', l.digital_number,
    'logbookBody', (select b.name from public.bodies b where b.id = l.issuing_body),
    'vin', case when public.current_email() is not null
                 and public.current_email() in (x.email, l.owner_email) then l.vin end))
  from public.event_entries x
  join public.events e on e.id = x.event_id
  left join public.logbooks l on l.id = x.logbook_id
  where x.event_id = p_event and e.cancelled_at is null and current_date <= e.ends_on
    and x.tech_status <> 'withdrawn' and lower(trim(x.car_number)) = lower(trim(p_car))
  limit 1
$$;
grant execute on function event_entry_lookup to anon, authenticated;

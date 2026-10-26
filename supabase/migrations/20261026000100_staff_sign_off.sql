-- Whether an event's staff member can sign its tech sheets off (Passed / Failed): the accreditation
-- they'd sign with -- the one for the event's body and discipline, else the body's all-disciplines
-- one, else their first active one (as save_tech_sheet picks it) -- holds sign_off_tech_sheets.
-- event_bundle gives it per staff member (canSignOff), so the event page can warn when nobody can.
create or replace function staff_can_sign_off(ev public.events, p_email text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((
    select public.accreditation_can(a, 'sign_off_tech_sheets') from public.accreditations a
    where a.email = lower(p_email) and public.accreditation_active(a)
    order by (a.body_id = ev.body_id and a.discipline is not distinct from ev.discipline and ev.discipline is not null) desc,
             (a.body_id = ev.body_id and a.discipline is null) desc,
             (a.body_id = ev.body_id) desc, a.granted_at
    limit 1), false)
$$;

revoke execute on function staff_can_sign_off from public, anon, authenticated;

create or replace function event_bundle(p_event uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  ev public.events;
begin
  select * into ev from public.events where id = p_event;
  if ev.id is null or not (public.event_role(p_event) is not null or public.can_organize(ev.body_id)) then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'event', to_jsonb(ev),
    'staff', (select coalesce(jsonb_agg(to_jsonb(s) || jsonb_build_object('canSignOff', public.staff_can_sign_off(ev, s.email))), '[]'::jsonb)
      from public.event_staff s where s.event_id = p_event),
    'entries', (select coalesce(jsonb_agg(jsonb_build_object(
        'entry', to_jsonb(x),
        'logbook', (select to_jsonb(l) - 'public_token' from public.logbooks l where l.id = x.logbook_id),
        'records', (select coalesce(jsonb_agg(to_jsonb(r) order by r.seq), '[]'::jsonb) from public.records r where r.logbook_id = x.logbook_id)
      ) order by x.car_number), '[]'::jsonb)
      from public.event_entries x where x.event_id = p_event),
    'techTemplate', public.template_json(public.event_tech_template(p_event)),
    'techTemplates', public.event_tech_templates(p_event),
    'techSheets', (select coalesce(jsonb_agg(public.tech_sheet_json(s) order by s.car_number), '[]'::jsonb)
      from public.tech_sheets s where s.event_id = p_event));
end $$;

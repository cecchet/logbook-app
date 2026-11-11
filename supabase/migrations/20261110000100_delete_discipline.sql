-- Deleting a discipline that has nothing recorded under it (one added by mistake, or to try
-- things out): System admins and the body's all-disciplines technical directors.
--  - Refused while it has stickers, sticker applications, events (and so tech sheets), annual
--    inspections, or scrutineers who aren't deleted.
--  - Its deleted scrutineers' accreditations go with it -- unless one signed a logbook record or
--    a sticker (then it's refused: archive the discipline instead).

create or replace function delete_discipline(p_body text, p_id text) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  what text;
begin
  if not (public.is_admin() or exists (select 1 from public.accreditations a where a.email = public.current_email() and a.body_id = p_body
          and a.discipline is null and a.role = 'technical_director' and public.accreditation_active(a))) then
    raise exception 'only Frog Racing and the body''s technical directors manage its disciplines';
  end if;
  if not exists (select 1 from public.body_disciplines d where d.body_id = p_body and d.id = p_id) then
    raise exception 'no such discipline';
  end if;
  what := concat_ws(', ',
    case when exists (select 1 from public.stickers s where s.body_id = p_body and s.discipline = p_id) then 'stickers' end,
    case when exists (select 1 from public.sticker_applications x where x.body_id = p_body and x.discipline = p_id) then 'sticker applications' end,
    case when exists (select 1 from public.events e where e.body_id = p_body and e.discipline = p_id) then 'events' end,
    case when exists (select 1 from public.tech_sheets t where t.body_id = p_body and t.discipline = p_id) then 'annual inspections' end,
    case when exists (select 1 from public.accreditations a where a.body_id = p_body and a.discipline = p_id and a.deleted_at is null) then 'scrutineers (delete them first)' end,
    case when exists (select 1 from public.accreditations a where a.body_id = p_body and a.discipline = p_id
                      and (exists (select 1 from public.records r where r.accreditation_id = a.id)
                           or exists (select 1 from public.stickers s where s.accreditation_id = a.id))) then 'logbook records or stickers signed under it' end);
  if what <> '' then
    raise exception 'this discipline has %: it can''t be deleted -- archive it instead', what;
  end if;
  delete from public.accreditations where body_id = p_body and discipline = p_id;
  delete from public.body_disciplines where body_id = p_body and id = p_id;
end $$;

revoke all on function delete_discipline(text, text) from public, anon;
grant execute on function delete_discipline(text, text) to authenticated;

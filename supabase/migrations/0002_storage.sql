-- Algdokumentide (arvete PDF-id, tšekid) hoidla. Faile kustutada ei saa,
-- sest raamatupidamise algdokumente tuleb säilitada 7 aastat.
-- Faili tee: <ettevõtte id>/<suvaline id>-<failinimi>

create or replace function app.uuid_or_null(p text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  return p::uuid;
exception when others then
  return null;
end $$;
grant execute on function app.uuid_or_null(text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 10485760,
        array['application/pdf','image/png','image/jpeg','image/webp','application/xml','text/xml'])
on conflict (id) do nothing;

create policy documents_read on storage.objects for select to authenticated
  using (bucket_id = 'documents' and app.is_member(app.uuid_or_null((storage.foldername(name))[1])));

create policy documents_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and app.is_member(app.uuid_or_null((storage.foldername(name))[1]), true));

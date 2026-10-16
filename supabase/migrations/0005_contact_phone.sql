-- Kliendi telefon (eraisikutele ja ettevõtetele)
alter table public.contacts add column if not exists phone text not null default '';

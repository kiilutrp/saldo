-- Arve kujundus: põhivärv ja logo (logo salvestatakse väikese pildina otse ettevõtte andmetesse).
alter table public.companies
  add column if not exists invoice_color text not null default '#1C5DC2'
    check (invoice_color ~* '^#[0-9a-f]{6}$'),
  add column if not exists logo text
    check (logo is null or (logo like 'data:image/%' and length(logo) <= 400000));

grant update (invoice_color, logo) on public.companies to authenticated;

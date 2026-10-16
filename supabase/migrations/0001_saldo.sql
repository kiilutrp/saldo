-- =====================================================================
-- Saldo raamatupidamine · andmebaasi skeem (Supabase / PostgreSQL 15+)
--
-- Põhimõtted
--   * Iga ettevõtte andmed on eraldatud (Row Level Security).
--   * Kandeid (journal_entries, journal_lines) ei saa muuta ega kustutada.
--     Vead parandatakse stornokandega.
--   * Iga kande deebet ja kreedit peavad olema võrdsed (kontrollitakse
--     tehingu lõpus).
--   * Kirjendamine käib ainult serveri funktsioonide kaudu, et dokumendid
--     ja kanded oleksid alati kooskõlas.
--   * Suletud perioodi (lock_date) kandeid lisada ei saa.
--   * Kui kasutajal on kaheastmeline kinnitus seadistatud, nõutakse seda
--     ka andmebaasi tasemel.
-- =====================================================================

create schema if not exists app;

-- ---------------------------------------------------------------------
-- Tabelid
-- ---------------------------------------------------------------------
create table public.companies (
  id                uuid primary key default gen_random_uuid(),
  name              text not null default '',
  regcode           text not null default '',
  vatno             text not null default '',
  address           text not null default '',
  email             text not null default '',
  phone             text not null default '',
  bank              text not null default '',
  iban              text not null default '',
  invoice_prefix    text not null default (to_char(now(), 'YYYY') || '-'),
  payment_term_days int  not null default 14 check (payment_term_days between 0 and 365),
  vat_payer         boolean not null default true,
  lock_date         date,
  created_at        timestamptz not null default now(),
  created_by        uuid default auth.uid()
);

create table public.company_members (
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('owner','accountant','viewer')),
  created_at timestamptz not null default now(),
  primary key (company_id, user_id)
);

create table public.accounts (
  company_id uuid not null references public.companies(id) on delete cascade,
  code       text not null check (code ~ '^[0-9]{3,6}$'),
  name       text not null,
  type       char(1) not null check (type in ('A','L','E','R','X')),
  is_system  boolean not null default false,
  active     boolean not null default true,
  primary key (company_id, code)
);

create table public.contacts (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name       text not null check (length(trim(name)) > 0),
  kind       text not null default 'client' check (kind in ('client','supplier','both')),
  regcode    text not null default '',
  vatno      text not null default '',
  email      text not null default '',
  address    text not null default '',
  peppol_id  text not null default '',
  einvoice   boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.contacts (company_id, name);

create table public.journal_entries (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  no          bigint not null,
  date        date not null,
  description text not null default '',
  source      text not null check (source in ('invoice','payment','expense','manual','vat','vatpay','reversal','import')),
  source_id   uuid,
  source_ref  text,
  reversal_of uuid unique references public.journal_entries(id),
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  unique (company_id, no)
);
create index on public.journal_entries (company_id, date);
create unique index journal_entries_vat_once on public.journal_entries (company_id, source, source_ref)
  where source in ('vat','vatpay') and source_ref is not null;

create table public.journal_lines (
  id         bigint generated always as identity primary key,
  entry_id   uuid not null references public.journal_entries(id),
  company_id uuid not null,
  account    text not null,
  debit      numeric(14,2) not null default 0 check (debit  >= 0),
  credit     numeric(14,2) not null default 0 check (credit >= 0),
  check (not (debit > 0 and credit > 0)),
  check (debit > 0 or credit > 0),
  foreign key (company_id, account) references public.accounts(company_id, code)
);
create index on public.journal_lines (entry_id);
create index on public.journal_lines (company_id, account);

create table public.invoices (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  kind         text not null default 'invoice' check (kind in ('invoice','credit')),
  credit_of    uuid references public.invoices(id),
  no           text not null check (length(trim(no)) > 0),
  status       text not null default 'draft' check (status in ('draft','issued')),
  contact_id   uuid references public.contacts(id) on delete set null,
  contact_name text not null,
  date         date not null,
  due          date not null,
  buyer_ref    text not null default '',
  notes        text not null default '',
  ref_no       text not null default '',
  net          numeric(14,2) not null default 0,
  vat          numeric(14,2) not null default 0,
  gross        numeric(14,2) not null default 0,
  entry_id     uuid references public.journal_entries(id),
  credited_by  uuid references public.invoices(id),
  e_sent       date,
  issued_at    timestamptz,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid(),
  updated_at   timestamptz not null default now(),
  unique (company_id, no),
  check (due >= date)
);
create index on public.invoices (company_id, date);

create table public.invoice_lines (
  id          bigint generated always as identity primary key,
  invoice_id  uuid not null references public.invoices(id) on delete cascade,
  company_id  uuid not null,
  position    int  not null,
  description text not null check (length(trim(description)) > 0),
  qty         numeric(14,4) not null,
  unit        text not null default 'tk',
  price       numeric(14,4) not null,
  vat_rate    numeric(5,2) not null check (vat_rate >= 0 and vat_rate < 100),
  account     text not null default '4000',
  foreign key (company_id, account) references public.accounts(company_id, code)
);
create index on public.invoice_lines (invoice_id);

create table public.expenses (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id),
  contact_id      uuid references public.contacts(id) on delete set null,
  supplier        text not null check (length(trim(supplier)) > 0),
  doc_no          text not null default '',
  date            date not null,
  due             date not null,
  account         text not null,
  description     text not null default '',
  gross           numeric(14,2) not null check (gross > 0),
  vat_rate        numeric(5,2) not null default 0 check (vat_rate >= 0 and vat_rate < 100),
  net             numeric(14,2) not null,
  vat             numeric(14,2) not null,
  status          text not null default 'active' check (status in ('active','cancelled')),
  entry_id        uuid references public.journal_entries(id),
  attachment_path text,
  created_at      timestamptz not null default now(),
  created_by      uuid default auth.uid(),
  updated_at      timestamptz not null default now(),
  foreign key (company_id, account) references public.accounts(company_id, code)
);
create index on public.expenses (company_id, date);

create table public.payments (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  invoice_id  uuid references public.invoices(id),
  expense_id  uuid references public.expenses(id),
  date        date not null,
  amount      numeric(14,2) not null check (amount > 0),
  account     text not null default '1020',
  note        text not null default '',
  status      text not null default 'active' check (status in ('active','cancelled')),
  entry_id    uuid references public.journal_entries(id),
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  check ((invoice_id is null) <> (expense_id is null)),
  foreign key (company_id, account) references public.accounts(company_id, code)
);
create index on public.payments (invoice_id);
create index on public.payments (expense_id);

create table public.audit_log (
  id         bigint generated always as identity primary key,
  company_id uuid,
  tbl        text not null,
  row_id     text not null,
  action     text not null,
  old_data   jsonb,
  new_data   jsonb,
  user_id    uuid default auth.uid(),
  at         timestamptz not null default now()
);
create index on public.audit_log (company_id, at desc);

-- ---------------------------------------------------------------------
-- Abifunktsioonid
-- ---------------------------------------------------------------------

-- Kaheastmeline kinnitus: kui kasutajal on kinnitatud tegur, peab seanss olema aal2.
create or replace function app.mfa_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (select 1 from auth.mfa_factors f
                      where f.user_id = auth.uid() and f.status = 'verified');
$$;

create or replace function app.is_member(p_company uuid, p_write boolean default false) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
     and app.mfa_ok()
     and exists (select 1 from public.company_members m
                  where m.company_id = p_company and m.user_id = auth.uid()
                    and (not p_write or m.role in ('owner','accountant')));
$$;

create or replace function app.check_contact(p_company uuid, p_contact uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_contact is not null and not exists (select 1 from public.contacts where id = p_contact and company_id = p_company) then
    raise exception 'Partnerit ei leitud.' using errcode = 'P0001';
  end if;
end $$;

create or replace function app.require_member(p_company uuid, p_write boolean default true) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_member(p_company, p_write) then
    raise exception 'Sul pole selle ettevõtte andmete muutmiseks õigust.' using errcode = '42501';
  end if;
end $$;

-- Eesti viitenumber (meetod 7-3-1)
create or replace function app.ref_no(p_no text) returns text
language plpgsql immutable set search_path = '' as $$
declare b text; s int := 0; i int; w int[] := array[7,3,1];
begin
  b := ltrim(regexp_replace(coalesce(p_no,''), '\D', '', 'g'), '0');
  if b = '' then return ''; end if;
  if length(b) < 2 then b := '1' || b; end if;
  b := right(b, 19);
  for i in 0 .. length(b) - 1 loop
    s := s + substr(b, length(b) - i, 1)::int * w[(i % 3) + 1];
  end loop;
  return b || ((10 - s % 10) % 10)::text;
end $$;

-- Kande koostamine. p_lines: [{"account":"1020","debit":10}, {"account":"3000","credit":10}]
-- Summa võib olla negatiivne; siis pööratakse pool ümber.
create or replace function app.post_entry(p_company uuid, p_date date, p_desc text, p_source text,
                                          p_source_id uuid, p_lines jsonb, p_source_ref text default null,
                                          p_reversal_of uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_no bigint; v_lock date; l jsonb; d numeric; k numeric; n int := 0;
begin
  select lock_date into v_lock from public.companies where id = p_company;
  if v_lock is not null and p_date <= v_lock then
    raise exception 'Periood on suletud kuni %. Kannet kuupäevaga % ei saa lisada.',
      to_char(v_lock,'DD.MM.YYYY'), to_char(p_date,'DD.MM.YYYY') using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('saldo-entry-' || p_company::text));
  select coalesce(max(no), 0) + 1 into v_no from public.journal_entries where company_id = p_company;
  insert into public.journal_entries (company_id, no, date, description, source, source_id, source_ref, reversal_of)
  values (p_company, v_no, p_date, coalesce(p_desc,''), p_source, p_source_id, p_source_ref, p_reversal_of)
  returning id into v_id;
  for l in select * from jsonb_array_elements(p_lines) loop
    d := round(coalesce((l->>'debit')::numeric, 0), 2);
    k := round(coalesce((l->>'credit')::numeric, 0), 2);
    if d < 0 then k := k - d; d := 0; end if;
    if k < 0 then d := d - k; k := 0; end if;
    if d > 0 and k > 0 then
      if d >= k then d := d - k; k := 0; else k := k - d; d := 0; end if;
    end if;
    continue when d = 0 and k = 0;
    insert into public.journal_lines (entry_id, company_id, account, debit, credit)
    values (v_id, p_company, l->>'account', d, k);
    n := n + 1;
  end loop;
  if n < 2 then
    raise exception 'Kandes peab olema vähemalt kaks rida summaga.' using errcode = 'P0001';
  end if;
  select coalesce(sum(debit),0), coalesce(sum(credit),0) into d, k from public.journal_lines where entry_id = v_id;
  if d <> k then
    raise exception 'Kanne ei ole tasakaalus: deebet %, kreedit %.', d, k using errcode = 'P0001';
  end if;
  return v_id;
end $$;

create or replace function app.reverse(p_entry uuid, p_date date, p_desc text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare e public.journal_entries; v_lines jsonb;
begin
  select * into e from public.journal_entries where id = p_entry;
  if e.id is null then raise exception 'Kannet ei leitud.'; end if;
  if exists (select 1 from public.journal_entries where reversal_of = p_entry) then
    raise exception 'Kanne nr % on juba stornitud.', e.no using errcode = 'P0001';
  end if;
  select jsonb_agg(jsonb_build_object('account', account, 'debit', credit, 'credit', debit) order by id)
    into v_lines from public.journal_lines where entry_id = p_entry;
  return app.post_entry(e.company_id, coalesce(p_date, current_date),
                        coalesce(p_desc, 'Storno: ' || e.description), 'reversal', e.source_id, v_lines, null, p_entry);
end $$;

-- ---------------------------------------------------------------------
-- Terviklikkuse päästikud
-- ---------------------------------------------------------------------
create or replace function app.forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception 'Kandeid ei saa muuta ega kustutada. Paranda viga stornokandega.' using errcode = 'P0001';
end $$;

create trigger journal_entries_immutable before update or delete on public.journal_entries
  for each row execute function app.forbid_change();
create trigger journal_lines_immutable before update or delete on public.journal_lines
  for each row execute function app.forbid_change();

create or replace function app.check_balance() returns trigger
language plpgsql as $$
declare d numeric; k numeric;
begin
  select coalesce(sum(debit),0), coalesce(sum(credit),0) into d, k
    from public.journal_lines where entry_id = new.entry_id;
  if d <> k then
    raise exception 'Kanne ei ole tasakaalus: deebet %, kreedit %.', d, k using errcode = 'P0001';
  end if;
  return null;
end $$;

create constraint trigger journal_lines_balanced after insert on public.journal_lines
  deferrable initially deferred for each row execute function app.check_balance();

create or replace function app.protect_invoice() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'issued' then
      raise exception 'Kinnitatud arvet ei saa kustutada. Koosta kreeditarve.' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if old.status = 'issued' then
    -- Kinnitatud arvel võib muutuda ainult e-arve saatmise märge ja kreeditarve viide.
    if (new.no, new.kind, new.contact_name, new.date, new.due, new.net, new.vat, new.gross, new.status, new.entry_id)
       is distinct from
       (old.no, old.kind, old.contact_name, old.date, old.due, old.net, old.vat, old.gross, old.status, old.entry_id) then
      raise exception 'Kinnitatud arvet ei saa muuta. Koosta kreeditarve.' using errcode = 'P0001';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger invoices_protect before update or delete on public.invoices
  for each row execute function app.protect_invoice();

create or replace function app.protect_invoice_lines() returns trigger
language plpgsql as $$
declare s text;
begin
  select status into s from public.invoices where id = coalesce(new.invoice_id, old.invoice_id);
  if s = 'issued' then
    raise exception 'Kinnitatud arve ridu ei saa muuta.' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;
create trigger invoice_lines_protect before insert or update or delete on public.invoice_lines
  for each row execute function app.protect_invoice_lines();

-- Audit
create or replace function app.audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r jsonb := to_jsonb(coalesce(new, old));
begin
  insert into public.audit_log (company_id, tbl, row_id, action, old_data, new_data)
  values (coalesce((r->>'company_id')::uuid, case when tg_table_name = 'companies' then (r->>'id')::uuid end),
          tg_table_name, coalesce(r->>'id', r->>'code', ''), lower(tg_op),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end $$;
create trigger audit_companies after insert or update on public.companies for each row execute function app.audit();
create trigger audit_contacts  after insert or update or delete on public.contacts for each row execute function app.audit();
create trigger audit_accounts  after insert or update on public.accounts for each row execute function app.audit();
create trigger audit_invoices  after insert or update or delete on public.invoices for each row execute function app.audit();
create trigger audit_expenses  after insert or update on public.expenses for each row execute function app.audit();
create trigger audit_payments  after insert or update on public.payments for each row execute function app.audit();

create or replace function app.touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger contacts_touch before update on public.contacts for each row execute function app.touch();
create trigger expenses_touch before update on public.expenses for each row execute function app.touch();

-- Kinnitatud perioodi kuupäeva saab muuta ainult omanik
create or replace function app.protect_company() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.lock_date is distinct from old.lock_date and not exists (
       select 1 from public.company_members where company_id = new.id and user_id = auth.uid() and role = 'owner') then
    raise exception 'Perioodi saab sulgeda ainult omanik.' using errcode = '42501';
  end if;
  if new.id <> old.id or new.created_by is distinct from old.created_by then
    raise exception 'Seda välja ei saa muuta.';
  end if;
  return new;
end $$;
create trigger companies_protect before update on public.companies for each row execute function app.protect_company();

-- ---------------------------------------------------------------------
-- Avalikud funktsioonid (kutsutakse rakendusest)
-- ---------------------------------------------------------------------

-- Uue ettevõtte loomine koos standardse kontoplaaniga
create or replace function public.create_company(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Logi sisse.' using errcode = '42501'; end if;
  if not app.mfa_ok() then raise exception 'Kinnita sisselogimine teise tegurina.' using errcode = '42501'; end if;
  insert into public.companies (name) values (coalesce(nullif(trim(p_name),''), 'Minu ettevõte')) returning id into v_id;
  insert into public.company_members (company_id, user_id, role) values (v_id, auth.uid(), 'owner');
  insert into public.accounts (company_id, code, name, type, is_system) values
    (v_id,'1000','Kassa','A',true),(v_id,'1020','Pangakonto','A',true),(v_id,'1210','Nõuded ostjate vastu','A',true),
    (v_id,'1520','Sisendkäibemaks','A',true),(v_id,'1700','Põhivara','A',false),
    (v_id,'2110','Võlad tarnijatele','L',true),(v_id,'2210','Käibemaksuvõlg','L',true),(v_id,'2300','Laenukohustused','L',false),
    (v_id,'2400','Võlg omanikule','L',false),
    (v_id,'3000','Osakapital','E',false),(v_id,'3100','Jaotamata kasum','E',false),
    (v_id,'4000','Müügitulu','R',true),(v_id,'4900','Muud tulud','R',false),
    (v_id,'5000','Kaubad ja materjal','X',false),(v_id,'6010','Rent ja kommunaalkulud','X',false),
    (v_id,'6020','Side ja internet','X',false),(v_id,'6030','Tarkvara ja IT','X',false),
    (v_id,'6040','Transport ja sõidukid','X',false),(v_id,'6050','Bürootarbed','X',false),
    (v_id,'6060','Raamatupidamis- ja õigusteenused','X',false),(v_id,'6070','Turundus ja reklaam','X',false),
    (v_id,'6080','Koolitus','X',false),(v_id,'6800','Pangateenustasud','X',false),(v_id,'6900','Muud tegevuskulud','X',false);
  return v_id;
end $$;

-- Müügiarve mustandi salvestamine. p: {id?, company_id, no, contact_id?, contact_name, date, due, buyer_ref, notes,
--   lines:[{description, qty, unit, price, vat_rate, account?}]}
create or replace function public.save_invoice_draft(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p->>'id','')::uuid; v_company uuid := (p->>'company_id')::uuid; l jsonb; i int := 0;
        v_status text; v_vp boolean;
begin
  perform app.require_member(v_company);
  perform app.check_contact(v_company, nullif(p->>'contact_id','')::uuid);
  select vat_payer into v_vp from public.companies where id = v_company;
  if v_id is not null then
    select status into v_status from public.invoices where id = v_id and company_id = v_company;
    if v_status is null then raise exception 'Arvet ei leitud.'; end if;
    if v_status = 'issued' then raise exception 'Kinnitatud arvet ei saa muuta. Koosta kreeditarve.' using errcode = 'P0001'; end if;
    update public.invoices set no = trim(p->>'no'), contact_id = nullif(p->>'contact_id','')::uuid,
      contact_name = trim(p->>'contact_name'), date = (p->>'date')::date, due = (p->>'due')::date,
      buyer_ref = coalesce(p->>'buyer_ref',''), notes = coalesce(p->>'notes',''), ref_no = app.ref_no(p->>'no')
    where id = v_id;
    delete from public.invoice_lines where invoice_id = v_id;
  else
    insert into public.invoices (company_id, no, contact_id, contact_name, date, due, buyer_ref, notes, ref_no)
    values (v_company, trim(p->>'no'), nullif(p->>'contact_id','')::uuid, trim(p->>'contact_name'),
            (p->>'date')::date, (p->>'due')::date, coalesce(p->>'buyer_ref',''), coalesce(p->>'notes',''), app.ref_no(p->>'no'))
    returning id into v_id;
  end if;
  for l in select * from jsonb_array_elements(coalesce(p->'lines','[]'::jsonb)) loop
    i := i + 1;
    if not v_vp and coalesce((l->>'vat_rate')::numeric,0) <> 0 then
      raise exception 'Ettevõte ei ole käibemaksukohustuslane, arvel ei saa olla käibemaksu.' using errcode = 'P0001';
    end if;
    insert into public.invoice_lines (invoice_id, company_id, position, description, qty, unit, price, vat_rate, account)
    values (v_id, v_company, i, trim(l->>'description'), (l->>'qty')::numeric, coalesce(nullif(l->>'unit',''),'tk'),
            (l->>'price')::numeric, coalesce((l->>'vat_rate')::numeric,0), coalesce(nullif(l->>'account',''),'4000'));
  end loop;
  if i = 0 then raise exception 'Arvel peab olema vähemalt üks rida.' using errcode = 'P0001'; end if;
  perform app.recalc_invoice(v_id);
  return v_id;
end $$;

-- Summad EN 16931 järgi: käibemaks ümardatakse määra kaupa.
create or replace function app.recalc_invoice(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_net numeric := 0; v_vat numeric := 0; r record;
begin
  for r in select vat_rate, round(sum(round(qty * price, 2)), 2) as net
             from public.invoice_lines where invoice_id = p_id group by vat_rate loop
    v_net := v_net + r.net;
    v_vat := v_vat + round(r.net * r.vat_rate / 100, 2);
  end loop;
  update public.invoices set net = v_net, vat = v_vat, gross = v_net + v_vat where id = p_id;
end $$;

create or replace function app.post_invoice(p_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare inv public.invoices; v_lines jsonb; v_entry uuid;
begin
  select * into inv from public.invoices where id = p_id;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_lines from (
    select jsonb_build_object('account','1210','debit', inv.gross) as x
    union all
    select jsonb_build_object('account', account, 'credit', round(sum(round(qty * price, 2)), 2))
      from public.invoice_lines where invoice_id = p_id group by account
    union all
    select jsonb_build_object('account','2210','credit', inv.vat) where inv.vat <> 0
  ) s;
  v_entry := app.post_entry(inv.company_id, inv.date,
               (case when inv.kind = 'credit' then 'Kreeditarve ' else 'Müügiarve ' end) || inv.no || ' · ' || inv.contact_name,
               'invoice', inv.id, v_lines);
  return v_entry;
end $$;

-- Arve kinnitamine: arve muutub lõplikuks ja kirjendatakse.
create or replace function public.issue_invoice(p_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare inv public.invoices; v_entry uuid;
begin
  select * into inv from public.invoices where id = p_id for update;
  if inv.id is null then raise exception 'Arvet ei leitud.'; end if;
  perform app.require_member(inv.company_id);
  if inv.status = 'issued' then return inv.entry_id; end if;
  perform app.recalc_invoice(p_id);
  v_entry := app.post_invoice(p_id);
  update public.invoices set status = 'issued', entry_id = v_entry, issued_at = now() where id = p_id;
  return v_entry;
end $$;

create or replace function public.delete_invoice_draft(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare inv public.invoices;
begin
  select * into inv from public.invoices where id = p_id;
  if inv.id is null then return; end if;
  perform app.require_member(inv.company_id);
  delete from public.invoices where id = p_id; -- päästik keelab kinnitatud arve kustutamise
end $$;

-- Kreeditarve: tühistab kinnitatud arve täies ulatuses.
create or replace function public.credit_invoice(p_id uuid, p_no text, p_date date default current_date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare inv public.invoices; v_new uuid; v_entry uuid;
begin
  select * into inv from public.invoices where id = p_id for update;
  if inv.id is null then raise exception 'Arvet ei leitud.'; end if;
  perform app.require_member(inv.company_id);
  if inv.status <> 'issued' or inv.kind <> 'invoice' then raise exception 'Krediteerida saab ainult kinnitatud müügiarvet.' using errcode = 'P0001'; end if;
  if inv.credited_by is not null then raise exception 'Arve on juba krediteeritud.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.payments where invoice_id = p_id and status = 'active') then
    raise exception 'Arvel on laekumisi. Tühista enne laekumised või tagasta raha eraldi kandega.' using errcode = 'P0001';
  end if;
  insert into public.invoices (company_id, kind, credit_of, no, contact_id, contact_name, date, due, buyer_ref, notes, ref_no)
  values (inv.company_id, 'credit', inv.id, trim(p_no), inv.contact_id, inv.contact_name, p_date, p_date,
          inv.buyer_ref, 'Kreeditarve arvele ' || inv.no, app.ref_no(p_no))
  returning id into v_new;
  insert into public.invoice_lines (invoice_id, company_id, position, description, qty, unit, price, vat_rate, account)
  select v_new, company_id, position, description, -qty, unit, price, vat_rate, account
    from public.invoice_lines where invoice_id = p_id;
  perform app.recalc_invoice(v_new);
  v_entry := app.post_invoice(v_new);
  update public.invoices set status = 'issued', entry_id = v_entry, issued_at = now() where id = v_new;
  update public.invoices set credited_by = v_new where id = p_id;
  return v_new;
end $$;

create or replace function public.mark_einvoice_sent(p_id uuid, p_sent boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_company uuid;
begin
  select company_id into v_company from public.invoices where id = p_id;
  perform app.require_member(v_company);
  update public.invoices set e_sent = case when p_sent then current_date end where id = p_id;
end $$;

-- Ostuarve / kulu salvestamine. Muutmisel stornitakse vana kanne ja tehakse uus.
-- p: {id?, company_id, contact_id?, supplier, doc_no, date, due, account, description, gross, vat_rate, attachment_path?}
create or replace function public.save_expense(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p->>'id','')::uuid; v_company uuid := (p->>'company_id')::uuid;
        v_gross numeric := round((p->>'gross')::numeric, 2); v_rate numeric := coalesce((p->>'vat_rate')::numeric, 0);
        v_vat numeric; v_net numeric; v_vp boolean; old public.expenses; v_entry uuid; v_desc text;
begin
  perform app.require_member(v_company);
  perform app.check_contact(v_company, nullif(p->>'contact_id','')::uuid);
  select vat_payer into v_vp from public.companies where id = v_company;
  if not v_vp then v_rate := 0; end if;
  v_vat := round(v_gross * v_rate / (100 + v_rate), 2);
  v_net := v_gross - v_vat;
  if v_id is not null then
    select * into old from public.expenses where id = v_id and company_id = v_company for update;
    if old.id is null then raise exception 'Kulu ei leitud.'; end if;
    if old.status <> 'active' then raise exception 'Tühistatud kulu ei saa muuta.' using errcode = 'P0001'; end if;
    if v_gross < (select coalesce(sum(amount),0) from public.payments where expense_id = v_id and status = 'active') then
      raise exception 'Kulu on juba tasutud suuremas summas. Tühista enne tasumine või sisesta summa, mis ei ole väiksem kui tasutud osa.' using errcode = 'P0001';
    end if;
    perform app.reverse(old.entry_id, (p->>'date')::date, 'Storno (kulu muudetud): ' || old.supplier);
    update public.expenses set contact_id = nullif(p->>'contact_id','')::uuid, supplier = trim(p->>'supplier'),
      doc_no = coalesce(p->>'doc_no',''), date = (p->>'date')::date, due = coalesce(nullif(p->>'due','')::date, (p->>'date')::date),
      account = p->>'account', description = coalesce(p->>'description',''), gross = v_gross, vat_rate = v_rate,
      net = v_net, vat = v_vat, attachment_path = coalesce(nullif(p->>'attachment_path',''), old.attachment_path)
    where id = v_id;
  else
    insert into public.expenses (company_id, contact_id, supplier, doc_no, date, due, account, description, gross, vat_rate, net, vat, attachment_path)
    values (v_company, nullif(p->>'contact_id','')::uuid, trim(p->>'supplier'), coalesce(p->>'doc_no',''), (p->>'date')::date,
            coalesce(nullif(p->>'due','')::date, (p->>'date')::date), p->>'account', coalesce(p->>'description',''),
            v_gross, v_rate, v_net, v_vat, nullif(p->>'attachment_path',''))
    returning id into v_id;
  end if;
  v_desc := 'Ostuarve ' || coalesce(nullif(p->>'doc_no','') || ' ', '') || '· ' || trim(p->>'supplier');
  v_entry := app.post_entry(v_company, (p->>'date')::date, v_desc, 'expense', v_id,
    jsonb_build_array(jsonb_build_object('account', p->>'account', 'debit', v_net),
                      jsonb_build_object('account', '1520', 'debit', v_vat),
                      jsonb_build_object('account', '2110', 'credit', v_gross)));
  update public.expenses set entry_id = v_entry where id = v_id;
  return v_id;
end $$;

create or replace function public.cancel_expense(p_id uuid, p_date date default current_date) returns void
language plpgsql security definer set search_path = '' as $$
declare x public.expenses;
begin
  select * into x from public.expenses where id = p_id for update;
  if x.id is null then raise exception 'Kulu ei leitud.'; end if;
  perform app.require_member(x.company_id);
  if x.status <> 'active' then return; end if;
  if exists (select 1 from public.payments where expense_id = p_id and status = 'active') then
    raise exception 'Kulul on tasumisi. Tühista enne tasumised.' using errcode = 'P0001';
  end if;
  perform app.reverse(x.entry_id, greatest(p_date, x.date), 'Storno (kulu tühistatud): ' || x.supplier);
  update public.expenses set status = 'cancelled' where id = p_id;
end $$;

-- Laekumine või tasumine
create or replace function public.add_payment(p_company uuid, p_invoice uuid, p_expense uuid, p_date date,
                                              p_amount numeric, p_account text default '1020', p_note text default '')
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_entry uuid; inv public.invoices; x public.expenses; v_open numeric;
begin
  perform app.require_member(p_company);
  if p_amount is null or p_amount <= 0 then raise exception 'Summa peab olema suurem kui null.' using errcode = 'P0001'; end if;
  if p_account not in (select code from public.accounts where company_id = p_company and type = 'A') then
    raise exception 'Makse konto peab olema varakonto (nt 1020 Pangakonto).' using errcode = 'P0001';
  end if;
  if p_invoice is not null then
    select * into inv from public.invoices where id = p_invoice and company_id = p_company;
    if inv.id is null or inv.status <> 'issued' or inv.kind <> 'invoice' then
      raise exception 'Laekumise saab märkida ainult kinnitatud müügiarvele.' using errcode = 'P0001';
    end if;
    select inv.gross - coalesce(sum(amount),0) into v_open from public.payments where invoice_id = p_invoice and status = 'active';
    if round(p_amount,2) > v_open then
      raise exception 'Summa ületab arve tasumata osa (%).', v_open using errcode = 'P0001';
    end if;
    insert into public.payments (company_id, invoice_id, date, amount, account, note)
    values (p_company, p_invoice, p_date, round(p_amount,2), p_account, coalesce(p_note,'')) returning id into v_id;
    v_entry := app.post_entry(p_company, p_date, 'Laekumine ' || inv.no || ' · ' || inv.contact_name, 'payment', v_id,
      jsonb_build_array(jsonb_build_object('account', p_account, 'debit', p_amount),
                        jsonb_build_object('account', '1210', 'credit', p_amount)));
  else
    select * into x from public.expenses where id = p_expense and company_id = p_company;
    if x.id is null or x.status <> 'active' then raise exception 'Kulu ei leitud.' using errcode = 'P0001'; end if;
    select x.gross - coalesce(sum(amount),0) into v_open from public.payments where expense_id = p_expense and status = 'active';
    if round(p_amount,2) > v_open then
      raise exception 'Summa ületab tasumata osa (%).', v_open using errcode = 'P0001';
    end if;
    insert into public.payments (company_id, expense_id, date, amount, account, note)
    values (p_company, p_expense, p_date, round(p_amount,2), p_account, coalesce(p_note,'')) returning id into v_id;
    v_entry := app.post_entry(p_company, p_date, 'Tasumine · ' || x.supplier, 'payment', v_id,
      jsonb_build_array(jsonb_build_object('account', '2110', 'debit', p_amount),
                        jsonb_build_object('account', p_account, 'credit', p_amount)));
  end if;
  update public.payments set entry_id = v_entry where id = v_id;
  return v_id;
end $$;

create or replace function public.cancel_payment(p_id uuid, p_date date default current_date) returns void
language plpgsql security definer set search_path = '' as $$
declare pm public.payments;
begin
  select * into pm from public.payments where id = p_id for update;
  if pm.id is null then raise exception 'Makset ei leitud.'; end if;
  perform app.require_member(pm.company_id);
  if pm.status <> 'active' then return; end if;
  perform app.reverse(pm.entry_id, greatest(p_date, pm.date), 'Storno (makse tühistatud)');
  update public.payments set status = 'cancelled' where id = p_id;
end $$;

-- Käsitsi kanne. p: {company_id, date, description, lines:[{account, debit, credit}]}
create or replace function public.create_manual_entry(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_company uuid := (p->>'company_id')::uuid;
begin
  perform app.require_member(v_company);
  if length(trim(coalesce(p->>'description',''))) = 0 then raise exception 'Lisa kande kirjeldus.' using errcode = 'P0001'; end if;
  return app.post_entry(v_company, (p->>'date')::date, trim(p->>'description'), 'manual', null, p->'lines');
end $$;

-- Storno. Dokumentidest tekkinud kandeid tühistatakse dokumendi kaudu.
create or replace function public.reverse_entry(p_id uuid, p_date date default current_date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare e public.journal_entries;
begin
  select * into e from public.journal_entries where id = p_id;
  if e.id is null then raise exception 'Kannet ei leitud.'; end if;
  perform app.require_member(e.company_id);
  if e.source not in ('manual','vat','vatpay','import') then
    raise exception 'See kanne on tekkinud dokumendist. Tühista see arve, kulu või makse kaudu.' using errcode = 'P0001';
  end if;
  return app.reverse(p_id, p_date, null);
end $$;

-- Käibemaksu tasaarveldus ja tasumine (üks kord kuu kohta)
create or replace function public.post_vat(p_company uuid, p_month text, p_kind text, p_amount numeric, p_date date)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_member(p_company);
  if p_month !~ '^\d{4}-\d{2}$' then raise exception 'Vigane kuu.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Summa peab olema suurem kui null.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.journal_entries where company_id = p_company and source_ref = p_month
               and source = case p_kind when 'settle' then 'vat' else 'vatpay' end) then
    raise exception 'See käibemaksu kanne on kuu % kohta juba kirjendatud.', p_month using errcode = 'P0001';
  end if;
  if p_kind = 'settle' then
    return app.post_entry(p_company, p_date, 'Käibemaksu tasaarveldus ' || p_month, 'vat', null,
      jsonb_build_array(jsonb_build_object('account','2210','debit',p_amount), jsonb_build_object('account','1520','credit',p_amount)), p_month);
  elsif p_kind = 'pay' then
    return app.post_entry(p_company, p_date, 'Käibemaksu tasumine EMTA-le ' || p_month, 'vatpay', null,
      jsonb_build_array(jsonb_build_object('account','2210','debit',p_amount), jsonb_build_object('account','1020','credit',p_amount)), p_month);
  end if;
  raise exception 'Tundmatu liik.';
end $$;

-- Andmete import Saldo prototüübist (JSON eksport)
create or replace function public.import_prototype(p_company uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c jsonb; i jsonb; x jsonb; j jsonb; l jsonb; map jsonb := '{}'::jsonb; v_id uuid; v_exp uuid; n_c int := 0; n_i int := 0; n_x int := 0; n_j int := 0; pos int;
begin
  perform app.require_member(p_company);
  for c in select * from jsonb_array_elements(coalesce(p->'contacts','[]')) loop
    select id into v_id from public.contacts where company_id = p_company and lower(name) = lower(trim(c->>'name')) limit 1;
    if v_id is null then
      insert into public.contacts (company_id, name, kind, regcode, vatno, email, address, peppol_id, einvoice)
      values (p_company, trim(c->>'name'), coalesce(nullif(c->>'type',''),'client'), coalesce(c->>'regcode',''), coalesce(c->>'vatno',''),
              coalesce(c->>'email',''), coalesce(c->>'address',''), coalesce(c->>'peppolId',''), coalesce((c->>'einvoice')::boolean,false))
      returning id into v_id; n_c := n_c + 1;
    end if;
    map := map || jsonb_build_object(c->>'id', v_id);
  end loop;
  for i in select * from jsonb_array_elements(coalesce(p->'invoices','[]')) order by value->>'date' loop
    continue when exists (select 1 from public.invoices where company_id = p_company and no = i->>'no');
    insert into public.invoices (company_id, no, contact_id, contact_name, date, due, buyer_ref, notes, ref_no, e_sent)
    values (p_company, i->>'no', nullif(map->>(i->>'contactId'),'')::uuid, i->>'contactName', (i->>'date')::date,
            greatest((i->>'due')::date, (i->>'date')::date), coalesce(i->>'buyerRef',''), coalesce(i->>'notes',''), app.ref_no(i->>'no'),
            nullif(i->>'eSent','')::date)
    returning id into v_id;
    pos := 0;
    for l in select * from jsonb_array_elements(i->'lines') loop
      pos := pos + 1;
      insert into public.invoice_lines (invoice_id, company_id, position, description, qty, unit, price, vat_rate)
      values (v_id, p_company, pos, coalesce(nullif(trim(l->>'desc'),''),'Rida'), coalesce((l->>'qty')::numeric,1), coalesce(nullif(l->>'unit',''),'tk'),
              coalesce((l->>'price')::numeric,0), coalesce((l->>'vat')::numeric,0));
    end loop;
    perform public.issue_invoice(v_id);
    if nullif(i->>'paidDate','') is not null then
      perform public.add_payment(p_company, v_id, null, (i->>'paidDate')::date, (select gross from public.invoices where id = v_id));
    end if;
    n_i := n_i + 1;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p->'expenses','[]')) order by value->>'date' loop
    v_exp := public.save_expense(jsonb_build_object('company_id', p_company, 'contact_id', map->>(x->>'contactId'),
      'supplier', x->>'supplier', 'doc_no', coalesce(x->>'docNo',''), 'date', x->>'date', 'due', coalesce(x->>'due', x->>'date'),
      'account', coalesce(x->>'account','6900'), 'description', coalesce(x->>'desc',''), 'gross', x->>'gross', 'vat_rate', coalesce(x->>'vatRate','0')));
    if nullif(x->>'paidDate','') is not null then
      perform public.add_payment(p_company, null, v_exp, (x->>'paidDate')::date, (select gross from public.expenses where id = v_exp));
    end if;
    n_x := n_x + 1;
  end loop;
  for j in select * from jsonb_array_elements(coalesce(p->'journal','[]')) order by value->>'date' loop
    perform app.post_entry(p_company, (j->>'date')::date, coalesce(j->>'desc','Import'), 'import', null,
      (select jsonb_agg(jsonb_build_object('account', e->>'acc', 'debit', coalesce((e->>'d')::numeric,0), 'credit', coalesce((e->>'k')::numeric,0)))
         from jsonb_array_elements(j->'lines') e));
    n_j := n_j + 1;
  end loop;
  return jsonb_build_object('contacts', n_c, 'invoices', n_i, 'expenses', n_x, 'journal', n_j);
end $$;

-- ---------------------------------------------------------------------
-- Vaated aruannete jaoks (RLS kehtib, security_invoker)
-- ---------------------------------------------------------------------
create view public.ledger with (security_invoker = true) as
  select e.company_id, e.id as entry_id, e.no, e.date, e.description, e.source, e.source_id, e.source_ref, e.reversal_of,
         l.id as line_id, l.account, a.name as account_name, a.type as account_type, l.debit, l.credit
    from public.journal_entries e
    join public.journal_lines l on l.entry_id = e.id
    join public.accounts a on a.company_id = l.company_id and a.code = l.account;

create view public.invoice_balances with (security_invoker = true) as
  select i.id, i.company_id,
         coalesce((select sum(p.amount) from public.payments p where p.invoice_id = i.id and p.status = 'active'), 0) as paid,
         i.gross - coalesce((select sum(p.amount) from public.payments p where p.invoice_id = i.id and p.status = 'active'), 0) as open
    from public.invoices i;

create view public.expense_balances with (security_invoker = true) as
  select x.id, x.company_id,
         coalesce((select sum(p.amount) from public.payments p where p.expense_id = x.id and p.status = 'active'), 0) as paid,
         x.gross - coalesce((select sum(p.amount) from public.payments p where p.expense_id = x.id and p.status = 'active'), 0) as open
    from public.expenses x;

-- ---------------------------------------------------------------------
-- Row Level Security ja õigused
-- ---------------------------------------------------------------------
alter table public.companies       enable row level security;
alter table public.company_members enable row level security;
alter table public.accounts        enable row level security;
alter table public.contacts        enable row level security;
alter table public.journal_entries enable row level security;
alter table public.journal_lines   enable row level security;
alter table public.invoices        enable row level security;
alter table public.invoice_lines   enable row level security;
alter table public.expenses        enable row level security;
alter table public.payments        enable row level security;
alter table public.audit_log       enable row level security;

create policy companies_read   on public.companies for select to authenticated using (app.is_member(id));
create policy companies_update on public.companies for update to authenticated using (app.is_member(id, true)) with check (app.is_member(id, true));
create policy members_read     on public.company_members for select to authenticated using (user_id = auth.uid() or app.is_member(company_id));
create policy accounts_read    on public.accounts for select to authenticated using (app.is_member(company_id));
create policy accounts_insert  on public.accounts for insert to authenticated with check (app.is_member(company_id, true) and not is_system);
create policy accounts_update  on public.accounts for update to authenticated using (app.is_member(company_id, true)) with check (app.is_member(company_id, true));
create policy contacts_read    on public.contacts for select to authenticated using (app.is_member(company_id));
create policy contacts_insert  on public.contacts for insert to authenticated with check (app.is_member(company_id, true));
create policy contacts_update  on public.contacts for update to authenticated using (app.is_member(company_id, true)) with check (app.is_member(company_id, true));
create policy contacts_delete  on public.contacts for delete to authenticated using (app.is_member(company_id, true));
create policy je_read          on public.journal_entries for select to authenticated using (app.is_member(company_id));
create policy jl_read          on public.journal_lines   for select to authenticated using (app.is_member(company_id));
create policy inv_read         on public.invoices      for select to authenticated using (app.is_member(company_id));
create policy invl_read        on public.invoice_lines for select to authenticated using (app.is_member(company_id));
create policy exp_read         on public.expenses      for select to authenticated using (app.is_member(company_id));
create policy pay_read         on public.payments      for select to authenticated using (app.is_member(company_id));
create policy audit_read       on public.audit_log     for select to authenticated using (app.is_member(company_id));

revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;
grant update (name, regcode, vatno, address, email, phone, bank, iban, invoice_prefix, payment_term_days, vat_payer, lock_date)
  on public.companies to authenticated;
grant insert on public.accounts to authenticated;
grant update (name, active) on public.accounts to authenticated;
grant insert, update, delete on public.contacts to authenticated;

grant usage on schema app to authenticated;
revoke all on all functions in schema app from public, anon;
grant execute on function app.mfa_ok(), app.is_member(uuid, boolean), app.ref_no(text) to authenticated;
revoke all on function public.create_company(text), public.save_invoice_draft(jsonb), public.issue_invoice(uuid),
  public.delete_invoice_draft(uuid), public.credit_invoice(uuid, text, date), public.mark_einvoice_sent(uuid, boolean),
  public.save_expense(jsonb), public.cancel_expense(uuid, date), public.add_payment(uuid, uuid, uuid, date, numeric, text, text),
  public.cancel_payment(uuid, date), public.create_manual_entry(jsonb), public.reverse_entry(uuid, date),
  public.post_vat(uuid, text, text, numeric, date), public.import_prototype(uuid, jsonb) from public, anon;
grant execute on function public.create_company(text), public.save_invoice_draft(jsonb), public.issue_invoice(uuid),
  public.delete_invoice_draft(uuid), public.credit_invoice(uuid, text, date), public.mark_einvoice_sent(uuid, boolean),
  public.save_expense(jsonb), public.cancel_expense(uuid, date), public.add_payment(uuid, uuid, uuid, date, numeric, text, text),
  public.cancel_payment(uuid, date), public.create_manual_entry(jsonb), public.reverse_entry(uuid, date),
  public.post_vat(uuid, text, text, numeric, date), public.import_prototype(uuid, jsonb) to authenticated;

-- Hinnapakkumised ja eraisikud
-- Pakkumine ei ole raamatupidamisdokument: seda saab vabalt muuta, kuni sellest pole arvet tehtud.

alter table public.contacts add column if not exists person boolean not null default false;

create table public.quotes (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  no           text not null check (length(trim(no)) > 0),
  status       text not null default 'draft' check (status in ('draft','sent','accepted','declined','invoiced')),
  contact_id   uuid references public.contacts(id) on delete set null,
  contact_name text not null,
  date         date not null,
  valid_until  date not null,
  notes        text not null default '',
  net          numeric(14,2) not null default 0,
  vat          numeric(14,2) not null default 0,
  gross        numeric(14,2) not null default 0,
  invoice_id   uuid references public.invoices(id) on delete set null,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid(),
  updated_at   timestamptz not null default now(),
  unique (company_id, no),
  check (valid_until >= date)
);
create index on public.quotes (company_id, date);

create table public.quote_lines (
  id          bigint generated always as identity primary key,
  quote_id    uuid not null references public.quotes(id) on delete cascade,
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
create index on public.quote_lines (quote_id);

create trigger quotes_touch before update on public.quotes for each row execute function app.touch();
create trigger audit_quotes after insert or update or delete on public.quotes for each row execute function app.audit();

create or replace function app.recalc_quote(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_net numeric := 0; v_vat numeric := 0; r record;
begin
  for r in select vat_rate, round(sum(round(qty * price, 2)), 2) as net
             from public.quote_lines where quote_id = p_id group by vat_rate loop
    v_net := v_net + r.net;
    v_vat := v_vat + round(r.net * r.vat_rate / 100, 2);
  end loop;
  update public.quotes set net = v_net, vat = v_vat, gross = v_net + v_vat where id = p_id;
end $$;

-- p: {id?, company_id, no, contact_id?, contact_name, date, valid_until, notes, lines:[{description, qty, unit, price, vat_rate, account?}]}
create or replace function public.save_quote(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p->>'id','')::uuid; v_company uuid := (p->>'company_id')::uuid; l jsonb; i int := 0;
        v_status text; v_vp boolean;
begin
  perform app.require_member(v_company);
  perform app.check_contact(v_company, nullif(p->>'contact_id','')::uuid);
  select vat_payer into v_vp from public.companies where id = v_company;
  if v_id is not null then
    select status into v_status from public.quotes where id = v_id and company_id = v_company;
    if v_status is null then raise exception 'Pakkumist ei leitud.'; end if;
    if v_status = 'invoiced' then raise exception 'Pakkumisest on juba arve tehtud, seda ei saa enam muuta.' using errcode = 'P0001'; end if;
    update public.quotes set no = trim(p->>'no'), contact_id = nullif(p->>'contact_id','')::uuid, contact_name = trim(p->>'contact_name'),
      date = (p->>'date')::date, valid_until = (p->>'valid_until')::date, notes = coalesce(p->>'notes','')
    where id = v_id;
    delete from public.quote_lines where quote_id = v_id;
  else
    insert into public.quotes (company_id, no, contact_id, contact_name, date, valid_until, notes)
    values (v_company, trim(p->>'no'), nullif(p->>'contact_id','')::uuid, trim(p->>'contact_name'),
            (p->>'date')::date, (p->>'valid_until')::date, coalesce(p->>'notes',''))
    returning id into v_id;
  end if;
  for l in select * from jsonb_array_elements(coalesce(p->'lines','[]'::jsonb)) loop
    i := i + 1;
    if not v_vp and coalesce((l->>'vat_rate')::numeric,0) <> 0 then
      raise exception 'Ettevõte ei ole käibemaksukohustuslane, pakkumisel ei saa olla käibemaksu.' using errcode = 'P0001';
    end if;
    insert into public.quote_lines (quote_id, company_id, position, description, qty, unit, price, vat_rate, account)
    values (v_id, v_company, i, trim(l->>'description'), (l->>'qty')::numeric, coalesce(nullif(l->>'unit',''),'tk'),
            (l->>'price')::numeric, coalesce((l->>'vat_rate')::numeric,0), coalesce(nullif(l->>'account',''),'4000'));
  end loop;
  if i = 0 then raise exception 'Pakkumisel peab olema vähemalt üks rida.' using errcode = 'P0001'; end if;
  perform app.recalc_quote(v_id);
  return v_id;
end $$;

create or replace function public.set_quote_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.quotes;
begin
  select * into q from public.quotes where id = p_id;
  if q.id is null then raise exception 'Pakkumist ei leitud.'; end if;
  perform app.require_member(q.company_id);
  if p_status not in ('draft','sent','accepted','declined') then raise exception 'Vigane olek.'; end if;
  if q.status = 'invoiced' then raise exception 'Pakkumisest on juba arve tehtud.' using errcode = 'P0001'; end if;
  update public.quotes set status = p_status where id = p_id;
end $$;

create or replace function public.delete_quote(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.quotes;
begin
  select * into q from public.quotes where id = p_id;
  if q.id is null then return; end if;
  perform app.require_member(q.company_id);
  if q.status = 'invoiced' then raise exception 'Pakkumisest on tehtud arve, seda ei saa kustutada.' using errcode = 'P0001'; end if;
  delete from public.quotes where id = p_id;
end $$;

-- Pakkumisest arve mustand. Tagastab arve id.
create or replace function public.quote_to_invoice(p_id uuid, p_no text, p_date date default current_date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare q public.quotes; v_inv uuid; v_term int;
begin
  select * into q from public.quotes where id = p_id for update;
  if q.id is null then raise exception 'Pakkumist ei leitud.'; end if;
  perform app.require_member(q.company_id);
  if q.status = 'invoiced' then raise exception 'Sellest pakkumisest on arve juba tehtud.' using errcode = 'P0001'; end if;
  select payment_term_days into v_term from public.companies where id = q.company_id;
  insert into public.invoices (company_id, no, contact_id, contact_name, date, due, notes, ref_no)
  values (q.company_id, trim(p_no), q.contact_id, q.contact_name, p_date, p_date + coalesce(v_term, 14),
          'Hinnapakkumise nr ' || q.no || ' alusel.', app.ref_no(p_no))
  returning id into v_inv;
  insert into public.invoice_lines (invoice_id, company_id, position, description, qty, unit, price, vat_rate, account)
  select v_inv, company_id, position, description, qty, unit, price, vat_rate, account from public.quote_lines where quote_id = p_id order by position;
  perform app.recalc_invoice(v_inv);
  update public.quotes set status = 'invoiced', invoice_id = v_inv where id = p_id;
  return v_inv;
end $$;

alter table public.quotes      enable row level security;
alter table public.quote_lines enable row level security;
create policy quotes_read  on public.quotes      for select to authenticated using (app.is_member(company_id));
create policy quotel_read  on public.quote_lines for select to authenticated using (app.is_member(company_id));

revoke all on public.quotes, public.quote_lines from anon, authenticated;
grant select on public.quotes, public.quote_lines to authenticated;
grant update (person) on public.contacts to authenticated;

revoke all on function app.recalc_quote(uuid) from public, anon;
revoke all on function public.save_quote(jsonb), public.set_quote_status(uuid, text), public.delete_quote(uuid),
  public.quote_to_invoice(uuid, text, date) from public, anon;
grant execute on function public.save_quote(jsonb), public.set_quote_status(uuid, text), public.delete_quote(uuid),
  public.quote_to_invoice(uuid, text, date) to authenticated;

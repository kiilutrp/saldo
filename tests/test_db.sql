-- Saldo andmebaasi testid. Käivita: psql -v ON_ERROR_STOP=1 -f test_db.sql
\set QUIET on
create schema if not exists t;
grant usage on schema t to authenticated;
create or replace function t.expect_fail(p_sql text, p_like text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not ilike '%' || p_like || '%' then
      raise exception 'Vale veateade: "%" (oodati "%")', sqlerrm, p_like;
    end if;
    raise notice 'OK (keelatud): %', p_like;
    return;
  end;
  raise exception 'Oodati viga, aga päring õnnestus: %', p_sql;
end $$;
create or replace function t.eq(a numeric, b numeric, msg text) returns void language plpgsql as $$
begin
  if a is distinct from b then raise exception 'FAIL %: % <> %', msg, a, b; end if;
  raise notice 'OK %: %', msg, a;
end $$;
grant execute on all functions in schema t to authenticated;

insert into auth.users values ('00000000-0000-0000-0000-00000000000a','a@test.ee'),('00000000-0000-0000-0000-00000000000b','b@test.ee');

-- ===== Kasutaja A =====
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","aal":"aal1"}', false);

select public.create_company('Test OÜ') as cid \gset
select set_config('t.cid', :'cid', false);
update public.companies set regcode='16000001', vatno='EE102000001', iban='EE382200221020145685' where id = :'cid';

insert into public.contacts (company_id, name, kind, regcode) values (:'cid', 'Klient AS', 'client', '14781230') returning id as kid \gset
select t.eq((select count(*) from public.accounts where company_id = :'cid'), 24, 'kontoplaan loodud');
select t.expect_fail(format($$update public.accounts set type = 'R' where company_id = %L and code = '6010'$$, :'cid'), 'permission denied');

-- Arve mustand: 3 rida, 24% ja 13% (EN 16931 ümardus määra kaupa)
select public.save_invoice_draft(jsonb_build_object('company_id', :'cid', 'no', '2026-001', 'contact_id', :'kid', 'contact_name', 'Klient AS',
  'date', '2026-09-03', 'due', '2026-09-17', 'lines', jsonb_build_array(
    jsonb_build_object('description','Teenus A','qty',1,'unit','tk','price',0.33,'vat_rate',24),
    jsonb_build_object('description','Teenus B','qty',1,'unit','tk','price',0.33,'vat_rate',24),
    jsonb_build_object('description','Majutus','qty',2,'unit','p','price',45.5,'vat_rate',13)))) as inv \gset
select t.eq((select net from public.invoices where id = :'inv'), 91.66, 'arve km-ta');
-- 0.66*24% = 0.1584 -> 0.16 (rea kaupa oleks 0.08+0.08=0.16); 91*13% = 11.83
select t.eq((select vat from public.invoices where id = :'inv'), 11.99, 'arve käibemaks');
select t.eq((select count(*) from public.journal_entries where company_id = :'cid'), 0, 'mustand pole kirjendatud');
select t.eq((select ref_no::numeric from public.invoices where id = :'inv'), 20260011, 'viitenumber');

select public.issue_invoice(:'inv');
select t.eq((select sum(debit) - sum(credit) from public.ledger where company_id = :'cid'), 0, 'pearaamat tasakaalus');
select t.eq((select sum(debit) from public.ledger where company_id = :'cid' and account = '1210'), 103.65, 'nõue ostja vastu');

select t.expect_fail($$update public.invoices set gross = 1 where no = '2026-001'$$, 'permission denied');
select t.expect_fail(format($$select public.save_invoice_draft(jsonb_build_object('id', %L, 'company_id', %L, 'no','2026-001','contact_name','X','date','2026-09-03','due','2026-09-17','lines','[{"description":"x","qty":1,"price":1,"vat_rate":24}]'::jsonb))$$, :'inv', :'cid'), 'Kinnitatud arvet ei saa muuta');
select t.expect_fail(format($$select public.delete_invoice_draft(%L)$$, :'inv'), 'Kinnitatud arvet ei saa kustutada');
select t.expect_fail($$delete from public.journal_lines$$, 'permission denied');

-- Laekumine: osaline, liiga suur, tühistamine
select public.add_payment(:'cid', :'inv', null, '2026-09-10', 50) as pay1 \gset
select t.expect_fail(format($$select public.add_payment(%L, %L, null, '2026-09-11', 60)$$, :'cid', :'inv'), 'ületab arve tasumata osa');
select t.eq((select open from public.invoice_balances where id = :'inv'), 53.65, 'arve tasumata osa');
select public.cancel_payment(:'pay1', '2026-09-12');
select t.eq((select open from public.invoice_balances where id = :'inv'), 103.65, 'pärast tühistamist');
select t.eq((select count(*) from public.journal_entries where company_id = :'cid' and source = 'reversal'), 1, 'storno tehtud');

-- Kreeditarve
select public.credit_invoice(:'inv', '2026-002', '2026-09-20') as cr \gset
select t.eq((select gross from public.invoices where id = :'cr'), -103.65, 'kreeditarve summa');
select t.eq((select coalesce(sum(debit),0) - coalesce(sum(credit),0) from public.ledger where company_id = :'cid' and account = '4000'), 0, 'müügitulu tühistatud');
select t.expect_fail(format($$select public.credit_invoice(%L, '2026-003')$$, :'inv'), 'juba krediteeritud');

-- Kulu: salvestamine, muutmine (storno + uus), tühistamine
select public.save_expense(jsonb_build_object('company_id', :'cid', 'supplier','Kontorikeskus AS','date','2026-09-01','account','6010','gross',372,'vat_rate',24)) as ex \gset
select t.eq((select vat from public.expenses where id = :'ex'), 72.00, 'sisendkäibemaks');
select public.save_expense(jsonb_build_object('id', :'ex', 'company_id', :'cid', 'supplier','Kontorikeskus AS','date','2026-09-01','account','6010','gross',248,'vat_rate',24));
select t.eq((select sum(debit) - sum(credit) from public.ledger where company_id = :'cid' and account = '6010'), 200.00, 'kulu pärast muutmist');
select public.add_payment(:'cid', null, :'ex', '2026-09-05', 248) as pay2 \gset
select t.expect_fail(format($$select public.cancel_expense(%L)$$, :'ex'), 'Kulul on tasumisi');
select t.expect_fail(format($$select public.save_expense(jsonb_build_object('id', %L, 'company_id', %L, 'supplier','Kontorikeskus AS','date','2026-09-01','account','6010','gross',100,'vat_rate',24))$$, :'ex', :'cid'), 'juba tasutud suuremas summas');
select t.eq((select sum(debit) - sum(credit) from public.ledger where company_id = :'cid' and account = '1020'), -248, 'pangakonto');

-- Käsitsi kanne: tasakaalust väljas, storno, topeltstorno, dokumendikande storno
select t.expect_fail(format($$select public.create_manual_entry(jsonb_build_object('company_id', %L, 'date','2026-08-01','description','Vale','lines', '[{"account":"1020","debit":100},{"account":"3000","credit":90}]'::jsonb))$$, :'cid'), 'ei ole tasakaalus');
select public.create_manual_entry(jsonb_build_object('company_id', :'cid', 'date','2026-08-01','description','Algsaldod',
  'lines', '[{"account":"1020","debit":3000},{"account":"3000","credit":2500},{"account":"3100","credit":500}]'::jsonb)) as man \gset
select public.reverse_entry(:'man', '2026-08-02');
select t.expect_fail(format($$select public.reverse_entry(%L)$$, :'man'), 'juba stornitud');
select t.expect_fail(format($$select public.reverse_entry(%L)$$, (select entry_id from public.expenses where id = :'ex')), 'tekkinud dokumendist');

-- Käibemaks kord kuus
select public.post_vat(:'cid', '2026-09', 'settle', 48, '2026-09-30');
select t.expect_fail(format($$select public.post_vat(%L, '2026-09', 'settle', 48, '2026-09-30')$$, :'cid'), 'juba kirjendatud');

-- Perioodi sulgemine
update public.companies set lock_date = '2026-09-30' where id = :'cid';
select t.expect_fail(format($$select public.create_manual_entry(jsonb_build_object('company_id', %L, 'date','2026-09-15','description','Hilja','lines','[{"account":"1020","debit":1},{"account":"3000","credit":1}]'::jsonb))$$, :'cid'), 'Periood on suletud');
select public.create_manual_entry(jsonb_build_object('company_id', :'cid', 'date','2026-10-01','description','Okt','lines','[{"account":"1020","debit":1},{"account":"3000","credit":1}]'::jsonb));

-- Import prototüübist
select public.import_prototype(:'cid', '{"contacts":[{"id":"c1","name":"Põhjala Disain OÜ","type":"client","regcode":"14567021"}],
  "invoices":[{"no":"P-001","date":"2026-10-02","due":"2026-10-16","contactId":"c1","contactName":"Põhjala Disain OÜ","paidDate":"2026-10-10",
     "lines":[{"desc":"Arendus","qty":10,"unit":"h","price":55,"vat":24}]}],
  "expenses":[{"supplier":"Linnaside AS","date":"2026-10-05","account":"6020","gross":31,"vatRate":24}],
  "journal":[{"date":"2026-10-03","desc":"Sissemakse","lines":[{"acc":"1020","d":100,"k":0},{"acc":"2400","d":0,"k":100}]}]}'::jsonb) as imp \gset
\echo import: :imp
select t.eq((select gross from public.invoices where no = 'P-001'), 682.00, 'imporditud arve');
select t.eq((select open from public.invoice_balances i join public.invoices v using (id) where v.no = 'P-001'), 0, 'imporditud arve tasutud');
select t.eq((select sum(debit) - sum(credit) from public.ledger where company_id = :'cid'), 0, 'pearaamat lõpuks tasakaalus');
select t.eq(((select count(*) from public.audit_log where company_id = :'cid') > 5)::int, 1, 'auditilogi');

-- Salvestusruum
insert into storage.objects (bucket_id, name) values ('documents', :'cid' || '/abc-arve.pdf');
select t.expect_fail($$insert into storage.objects (bucket_id, name) values ('documents', 'muu/abc.pdf')$$, 'row-level security');

-- ===== Kasutaja B ei näe A andmeid =====
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","aal":"aal1"}', false);
select t.eq((select count(*) from public.invoices), 0, 'B ei näe arveid');
select t.eq((select count(*) from public.ledger), 0, 'B ei näe pearaamatut');
select t.eq((select count(*) from storage.objects), 0, 'B ei näe faile');
select t.expect_fail(format($$select public.issue_invoice(%L)$$, (select current_setting('t.cid'))::uuid), 'Arvet ei leitud');
select t.expect_fail(format($$select public.create_manual_entry(jsonb_build_object('company_id', %L, 'date','2026-10-05','description','Häkk','lines','[{"account":"1020","debit":1},{"account":"3000","credit":1}]'::jsonb))$$, current_setting('t.cid')), 'pole selle ettevõtte');
update public.companies set name = 'Häkitud' where id = current_setting('t.cid')::uuid;
select t.expect_fail(format($$insert into public.contacts (company_id, name) values (%L, 'X')$$, current_setting('t.cid')), 'row-level security');

-- ===== Kaheastmeline kinnitus =====
reset role;
insert into auth.mfa_factors (user_id, status) values ('00000000-0000-0000-0000-00000000000a', 'verified');
select t.eq((select count(*) from public.companies where name = 'Häkitud'), 0, 'B ei saanud nime muuta');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","aal":"aal1"}', false);
select t.eq((select count(*) from public.invoices), 0, 'aal1 ei näe andmeid, kui MFA on seadistatud');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","aal":"aal2"}', false);
select t.eq(((select count(*) from public.invoices) > 0)::int, 1, 'aal2 näeb andmeid');
reset role;
\echo KÕIK TESTID LÄBITUD

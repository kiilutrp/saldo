"""Otsast lõpuni test päris brauseris (Chromium) päris andmebaasi vastu.
Käivitus: python3 tests/e2e/run.py  (eeldab kohalikku PostgreSQL-i, vt tests/run_db_tests.sh)
"""
import json, os, subprocess, sys, time, re
from playwright.sync_api import sync_playwright, expect

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.environ.get('E2E_OUT', '/tmp/saldo-e2e')
os.makedirs(OUT, exist_ok=True)
PORT = 8765
BASE = f'http://127.0.0.1:{PORT}'
env = {**os.environ, 'PGHOST': os.environ.get('PGHOST', '/tmp/pgsaldo'), 'PGPORT': os.environ.get('PGPORT', '54329')}
P = ['psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q']

def sh(args, **kw):
    subprocess.run(args, check=True, env=env, cwd=ROOT, **kw)

# Puhas andmebaas
sh(P + ['-c', 'drop database if exists saldo_e2e'], stdout=subprocess.DEVNULL)
sh(P + ['-c', 'create database saldo_e2e'], stdout=subprocess.DEVNULL)
for f in ['tests/supabase_stub.sql'] + sorted('supabase/migrations/' + m for m in os.listdir(os.path.join(ROOT, 'supabase/migrations'))):
    sh(P + ['-d', 'saldo_e2e', '-f', f])

srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'server.py'), str(PORT)], env={**env, 'PGDATABASE': 'saldo_e2e'})
time.sleep(1)
MOCK = open(os.path.join(HERE, 'mock-supabase.js')).read()
errors = []
step_no = [0]

def step(name):
    step_no[0] += 1
    print(f'  {step_no[0]:2}. {name}')

def shot(page, name):
    page.screenshot(path=f'{OUT}/{name}.png', full_page=True)

def toast(page, text):
    try:
        expect(page.locator('#toast')).to_contain_text(text, timeout=8000)
    except AssertionError:
        err = page.locator('#fErr').all_inner_texts() if page.locator('#fErr').count() else []
        shot(page, 'FAIL'); print('      #fErr:', err, '| toast:', page.locator('#toast').inner_text()); raise

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={'width': 1280, 'height': 900}, accept_downloads=True, locale='et-EE')
        ctx.route(re.compile(r'https://cdn\.jsdelivr\.net/npm/@supabase/supabase-js.*'), lambda r: r.fulfill(status=200, content_type='application/javascript', body=MOCK))
        ctx.route(re.compile(r'https://fonts\.(googleapis|gstatic)\.com/.*'), lambda r: r.abort())
        ctx.route(f'{BASE}/config.js', lambda r: r.fulfill(status=200, content_type='application/javascript',
                  body="window.SALDO_CONFIG={url:'http://127.0.0.1',anonKey:'test-anon-key'};"))
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
        page.on('console', lambda m: m.type == 'error' and errors.append(f'console: {m.text}'))

        step('Konto loomine ja ettevõtte lisamine')
        page.goto(BASE + '/index.html')
        expect(page.get_by_role('heading', name='Logi sisse')).to_be_visible()
        shot(page, '01-login')
        page.get_by_role('button', name='Loo uus konto').click()
        page.fill('#aEmail', 'angela@test.ee'); page.fill('#aPass', 'salasona123'); page.fill('#aPass2', 'salasona123')
        page.get_by_role('button', name='Loo konto').click()
        expect(page.get_by_role('heading', name='Lisa oma ettevõte')).to_be_visible()
        page.fill('#oName', 'Angela Disain OÜ')
        page.get_by_role('button', name='Loo raamatupidamine').click()
        expect(page.get_by_role('heading', name='Seaded')).to_be_visible()

        step('Ettevõtte andmed')
        page.fill('#coR', '16000001'); page.fill('#coV', 'EE102000001'); page.fill('#coA', 'Tänav 1, 10111 Tallinn')
        page.fill('#coI', 'EE382200221020145685'); page.fill('#coB', 'Swedbank'); page.fill('#coE', 'angela@test.ee')
        page.get_by_role('button', name='Salvesta', exact=True).first.click()
        toast(page, 'Seaded salvestatud')

        step('Arve kujundus: logo ja värv')
        page.set_input_files('#logoFile', os.path.join(HERE, 'logo.png'))
        toast(page, 'Logo salvestatud')
        page.get_by_role('button', name='Värv #1F2937').click()
        page.get_by_role('button', name='Salvesta värv').click()
        toast(page, 'Arve värv salvestatud')
        page.get_by_role('button', name='Vaata näidist').click()
        expect(page.frame_locator('.docframe').locator('img.logo')).to_be_visible()
        page.get_by_role('button', name='Sulge').click()

        step('Algsaldo käsitsi kandena')
        page.get_by_role('button', name='Pearaamat').click()
        page.get_by_role('button', name='Uus käsitsi kanne').click()
        page.fill('#fjX', 'Algsaldod')
        rows = page.locator('#jlBody tr')
        rows.nth(0).locator('[name=debit]').fill('2500')
        rows.nth(1).locator('[name=credit]').fill('2500')
        page.get_by_role('button', name='Salvesta kanne').click()
        toast(page, 'Kanne salvestatud')

        step('Partner e-arve sooviga')
        page.get_by_role('button', name='Kliendid ja tarnijad').click()
        page.get_by_role('button', name='Lisa partner').click()
        page.fill('#fcN', 'Põhjala Disain OÜ'); page.fill('#fcR', '14567021'); page.fill('#fcV', 'EE102345671'); page.fill('#fcA', 'Kalda 4, 10415 Tallinn')
        page.check('#fcEI')
        page.get_by_role('button', name='Salvesta').click()
        toast(page, 'Partner salvestatud')

        step('Müügiarve: mustand → kinnitamine')
        page.get_by_role('button', name='Müügiarved').click()
        page.get_by_role('button', name='Uus müügiarve').click()
        page.fill('#fiC', 'Põhjala Disain OÜ')
        ln = page.locator('#lnBody tr').first
        ln.locator('[name=description]').fill('Veebilehe arendus'); ln.locator('[name=qty]').fill('10'); ln.locator('[name=unit]').fill('h'); ln.locator('[name=price]').fill('55')
        page.get_by_role('button', name='Lisa rida').click()
        ln2 = page.locator('#lnBody tr').nth(1)
        ln2.locator('[name=description]').fill('Majutus'); ln2.locator('[name=qty]').fill('2'); ln2.locator('[name=unit]').fill('p'); ln2.locator('[name=price]').fill('45.5')
        ln2.locator('[name=vat_rate]').select_option('13')
        expect(page.locator('#invTot')).to_contain_text('784,83')
        shot(page, '02-invoice-form')
        page.get_by_role('button', name='Salvesta mustandina').click()
        toast(page, 'Mustand salvestatud')
        expect(page.locator('#sheet')).to_contain_text('Mustand')
        page.get_by_role('button', name='Kinnita arve').click()
        toast(page, 'Arve kinnitatud')
        expect(page.locator('#sheet')).to_contain_text('E-arve')
        shot(page, '03-invoice-issued')

        step('E-arve allalaadimine')
        with page.expect_download() as dl:
            page.get_by_role('button', name='Laadi alla e-arve (XML)').click()
        xml = open(dl.value.path()).read()
        assert '<cbc:PayableAmount currencyID="EUR">784.83</cbc:PayableAmount>' in xml, xml[-800:]
        assert 'schemeID="0191">14567021' in xml
        from xml.dom import minidom; minidom.parseString(xml.encode())
        page.get_by_role('button', name='Märgi saadetuks').click()
        toast(page, 'saadetuks')

        step('Osaline laekumine')
        page.get_by_role('button', name='Lisa laekumine').click()
        page.fill('#fpA', '300')
        page.get_by_role('button', name='Kinnita').click()
        toast(page, 'Laekumine kirjendatud')
        expect(page.locator('#sheet')).to_contain_text('Osaliselt tasutud')
        page.get_by_role('button', name='Sulge').click()

        step('Kinnitatud arvet ei saa muuta (andmebaas keelab)')
        r = page.evaluate("""async () => { const m = await import('./js/api.js');
          const inv = (await m.sb.from('invoices').select('*')).data[0];
          try { await m.saveInvoiceDraft({id: inv.id, company_id: inv.company_id, no: inv.no, contact_name: 'Muudetud', date: inv.date, due: inv.due,
                  lines: [{description: 'x', qty: 1, price: 1, vat_rate: 24}]}); return 'MUUDETI'; } catch (e) { return e.message; } }""")
        assert 'Kinnitatud arvet ei saa muuta' in r, r

        step('Kulu koos algdokumendiga, tasutud')
        page.get_by_role('button', name='Ostuarved').click()
        page.get_by_role('button', name='Lisa kulu').click()
        page.fill('#feS', 'Kontorikeskus AS'); page.fill('#feN', 'KK-1021'); page.fill('#feG', '372')
        page.select_option('#feA', '6010'); page.fill('#feX', 'Kontori üür, oktoober')
        pdf = f'{OUT}/arve.pdf'; open(pdf, 'wb').write(b'%PDF-1.4 test')
        page.set_input_files('#feF', pdf)
        page.check('#fePaid')
        expect(page.locator('#expTot')).to_contain_text('72,00')
        page.get_by_role('button', name='Salvesta').click()
        toast(page, 'Kulu lisatud')
        expect(page.locator('main')).to_contain_text('Tasutud')

        step('Kulu muutmine → storno ja uus kanne')
        page.locator('tr[data-act=open-exp]').first.click()
        page.get_by_role('button', name='Muuda').click()
        page.fill('#feG', '100')
        page.get_by_role('button', name='Salvesta').click()
        expect(page.locator('#fErr')).to_contain_text('juba tasutud')
        page.fill('#feG', '400')
        page.get_by_role('button', name='Salvesta').click()
        toast(page, 'Kulu muudetud')

        step('Pangaväljavõte (Swedbanki CSV) ja sidumine')
        csv = ('"Kliendi konto";"Reatüüp";"Kuupäev";"Saaja/Maksja";"Selgitus";"Summa";"Valuuta";"Deebet/Kreedit";"Arhiveerimistunnus";"Tehingu tüüp";"Viitenumber";"Dokumendi number"\n'
               '"EE38";"10";"01.10.2026";"";"Algsaldo";"0,00";"EUR";"K";"";"AS";"";""\n'
               f'"EE38";"20";"{time.strftime("%d.%m.%Y")}";"PÕHJALA DISAIN OÜ";"Arve 2026-001";"484,83";"EUR";"K";"1";"MK";"20260011";""\n'
               f'"EE38";"20";"{time.strftime("%d.%m.%Y")}";"LINNASIDE AS";"Internet";"31,00";"EUR";"D";"2";"MK";"";""\n')
        cp = f'{OUT}/valjavote.csv'; open(cp, 'w', encoding='utf-8').write(csv)
        page.get_by_role('button', name='Pank').click()
        page.set_input_files('#bankFile', cp)
        expect(page.locator('main')).to_contain_text('viitenumber kattub')
        shot(page, '04-bank')
        page.get_by_role('button', name='Seo', exact=True).click()
        toast(page, 'Makse seotud')
        page.get_by_role('button', name='Lisa kuluna').click()
        expect(page.locator('#feS')).to_have_value('LINNASIDE AS')
        page.select_option('#feA', '6020')
        page.get_by_role('button', name='Salvesta').click()
        toast(page, 'Kulu lisatud')

        step('Ülevaade ja arve olek')
        page.get_by_role('button', name='Ülevaade').click()
        shot(page, '05-overview')
        page.get_by_role('button', name='Müügiarved').click()
        expect(page.locator('main')).to_contain_text('Tasutud')

        step('Pearaamat, storno ja käibeandmik')
        page.get_by_role('button', name='Pearaamat').click()
        expect(page.locator('main')).to_contain_text('storno kandele')
        page.get_by_role('button', name='Storno').first.click()
        page.get_by_role('button', name='Tee storno').click()
        toast(page, 'Storno tehtud')
        page.get_by_role('tab', name='Käibeandmik').click()
        expect(page.locator('main')).to_contain_text('Tasakaalus')
        shot(page, '06-ledger')

        step('Aruanded: kasumiaruanne, bilanss, KMD')
        page.get_by_role('button', name='Aruanded').click()
        expect(page.locator('main')).to_contain_text('Aruandeperioodi kasum')
        page.get_by_role('tab', name='Bilanss').click()
        expect(page.locator('main .pill.paid')).to_have_text('Tasakaalus')
        page.get_by_role('tab', name='Käibedeklaratsioon').click()
        page.select_option('#kmdMonth', time.strftime('%Y-%m'))
        expect(page.locator('main')).to_contain_text('Tasumisele kuuluv käibemaks')
        shot(page, '07-kmd')
        page.get_by_role('button', name='Kirjenda tasaarveldus').click()
        toast(page, 'Kirjendatud')
        expect(page.locator('main')).to_contain_text('Tasaarveldus kirjendatud')

        step('Kreeditarve (tasumata arve)')
        page.get_by_role('button', name='Müügiarved').click()
        page.get_by_role('button', name='Uus müügiarve').click()
        page.fill('#fiC', 'Uus Klient OÜ')
        ln = page.locator('#lnBody tr').first
        ln.locator('[name=description]').fill('Konsultatsioon'); ln.locator('[name=price]').fill('100')
        page.get_by_role('button', name='Salvesta ja kinnita').click()
        toast(page, 'Arve kinnitatud')
        page.get_by_role('button', name='Koosta kreeditarve').click()
        page.locator('#sheet').get_by_role('button', name='Koosta kreeditarve').click()
        toast(page, 'Kreeditarve koostatud')
        expect(page.frame_locator('.docframe').locator('body')).to_contain_text('124,00')
        page.get_by_role('button', name='Sulge').click()

        step('Import prototüübist')
        proto = {'format': 'saldo-prototype', 'contacts': [{'id': 'c9', 'name': 'Kohvik Karamell OÜ', 'type': 'client', 'regcode': '14781230'}],
                 'invoices': [{'id': 'i9', 'no': 'P-002', 'date': '2026-09-03', 'due': '2026-09-17', 'contactId': 'c9', 'contactName': 'Kohvik Karamell OÜ',
                               'lines': [{'desc': 'Logo', 'qty': 1, 'unit': 'tk', 'price': 480, 'vat': 24}], 'paidDate': None}],
                 'expenses': [], 'journal': []}
        jp = f'{OUT}/proto.json'; json.dump(proto, open(jp, 'w'))
        page.get_by_role('button', name='Seaded').click()
        page.set_input_files('#impFile', jp)
        toast(page, 'Imporditud: 1 partnerit, 1 arvet')

        step('Kaheastmeline kinnitus: sisselülitamine')
        page.get_by_role('button', name='Lülita sisse').click()
        page.fill('#mvCode', '000000'); page.locator('form[data-form=mfa-verify] button[type=submit]').click()
        expect(page.locator('#mfaErr')).to_contain_text('Kood ei sobi')
        page.fill('#mvCode', '123456'); page.locator('form[data-form=mfa-verify] button[type=submit]').click()
        toast(page, 'Kaheastmeline kinnitus on sees')
        shot(page, '08-settings')

        step('Uus sisselogimine nõuab koodi')
        page.get_by_role('button', name='Logi välja').click()
        page.wait_for_load_state()
        expect(page.get_by_role('heading', name='Logi sisse')).to_be_visible()
        page.fill('#aEmail', 'angela@test.ee'); page.fill('#aPass', 'vale-parool')
        page.get_by_role('button', name='Logi sisse').click()
        expect(page.locator('#fErr')).to_contain_text('Vale e-post või parool')
        page.fill('#aEmail', 'angela@test.ee'); page.fill('#aPass', 'salasona123')
        page.get_by_role('button', name='Logi sisse').click()
        expect(page.get_by_role('heading', name='Kaheastmeline kinnitus')).to_be_visible()
        # aal1 seansiga ei näe andmebaas midagi
        n = page.evaluate("""async () => { const m = await import('./js/api.js'); m.init({url:'x',anonKey:'y'}); return (await m.sb.from('invoices').select('*')).data.length; }""")
        assert n == 0, f'aal1 nägi {n} arvet'
        page.fill('#mCode', '123456'); page.get_by_role('button', name='Kinnita').click()
        expect(page.locator('.rail small')).to_have_text('Angela Disain OÜ')

        step('Teine kasutaja ei näe esimese andmeid')
        page.get_by_role('button', name='Logi välja').click()
        page.wait_for_load_state()
        page.get_by_role('button', name='Loo uus konto').click()
        page.fill('#aEmail', 'teine@test.ee'); page.fill('#aPass', 'salasona123'); page.fill('#aPass2', 'salasona123')
        page.get_by_role('button', name='Loo konto').click()
        expect(page.get_by_role('heading', name='Lisa oma ettevõte')).to_be_visible()
        n = page.evaluate("""async () => { const m = await import('./js/api.js'); m.init({url:'x',anonKey:'y'}); return (await m.sb.from('invoices').select('*')).data.length; }""")
        assert n == 0, f'teine kasutaja nägi {n} arvet'

        step('Telefonivaade')
        page.get_by_role('button', name='Logi välja').click()
        page.wait_for_load_state()
        page.fill('#aEmail', 'angela@test.ee'); page.fill('#aPass', 'salasona123'); page.get_by_role('button', name='Logi sisse').click()
        page.fill('#mCode', '123456'); page.get_by_role('button', name='Kinnita').click()
        expect(page.locator('.rail small')).to_have_text('Angela Disain OÜ')
        page.get_by_role('button', name='Ülevaade').click()
        page.set_viewport_size({'width': 390, 'height': 844})
        shot(page, '09-mobile-overview')
        sw = page.evaluate('document.documentElement.scrollWidth')
        assert sw <= 390, f'horisontaalne kerimine: {sw}px'
        page.get_by_role('button', name='Müügiarved').click()
        page.locator('tr[data-act=open-inv]').first.click()
        shot(page, '10-mobile-invoice')
        browser.close()
except Exception:
    try:
        shot(page, 'FAIL'); print('      URL:', page.url); print('      TEKST:', page.locator('body').inner_text()[:600].replace('\n', ' | '))
    except Exception:
        pass
    raise
finally:
    srv.terminate()

real_errors = [e for e in errors if 'fonts.g' not in e and 'ERR_FAILED' not in e]
if real_errors:
    print('BRAUSERI VEAD:'); [print('  ', e) for e in real_errors]; sys.exit(1)
print('KÕIK OTSAST LÕPUNI TESTID LÄBITUD')

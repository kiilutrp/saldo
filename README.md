# Saldo raamatupidamine

Väikefirma raamatupidamistarkvara: müügiarved ja e-arved, ostuarved koos algdokumentidega, pangaväljavõtte import, pearaamat topeltkirjendusega, kasumiaruanne, bilanss ja käibedeklaratsioon (KMD koos INF-lisaga).

Andmed asuvad sinu enda Supabase'i andmebaasis (PostgreSQL, Frankfurt). Veebileht avaldatakse tasuta GitHub Pagesis.

## Mida tarkvara tagab

- **Kandeid ei saa muuta ega kustutada.** Vead parandatakse stornokandega ja algne kanne jääb alles.
- **Iga kanne on tasakaalus**: deebet ja kreedit peavad olema võrdsed, seda kontrollib andmebaas.
- **Kinnitatud arvet ei saa muuta.** Vea korral koostatakse kreeditarve.
- **Suletud perioodi** ei saa kandeid lisada.
- **Iga muudatus jääb ajalukku** (seaded → muudatuste ajalugu).
- **Algdokumente** (PDF, pildid) ei saa kustutada, sest neid tuleb säilitada 7 aastat.
- **Sinu andmeid näed ainult sina.** Kui lülitad sisse kaheastmelise kinnituse, nõuab seda ka andmebaas.

---

## Paigaldamine (umbes 20 minutit)

### 1. Supabase: andmebaas

1. Mine [supabase.com](https://supabase.com) ja logi sisse (saad kasutada GitHubi kontot).
2. Vajuta **New project**. Nimi: `saldo`. Piirkond: **Central EU (Frankfurt)**. Pane andmebaasi parool kindlasse kohta kirja.
3. Kui projekt on valmis, ava vasakult **SQL Editor** → **New query**.
4. Ava selles repositooriumis fail `supabase/migrations/0001_saldo.sql`, kopeeri kogu sisu SQL-aknasse ja vajuta **Run**. Peab tulema teade *Success*.
5. Tee sama failiga `supabase/migrations/0002_storage.sql`.

### 2. Supabase: ühenduse andmed

1. Ava **Project Settings** → **API Keys** (või **API**).
2. Kopeeri **Project URL** (näiteks `https://abcd1234.supabase.co`).
3. Kopeeri **avalik võti**: *Publishable key* või vahekaardil *Legacy* olev **anon public** võti.
   **Ära kunagi kasuta võtit `service_role` / *Secret key*** – see annaks kõigile ligipääsu kõigile andmetele.
4. Ava GitHubis fail `web/config.js`, vajuta pliiatsiikooni (Edit) ja asenda väärtused:
   ```js
   window.SALDO_CONFIG = {
     url: 'https://abcd1234.supabase.co',
     anonKey: 'sinu avalik võti',
   };
   ```
   Vajuta **Commit changes**.

### 3. GitHub Pages: veebileht

1. Ava repositooriumis **Settings** → **Pages**.
2. **Source** alt vali **GitHub Actions**.
3. Ava vahekaart **Actions**. Töö „Avalda veebileht“ käivitub ise pärast iga muudatust. Kui see on roheline, on leht üleval aadressil
   `https://SINU-KASUTAJANIMI.github.io/saldo/`

### 4. Supabase: sisselogimise seaded

1. Ava Supabase'is **Authentication** → **URL Configuration**.
2. **Site URL**: `https://SINU-KASUTAJANIMI.github.io/saldo/`
3. **Redirect URLs** alla lisa sama aadress.
4. Salvesta.

### 5. Esimene sisselogimine

1. Ava oma leht, vali **Loo uus konto** ja kinnita e-posti aadress lingiga, mis tuleb postkasti.
2. Logi sisse ja sisesta ettevõtte nimi. Luuakse Eesti standardne kontoplaan.
3. Täida **Seaded**: registrikood, KMKR number, aadress, IBAN.
4. **Sulge uute kontode loomine**, et võõrad ei saaks sinu lehel kontot teha: Supabase → **Authentication** → **Sign In / Providers** → lülita välja **Allow new users to sign up**. (Kui tahad hiljem raamatupidaja lisada, lülita see ajutiselt tagasi.)
5. **Lülita sisse kaheastmeline kinnitus** (Seaded → Turvalisus). Vajad telefoni rakendust, näiteks Google Authenticator või Microsoft Authenticator.
6. Kui kasutasid Saldo prototüüpi: ava prototüübis Seaded → **Laadi alla kõik andmed (JSON)** ja lae see fail uues tarkvaras üles (Seaded → Andmed → Too andmed Saldo prototüübist).

---

## Oluline teada

- **Tasuta Supabase'i projekt peatatakse, kui seda nädal aega ei kasutata.** Andmed jäävad alles ja projekti saab Supabase'i lehelt ühe nupuga taaskäivitada. Kui see segab või soovid igapäevaseid automaatseid varukoopiaid, vali Supabase'is tasuline Pro pakett.
- **Tee regulaarselt varukoopia**: Seaded → Andmed → Laadi alla JSON. Hoia faili turvalises kohas.
- **Tasuta e-kirjade saatmine on piiratud** (paar kirja tunnis). Konto loomiseks ja parooli taastamiseks piisab. Kui lisad raamatupidaja või rohkem kasutajaid, seadista Supabase'is oma e-posti server (Authentication → SMTP Settings).
- **E-arved**: tarkvara koostab EN 16931 / Peppol BIS Billing 3.0 XML-faili. Saatmiseks lae fail üles oma e-arve operaatori keskkonda (nt Omniva, Finbite, Telema).
- Saldo ei esita deklaratsioone ise. Kontrolli aruanded ja KMD enne esitamist üle.

## Uuendamine

**0003_invoice_design.sql** (16.10.2026): arve logo ja värv. Käivita see SQL Editoris, et saaksid seadetes logo lisada.


Kui tarkvarast tuleb uus versioon, mis muudab andmebaasi, lisandub kausta `supabase/migrations/` uus fail (nt `0003_...sql`). Käivita see Supabase'i SQL Editoris samamoodi nagu esimesed. Veebileht uueneb GitHub Pagesis automaatselt.

---

## Arendajale

```
supabase/migrations/   andmebaasi skeem, õigused (RLS) ja kirjendusfunktsioonid
web/                   veebiliides (tavaline HTML + JavaScripti moodulid, ehitusetappi pole)
  config.js            Supabase'i URL ja avalik võti
  js/api.js            kõik päringud Supabase'i poole
  js/app.js            vaated ja sündmused
  js/util.js           summad, ümardamine (EN 16931), viitenumber
  js/einvoice.js       e-arve XML (UBL 2.1)
  js/bank.js           pangaväljavõtte CSV lugemine ja sidumine
  js/reports.js        kasumiaruanne, bilanss, KMD
tests/
  test_db.sql          andmebaasi testid (õigused, storno, tasakaal, MFA)
  run_db_tests.sh      käivitab andmebaasi testid kohalikus PostgreSQL-is
  e2e/                 otsast lõpuni testid päris brauseris (Playwright)
```

Kogu äriloogika, mis mõjutab kandeid, asub andmebaasi funktsioonides (`save_expense`, `issue_invoice`, `add_payment` jne). Kliendil on tabelitele ainult lugemisõigus; partnerid, kontod ja ettevõtte seaded on otse muudetavad Row Level Security reeglite piires.

Testide käivitamine (vajab PostgreSQL 15+ ja Playwrighti):

```sh
PGHOST=/tmp/pgsaldo PGPORT=54329 sh tests/run_db_tests.sh
PGHOST=/tmp/pgsaldo PGPORT=54329 python3 tests/e2e/run.py
```

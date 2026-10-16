// Saldo · rakenduse liides
import * as api from './api.js';
import { VAT_RATES, KMD_ROW, MONTHS, r2, eur, n2, num, esc, iso, today, addDays, fd, monthKey, monthLabel, lastDay,
  daysBetween, refNo, calcLines, expCalc, nextInvoiceNo, download } from './util.js';
import { ublXML, einvCheck } from './einvoice.js';
import { invoiceDoc } from './invoice-doc.js';
import { bankRows, matchBank } from './bank.js';
import { balances, bal, profit, vatMonth, kmdInf } from './reports.js';

const cfg = window.SALDO_CONFIG || {};
const root = document.getElementById('root');
const yr = new Date().getFullYear();

const S = {
  screen: 'loading', authMode: 'login', authMsg: '', authErr: '',
  user: null, members: [], cid: null, role: null, D: null,
  view: 'overview', invFilter: 'all', expFilter: 'all', ledgerTab: 'journal', ledgerAcc: '', repTab: 'pl',
  rep: { from: `${yr}-01-01`, to: today(), asof: today(), month: monthKey(addDays(today().slice(0, 8) + '01', -1)) },
  bank: null, busy: 0, mfa: null, audit: null,
};
try { S.view = localStorage.getItem('saldo.view') || S.view; } catch { /* ignore */ }

// ====================================================================
// Andmed ja tuletatud väärtused
// ====================================================================
function derive(D) {
  D.acc = Object.fromEntries(D.accounts.map((a) => [a.code, a]));
  D.quotesMissing = D.quotes === null;
  D.quotes = D.quotes || []; D.quoteLines = D.quoteLines || [];
  D.quoteLinesBy = {};
  for (const l of D.quoteLines) (D.quoteLinesBy[l.quote_id] = D.quoteLinesBy[l.quote_id] || []).push(l);
  D.linesBy = {};
  for (const l of D.lines) (D.linesBy[l.invoice_id] = D.linesBy[l.invoice_id] || []).push(l);
  D.paidInv = {}; D.paidExp = {};
  for (const p of D.payments) {
    if (p.status !== 'active') continue;
    if (p.invoice_id) D.paidInv[p.invoice_id] = r2((D.paidInv[p.invoice_id] || 0) + num(p.amount));
    if (p.expense_id) D.paidExp[p.expense_id] = r2((D.paidExp[p.expense_id] || 0) + num(p.amount));
  }
  D.contactById = Object.fromEntries(D.contacts.map((c) => [c.id, c]));
  D.invById = Object.fromEntries(D.invoices.map((i) => [i.id, i]));
  const E = {};
  for (const l of D.ledger) {
    const e = E[l.entry_id] || (E[l.entry_id] = { id: l.entry_id, no: l.no, date: l.date, description: l.description, source: l.source,
      source_id: l.source_id, source_ref: l.source_ref, reversal_of: l.reversal_of, lines: [] });
    e.lines.push(l);
  }
  D.entries = Object.values(E).sort((a, b) => a.no - b.no);
  D.reversed = new Set(D.entries.filter((e) => e.reversal_of).map((e) => e.reversal_of));
  return D;
}
async function reload() {
  S.D = derive(await api.loadAll(S.cid));
}
const D = () => S.D;
const accName = (a) => D().acc[a]?.name || `Konto ${a}`;
const contactOf = (i) => (i.contact_id && D().contactById[i.contact_id]) || D().contacts.find((c) => c.name === i.contact_name);
const canWrite = () => S.role === 'owner' || S.role === 'accountant';

function invInfo(i) {
  const paid = D().paidInv[i.id] || 0, open = r2(num(i.gross) - paid);
  let st;
  if (i.status === 'draft') st = 'draft';
  else if (i.kind === 'credit') st = 'credit';
  else if (i.credited_by) st = 'credited';
  else if (open <= 0.004) st = 'paid';
  else if (i.due < today()) st = 'late';
  else if (paid > 0) st = 'partial';
  else st = 'open';
  return { paid, open, st };
}
function expInfo(x) {
  const paid = D().paidExp[x.id] || 0, open = r2(num(x.gross) - paid);
  let st;
  if (x.status === 'cancelled') st = 'cancelled';
  else if (open <= 0.004) st = 'paid';
  else if (x.due < today()) st = 'late';
  else if (daysBetween(today(), x.due) <= 7) st = 'soon';
  else if (paid > 0) st = 'partial';
  else st = 'open';
  return { paid, open, st };
}
const PILL = { draft: 'Mustand', open: 'Avatud', partial: 'Osaliselt tasutud', paid: 'Tasutud', late: 'Üle tähtaja', soon: 'Tähtaeg lähedal',
  credit: 'Kreeditarve', credited: 'Krediteeritud', cancelled: 'Tühistatud' };
function pill(st, due) {
  const extra = st === 'late' && due ? ` · ${daysBetween(due, today())} p` : '';
  return `<span class="pill ${st}">${PILL[st]}${extra}</span>`;
}

// ====================================================================
// Abid
// ====================================================================
let toastT;
function toast(m) {
  const t = document.getElementById('toast');
  t.textContent = m; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3800);
}
function setBusy(d) {
  S.busy = Math.max(0, S.busy + d);
  document.getElementById('busy').hidden = S.busy === 0;
}
/** Käivitab kirjutava toimingu, laeb andmed uuesti ja näitab tulemust. */
async function act(fn, ok, after) {
  setBusy(1);
  try {
    const res = await fn();
    await reload();
    if (ok) toast(ok);
    render();
    if (after) after(res);
    return res;
  } catch (e) {
    const box = sheet.querySelector('#fErr');
    if (!modal.hidden && box) box.textContent = e.message; else toast(e.message);
    return undefined;
  } finally { setBusy(-1); }
}

const modal = document.getElementById('modal');
const sheet = document.getElementById('sheet');
function openModal(html) {
  sheet.innerHTML = html; modal.hidden = false;
  const f = sheet.querySelector('input:not([type=hidden]):not([type=file]),select,textarea');
  if (f) f.focus();
}
function closeModal() { modal.hidden = true; sheet.innerHTML = ''; }
const mHead = (t) => `<header><h2 id="mTitle">${t}</h2><button class="btn ghost sm" type="button" data-act="close" aria-label="Sulge">✕</button></header>`;
const vatOpts = (sel) => VAT_RATES.map((r) => `<option value="${r}" ${Number(sel) === r ? 'selected' : ''}>${r}%</option>`).join('');
const accOpts = (codes, sel) => codes.map((c) => `<option value="${c}" ${c === sel ? 'selected' : ''}>${c} ${esc(accName(c))}</option>`).join('');
const contactList = () => `<datalist id="contactsDL">${D().contacts.map((c) => `<option value="${esc(c.name)}"></option>`).join('')}</datalist>`;
const head = (t, p, actions = '') => `<div class="head"><div><h1>${t}</h1>${p ? `<p>${p}</p>` : ''}</div><div class="row">${actions}</div></div>`;
/** Tulukontod arve rea valikuks; ainult 4000/4900 korral valikut ei näidata. */
const revenueChoices = () => { const r = accountsOfType('R'); return r.filter((a) => a !== '4900').length > 1 ? r : ['4000']; };
const accountsOfType = (...types) => D().accounts.filter((a) => a.active && types.includes(a.type)).map((a) => a.code);
async function findOrCreateContact(name, kind) {
  const ex = D().contacts.find((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (ex) {
    if (ex.kind !== kind && ex.kind !== 'both') await api.saveContact({ id: ex.id, kind: 'both' });
    return ex.id;
  }
  const r = await api.saveContact({ company_id: S.cid, name: name.trim(), kind });
  return r.id;
}

// ====================================================================
// Ekraanid enne sisselogimist
// ====================================================================
const brand = `<div class="brand"><b>Saldo</b><span class="flag" aria-hidden="true"><i></i><i></i><i></i></span></div>`;
function authShell(inner) { return `<div class="auth"><div class="card">${brand}${inner}</div></div>`; }

function vSetup() {
  return authShell(`<h1>Seadistamine pooleli</h1>
    <p class="muted">Rakendus ei tea veel, millise andmebaasiga ühenduda. Ava failis <span class="code">web/config.js</span> ja lisa sinna Supabase'i projekti URL ja avalik võti (anon key). Täpsed juhised on failis README.md.</p>`);
}
function vAuth() {
  const m = S.authMode;
  const msg = S.authMsg ? `<div class="ok-msg">${esc(S.authMsg)}</div>` : '';
  if (m === 'forgot') {
    return authShell(`<h1>Parooli taastamine</h1>${msg}
      <form class="form" data-form="forgot"><label class="field"><span>E-post</span><input id="aEmail" name="email" type="email" autocomplete="email" required></label>
      <div class="err" id="fErr">${esc(S.authErr)}</div><button class="btn primary" type="submit">Saada taastamise link</button></form>
      <div class="links"><button class="linkbtn" data-act="auth-mode" data-m="login">Tagasi sisselogimisse</button></div>`);
  }
  const signup = m === 'signup';
  return authShell(`<h1>${signup ? 'Loo konto' : 'Logi sisse'}</h1>${msg}
    <form class="form" data-form="${signup ? 'signup' : 'login'}">
      <label class="field"><span>E-post</span><input id="aEmail" name="email" type="email" autocomplete="email" required></label>
      <label class="field"><span>Parool</span><input id="aPass" name="password" type="password" minlength="8" autocomplete="${signup ? 'new-password' : 'current-password'}" required></label>
      ${signup ? '<label class="field"><span>Parool uuesti</span><input id="aPass2" name="password2" type="password" minlength="8" autocomplete="new-password" required></label>' : ''}
      <div class="err" id="fErr">${esc(S.authErr)}</div>
      <button class="btn primary" type="submit">${signup ? 'Loo konto' : 'Logi sisse'}</button>
    </form>
    <div class="links">${signup ? '<button class="linkbtn" data-act="auth-mode" data-m="login">Mul on konto olemas</button>'
      : '<button class="linkbtn" data-act="auth-mode" data-m="signup">Loo uus konto</button><button class="linkbtn" data-act="auth-mode" data-m="forgot">Unustasid parooli?</button>'}</div>`);
}
function vMfa() {
  return authShell(`<h1>Kaheastmeline kinnitus</h1><p class="muted">Sisesta autentimisrakenduses (nt Google Authenticator) kuvatav 6-kohaline kood.</p>
    <form class="form" data-form="mfa"><label class="field"><span>Kood</span><input id="mCode" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required class="mono"></label>
    <div class="err" id="fErr">${esc(S.authErr)}</div><button class="btn primary" type="submit">Kinnita</button></form>
    <div class="links"><button class="linkbtn" data-act="signout">Logi välja</button></div>`);
}
function vRecovery() {
  return authShell(`<h1>Uus parool</h1>
    <form class="form" data-form="newpass"><label class="field"><span>Uus parool</span><input id="nPass" name="password" type="password" minlength="8" autocomplete="new-password" required></label>
    <div class="err" id="fErr">${esc(S.authErr)}</div><button class="btn primary" type="submit">Salvesta parool</button></form>`);
}
function vOnboard() {
  return authShell(`<h1>Lisa oma ettevõte</h1><p class="muted">Loome sulle Eesti standardse kontoplaaniga raamatupidamise. Ülejäänud andmed saad lisada seadetes.</p>
    <form class="form" data-form="onboard"><label class="field"><span>Ärinimi</span><input id="oName" name="name" placeholder="Minu Firma OÜ" required></label>
    <div class="err" id="fErr">${esc(S.authErr)}</div><button class="btn primary" type="submit">Loo raamatupidamine</button></form>
    <div class="links"><button class="linkbtn" data-act="signout">Logi välja</button></div>`);
}

// ====================================================================
// Rakenduse vaated
// ====================================================================
const VIEWS = [['overview', 'Ülevaade'], ['quotes', 'Hinnapakkumised'], ['invoices', 'Müügiarved'], ['expenses', 'Ostuarved'], ['contacts', 'Kliendid ja tarnijad'],
  ['bank', 'Pank'], ['ledger', 'Pearaamat'], ['reports', 'Aruanded'], ['settings', 'Seaded']];

function render() {
  const screens = { loading: () => authShell('<p class="muted">Laadin…</p>'), setup: vSetup, auth: vAuth, mfa: vMfa, recovery: vRecovery, onboard: vOnboard };
  if (S.screen !== 'app') { root.innerHTML = screens[S.screen](); return; }
  const late = D().invoices.filter((i) => invInfo(i).st === 'late').length;
  const views = { overview: vOverview, quotes: vQuotes, invoices: vInvoices, expenses: vExpenses, contacts: vContacts, bank: vBank, ledger: vLedger, reports: vReports, settings: vSettings };
  const fn = views[S.view] || vOverview;
  root.innerHTML = `<div class="app">
    <aside class="rail">
      <div class="brand"><b>Saldo</b><span class="flag" aria-hidden="true"><i></i><i></i><i></i></span><small>${esc(D().company.name || 'Raamatupidamine')}</small></div>
      <nav class="tabs" aria-label="Jaotised">${VIEWS.map(([k, t]) => `<button type="button" data-act="go" data-v="${k}" ${S.view === k ? 'aria-current="page"' : ''}>${t}${k === 'invoices' && late ? `<span class="navcount">${late}</span>` : ''}</button>`).join('')}</nav>
      <div class="persist"><span class="dot ok"></span><span>${esc(S.user.email)}${S.role !== 'owner' ? ` · ${S.role === 'accountant' ? 'raamatupidaja' : 'vaataja'}` : ''}<br><button class="linkbtn small" data-act="signout">Logi välja</button></span></div>
    </aside>
    <main><div class="wrap">${fn()}</div></main></div>`;
}

function vOverview() {
  const d = D(), t = today(), mk = monthKey(t);
  const B = balances(d.ledger, null, t);
  const issued = d.invoices.filter((i) => i.status === 'issued' && i.kind === 'invoice' && !i.credited_by);
  const openInv = issued.filter((i) => invInfo(i).open > 0.004), lateInv = openInv.filter((i) => invInfo(i).st === 'late');
  const openExp = d.expenses.filter((x) => x.status === 'active' && expInfo(x).open > 0.004);
  const sumOpen = (a, f) => r2(a.reduce((s, x) => s + f(x).open, 0));
  const ytd = profit(d.ledger, `${yr}-01-01`, t);
  const vm = vatMonth(mk, d.invoices, d.linesBy, d.expenses);
  const months = [];
  { const x = new Date(t + 'T12:00:00'); x.setDate(1); for (let i = 5; i >= 0; i--) { const y = new Date(x); y.setMonth(x.getMonth() - i); months.push(iso(y).slice(0, 7)); } }
  const series = months.map((k) => { const p = profit(d.ledger, `${k}-01`, lastDay(k)); return { k, rev: p.rev, cost: p.cost }; });
  const attn = [];
  for (const i of lateInv.sort((a, b) => (a.due < b.due ? -1 : 1))) attn.push(`<li><div class="t"><div><b>${esc(i.contact_name)}</b> · arve ${esc(i.no)}</div><div class="muted small">Tähtaeg oli ${fd(i.due)}</div></div><div class="row"><span class="num mono">${eur(invInfo(i).open)}</span>${pill('late', i.due)}</div></li>`);
  for (const x of openExp.filter((x) => ['late', 'soon'].includes(expInfo(x).st)).sort((a, b) => (a.due < b.due ? -1 : 1))) attn.push(`<li><div class="t"><div><b>${esc(x.supplier)}</b> · tasuda</div><div class="muted small">Tähtaeg ${fd(x.due)}</div></div><div class="row"><span class="num mono">${eur(expInfo(x).open)}</span>${pill(expInfo(x).st, x.due)}</div></li>`);
  for (const q of d.quotes.filter((q) => q.status === 'accepted')) attn.push(`<li><div class="t"><div><b>${esc(q.contact_name)}</b> · pakkumine ${esc(q.no)}</div><div class="muted small">Klient kinnitas, koosta arve</div></div><button class="btn sm" data-act="open-quote" data-id="${q.id}">Ava</button></li>`);
  const drafts = d.invoices.filter((i) => i.status === 'draft').length;
  if (drafts) attn.push(`<li><div class="t"><div><b>${drafts} arve mustandit</b></div><div class="muted small">Kinnita, et need kirjendataks</div></div><button class="btn sm" data-act="go" data-v="invoices">Vaata</button></li>`);
  const kmdDueD = new Date(+mk.slice(0, 4), +mk.slice(5, 7), 20);
  const recent = [...d.invoices.map((i) => ({ d: i.date, t: `${i.kind === 'credit' ? 'Kreeditarve' : 'Müügiarve'} ${i.no}`, w: i.contact_name, a: i.gross, s: 1, o: i })),
    ...d.expenses.filter((x) => x.status === 'active').map((x) => ({ d: x.date, t: 'Ostuarve', w: x.supplier, a: x.gross, s: -1, o: x }))]
    .sort((a, b) => (a.d < b.d ? 1 : -1)).slice(0, 6);
  return `${head(esc(d.company.name || 'Ülevaade'), `Seis ${fd(t)}. Kõik summad eurodes.`, canWrite() ? '<button class="btn" data-act="new-exp">Lisa kulu</button><button class="btn primary" data-act="new-inv">Uus müügiarve</button>' : '')}
  ${!d.company.regcode || !d.company.iban ? '<div class="banner"><span>Lisa registrikood ja IBAN, et need ilmuksid arvetele.</span><button class="btn sm" data-act="go" data-v="settings">Ava seaded</button></div>' : ''}
  <div class="kpis">
    <div class="kpi"><span class="label">Pangakonto</span><span class="v">${eur(bal(B, '1020'))}</span><span class="s">Konto 1020 saldo</span></div>
    <div class="kpi"><span class="label">Laekumata</span><span class="v">${eur(sumOpen(openInv, invInfo))}</span><span class="s">${openInv.length} arvet${lateInv.length ? ` · <b class="bad">${eur(sumOpen(lateInv, invInfo))} üle tähtaja</b>` : ''}</span></div>
    <div class="kpi"><span class="label">Tasumata</span><span class="v">${eur(sumOpen(openExp, expInfo))}</span><span class="s">${openExp.length} ostuarvet</span></div>
    <div class="kpi"><span class="label">Kasum ${yr}</span><span class="v">${eur(ytd.profit)}</span><span class="s">Tulu ${eur(ytd.rev)} · kulu ${eur(ytd.cost)}</span></div>
    ${d.company.vat_payer ? `<div class="kpi"><span class="label">Käibemaks, ${monthLabel(mk)}</span><span class="v">${eur(vm.outVat - vm.inVat)}</span><span class="s">KMD tähtaeg ${fd(iso(kmdDueD))}</span></div>` : ''}
  </div>
  <div class="grid2">
    <section class="panel"><header><h2>Tulud ja kulud, 6 kuud</h2><div class="legend"><span><i style="background:var(--accent)"></i>Tulu</span><span><i style="background:var(--muted);opacity:.55"></i>Kulu</span></div></header><div class="pad chart">${barChart(series)}</div></section>
    <section class="panel"><header><h2>Vajab tähelepanu</h2></header>${attn.length ? `<ul class="attn">${attn.slice(0, 8).join('')}</ul>` : '<div class="empty"><b>Kõik on korras</b><span>Üle tähtaja arveid ega lähenevaid makseid pole.</span></div>'}</section>
  </div>
  <section class="panel"><header><h2>Viimased dokumendid</h2></header>${recent.length ? `<div class="tbl"><table><thead><tr><th>Kuupäev</th><th>Dokument</th><th>Partner</th><th class="num">Summa</th></tr></thead><tbody>${recent.map((r) => `<tr class="click" data-act="${r.s > 0 ? 'open-inv' : 'open-exp'}" data-id="${r.o.id}"><td class="mono">${fd(r.d)}</td><td>${esc(r.t)}</td><td>${esc(r.w)}</td><td class="num">${r.s > 0 ? '' : '−'}${eur(r.a)}</td></tr>`).join('')}</tbody></table></div>`
    : `<div class="empty"><b>Dokumente pole veel</b><span>Alusta esimese müügiarve või kuluga. Prototüübi andmed saad tuua seadetest.</span>${canWrite() ? '<button class="btn primary" data-act="new-inv">Koosta esimene arve</button>' : ''}</div>`}</section>`;
}

function barChart(series) {
  const W = 560, H = 210, pl = 56, pr = 8, pt = 10, pb = 28;
  const max = Math.max(1, ...series.flatMap((s) => [s.rev, s.cost]));
  const mag = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 2.5, 5, 10].map((x) => x * mag).find((s) => max / s <= 4) || mag * 10;
  const top = Math.ceil(max / step) * step;
  const y = (v) => pt + (H - pt - pb) * (1 - Math.max(0, v) / top);
  const gw = (W - pl - pr) / series.length, bw = Math.min(22, gw * 0.3);
  let g = '';
  for (let v = 0; v <= top + 1e-9; v += step) g += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${pl - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)" font-family="IBM Plex Mono, monospace">${v >= 1000 ? `${(v / 1000).toLocaleString('et-EE')} k` : v}</text>`;
  series.forEach((s, i) => {
    const cx = pl + gw * i + gw / 2;
    g += `<rect x="${cx - bw - 2}" y="${y(s.rev)}" width="${bw}" height="${Math.max(0, y(0) - y(s.rev))}" rx="2" fill="var(--accent)"><title>Tulu ${eur(s.rev)}</title></rect>`;
    g += `<rect x="${cx + 2}" y="${y(s.cost)}" width="${bw}" height="${Math.max(0, y(0) - y(s.cost))}" rx="2" fill="var(--muted)" fill-opacity=".55"><title>Kulu ${eur(s.cost)}</title></rect>`;
    g += `<text x="${cx}" y="${H - 8}" text-anchor="middle" font-size="11.5" fill="var(--muted)">${MONTHS[+s.k.slice(5, 7) - 1]}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tulud ja kulud kuude kaupa">${g}</svg>`;
}

const QPILL = { draft: ['draft', 'Mustand'], sent: ['open', 'Saadetud'], accepted: ['paid', 'Kinnitatud'], declined: ['cancelled', 'Tagasi lükatud'],
  invoiced: ['credited', 'Arve tehtud'], expired: ['late', 'Aegunud'] };
const quoteSt = (q) => (q.status === 'sent' && q.valid_until < today() ? 'expired' : q.status);
const qpill = (st) => `<span class="pill ${QPILL[st][0]}">${QPILL[st][1]}</span>`;
const nextQuoteNo = () => nextInvoiceNo(D().quotes, `HP-${new Date().getFullYear()}-`);

function vQuotes() {
  const f = S.quoteFilter || 'all';
  const list = D().quotes.filter((q) => { const st = quoteSt(q); return f === 'all' || st === f || (f === 'sent' && st === 'expired'); })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.no < b.no ? 1 : -1));
  const chip = (k, t) => `<button class="chip" data-act="quotef" data-f="${k}" aria-pressed="${f === k}">${t}</button>`;
  return `${head('Hinnapakkumised', 'Pakkumine ei lähe raamatupidamisse. Kui klient on nõus, tee pakkumisest ühe nupuga arve.', canWrite() && !D().quotesMissing ? '<button class="btn primary" data-act="new-quote">Uus pakkumine</button>' : '')}
  ${D().quotesMissing ? '<div class="banner"><span>Pakkumiste kasutamiseks käivita Supabase\'i SQL Editoris fail <b>0004_quotes.sql</b> ja värskenda lehte.</span></div>' : ''}
  <section class="panel"><header><div class="chips">${chip('all', 'Kõik')}${chip('draft', 'Mustandid')}${chip('sent', 'Saadetud')}${chip('accepted', 'Kinnitatud')}${chip('invoiced', 'Arve tehtud')}</div><span class="muted mono small">${list.length} pakkumist</span></header>
  ${list.length ? `<div class="tbl"><table><thead><tr><th>Nr</th><th>Kuupäev</th><th>Klient</th><th>Kehtib kuni</th><th class="num">Km-ta</th><th class="num">Kokku</th><th>Olek</th></tr></thead><tbody>
  ${list.map((q) => `<tr class="click" data-act="open-quote" data-id="${q.id}"><td class="mono">${esc(q.no)}</td><td class="mono">${fd(q.date)}</td><td>${esc(q.contact_name)}${contactOf(q)?.person ? ' <span class="muted small">eraisik</span>' : ''}</td><td class="mono">${fd(q.valid_until)}</td><td class="num">${n2(q.net)}</td><td class="num"><b>${n2(q.gross)}</b></td><td>${qpill(quoteSt(q))}</td></tr>`).join('')}
  </tbody></table></div>` : `<div class="empty"><b>${D().quotes.length ? 'Selle filtriga pakkumisi pole' : 'Pakkumisi pole veel'}</b><span>Koosta pakkumine ettevõttele või eraisikule. Kinnitatud pakkumisest saab kohe arve.</span>${canWrite() && !D().quotes.length && !D().quotesMissing ? '<button class="btn primary" data-act="new-quote">Koosta esimene pakkumine</button>' : ''}</div>`}</section>`;
}

function quoteForm(q, copyFrom) {
  const c = D().company, t = today(), revAccs = revenueChoices();
  const src = q || copyFrom;
  const d = src ? { ...src, lines: D().quoteLinesBy[src.id] || [] } : { contact_name: '', notes: '', lines: [{ description: '', qty: 1, unit: 'tk', price: '', vat_rate: c.vat_payer ? 24 : 0, account: '4000' }] };
  if (!q) { d.no = nextQuoteNo(); d.date = t; d.valid_until = addDays(t, 30); }
  openModal(`${mHead(q ? `Muuda pakkumist ${esc(q.no)}` : 'Uus hinnapakkumine')}
  <form data-form="quote" data-id="${q ? q.id : ''}"><div class="body form">
    ${clientPanel(d.contact_name, 'fq')}
    <div class="fgrid">
      <label class="field"><span>Pakkumise number</span><input id="fqN" name="no" value="${esc(d.no)}" required class="mono"></label>
      <label class="field"><span>Kuupäev</span><input id="fqD" name="date" type="date" value="${d.date}" required></label>
      <label class="field"><span>Kehtib kuni</span><input id="fqV" name="valid_until" type="date" value="${d.valid_until}" required></label>
    </div>${contactList()}
    <div class="tbl"><table class="lines"><thead><tr><th>Kirjeldus</th><th>Kogus</th><th>Ühik</th><th>Hind</th><th>KM</th>${revAccs.length > 1 ? '<th>Tulukonto</th>' : ''}<th class="num">Summa</th><th></th></tr></thead><tbody id="lnBody">${d.lines.map((l) => lineRow(l, revAccs)).join('')}</tbody></table></div>
    <div><button type="button" class="btn sm" data-act="addline">Lisa rida</button></div>
    <div class="totals" id="invTot"></div>
    <label class="field"><span>Märkus pakkumisel</span><textarea id="fqNote" name="notes" rows="2" placeholder="Nt tööde kirjeldus, tähtajad, tingimused">${esc(d.notes || '')}</textarea></label>
    <div class="err" id="fErr"></div>
  </div><footer><span></span><div class="row"><button type="button" class="btn" data-act="close">Loobu</button><button class="btn primary" type="submit">Salvesta pakkumine</button></div></footer></form>`);
  recalcInvoice(sheet.querySelector('form'));
}
async function saveQuoteForm(f) {
  const err = f.querySelector('#fErr');
  const L = readLines(f).filter((l) => l.description || l.price);
  const name = f.client.value.trim();
  if (!name) { err.textContent = 'Lisa kliendi nimi.'; return; }
  if (!L.length || L.some((l) => !l.description)) { err.textContent = 'Igal real peab olema kirjeldus.'; return; }
  if (f.valid_until.value < f.date.value) { err.textContent = 'Kehtivus ei saa lõppeda enne pakkumise kuupäeva.'; return; }
  await act(async () => {
    const contactId = await saveClientContact(f);
    return api.saveQuote({ id: f.dataset.id || null, company_id: S.cid, no: f.no.value.trim(), contact_id: contactId, contact_name: name,
      date: f.date.value, valid_until: f.valid_until.value, notes: f.notes.value.trim(), lines: L });
  }, 'Pakkumine salvestatud', (id) => { closeModal(); openQuote(id); });
}
function openQuote(id) {
  const q = D().quotes.find((x) => x.id === id);
  if (!q) return;
  const st = quoteSt(q), w = canWrite();
  let left = '', actions = `<button class="btn" data-act="print-quote" data-id="${id}">Prindi / PDF</button><button class="btn" data-act="copy-quote" data-id="${id}">Tee koopia</button>`;
  if (q.status === 'invoiced') {
    actions += q.invoice_id && D().invById[q.invoice_id] ? `<button class="btn primary" data-act="open-inv" data-id="${q.invoice_id}">Ava arve ${esc(D().invById[q.invoice_id].no)}</button>` : '';
  } else if (w) {
    left = `<span class="row" id="delZone"><button class="btn danger" data-act="quote-del-ask" data-id="${id}">Kustuta</button></span>`;
    actions += `<button class="btn" data-act="edit-quote" data-id="${id}">Muuda</button>`;
    if (q.status === 'draft') actions += `<button class="btn" data-act="quote-status" data-s="sent" data-id="${id}">Märgi saadetuks</button>`;
    if (q.status === 'sent') actions += `<button class="btn" data-act="quote-status" data-s="declined" data-id="${id}">Tagasi lükatud</button><button class="btn" data-act="quote-status" data-s="accepted" data-id="${id}">Klient kinnitas</button>`;
    if (q.status === 'declined') actions += `<button class="btn" data-act="quote-status" data-s="sent" data-id="${id}">Taasta</button>`;
    if (q.status !== 'declined') actions += `<span class="row" id="qiZone"><button class="btn primary" data-act="quote-inv-ask" data-id="${id}">Koosta arve</button></span>`;
  }
  openModal(`${mHead(`Hinnapakkumine ${esc(q.no)} ${qpill(st)}`)}<div class="body"><iframe class="docframe" title="Pakkumise eelvaade" srcdoc="${esc(quoteDocFor(q))}"></iframe><div class="err" id="fErr"></div></div>
    <footer>${left || '<span></span>'}<div class="row">${actions}</div></footer>`);
}

function vInvoices() {
  const f = S.invFilter;
  const match = (i) => { const st = invInfo(i).st; return f === 'all' || (f === 'open' ? ['open', 'partial', 'late'].includes(st) : st === f); };
  const list = D().invoices.filter(match).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.no < b.no ? 1 : -1));
  const chip = (k, t) => `<button class="chip" data-act="invf" data-f="${k}" aria-pressed="${f === k}">${t}</button>`;
  const ePill = (i) => (i.e_sent ? ' <span class="pill paid">e-arve</span>' : contactOf(i)?.einvoice && i.status === 'issued' && i.kind === 'invoice' ? ' <span class="pill soon">e-arve saatmata</span>' : '');
  return `${head('Müügiarved', 'Mustandit saab muuta. Kinnitatud arve kirjendatakse ja seda enam muuta ei saa; vea korral koosta kreeditarve.', canWrite() ? '<button class="btn primary" data-act="new-inv">Uus müügiarve</button>' : '')}
  <section class="panel"><header><div class="chips">${chip('all', 'Kõik')}${chip('draft', 'Mustandid')}${chip('open', 'Laekumata')}${chip('late', 'Üle tähtaja')}${chip('paid', 'Laekunud')}</div><span class="muted mono small">${list.length} arvet</span></header>
  ${list.length ? `<div class="tbl"><table><thead><tr><th>Nr</th><th>Kuupäev</th><th>Klient</th><th>Tähtaeg</th><th class="num">Km-ta</th><th class="num">Kokku</th><th class="num">Tasumata</th><th>Olek</th></tr></thead><tbody>
  ${list.map((i) => { const x = invInfo(i); return `<tr class="click" data-act="open-inv" data-id="${i.id}"><td class="mono">${esc(i.no)}</td><td class="mono">${fd(i.date)}</td><td>${esc(i.contact_name)}${ePill(i)}</td><td class="mono">${i.kind === 'credit' ? '—' : fd(i.due)}</td><td class="num">${n2(i.net)}</td><td class="num"><b>${n2(i.gross)}</b></td><td class="num">${['draft', 'credit', 'credited'].includes(x.st) ? '' : n2(x.open)}</td><td>${pill(x.st, i.due)}</td></tr>`; }).join('')}
  </tbody></table></div>` : `<div class="empty"><b>${D().invoices.length ? 'Selle filtriga arveid pole' : 'Müügiarveid pole veel'}</b><span>Arvele lisatakse viitenumber, KMKR number ja IBAN sinu seadetest.</span></div>`}</section>`;
}

function vExpenses() {
  const f = S.expFilter;
  const match = (x) => { const st = expInfo(x).st; return f === 'all' ? st !== 'cancelled' : f === 'open' ? ['open', 'partial', 'late', 'soon'].includes(st) : st === f; };
  const list = D().expenses.filter(match).sort((a, b) => (a.date < b.date ? 1 : -1));
  const chip = (k, t) => `<button class="chip" data-act="expf" data-f="${k}" aria-pressed="${f === k}">${t}</button>`;
  return `${head('Ostuarved ja kulud', 'Sisesta summa koos käibemaksuga. Muutmisel tehakse vanale kandele automaatselt storno ja kirjendatakse uus.', canWrite() ? '<button class="btn primary" data-act="new-exp">Lisa kulu</button>' : '')}
  <section class="panel"><header><div class="chips">${chip('all', 'Kõik')}${chip('open', 'Tasumata')}${chip('paid', 'Tasutud')}${chip('cancelled', 'Tühistatud')}</div><span class="muted mono small">${list.length} dokumenti</span></header>
  ${list.length ? `<div class="tbl"><table><thead><tr><th>Kuupäev</th><th>Tarnija</th><th>Dok nr</th><th>Kulukonto</th><th class="num">Km-ta</th><th class="num">KM</th><th class="num">Kokku</th><th>Olek</th></tr></thead><tbody>
  ${list.map((x) => { const st = expInfo(x).st; return `<tr class="click ${st === 'cancelled' ? 'cancelled' : ''}" data-act="open-exp" data-id="${x.id}"><td class="mono">${fd(x.date)}</td><td><b>${esc(x.supplier)}</b>${x.attachment_path ? ' <span class="muted small" title="Dokument lisatud">📎</span>' : ''}<div class="muted small">${esc(x.description || '')}</div></td><td class="mono">${esc(x.doc_no || '—')}</td><td><span class="mono muted">${x.account}</span> ${esc(accName(x.account))}</td><td class="num">${n2(x.net)}</td><td class="num">${n2(x.vat)}</td><td class="num"><b>${n2(x.gross)}</b></td><td>${pill(st, x.due)}</td></tr>`; }).join('')}
  </tbody></table></div>` : '<div class="empty"><b>Kulusid pole</b><span>Lisa ostuarve, tšekk või kaardimakse. Pangaväljavõttest saab kulusid ka importida.</span></div>'}</section>`;
}

function vContacts() {
  const d = D();
  const list = [...d.contacts].sort((a, b) => a.name.localeCompare(b.name, 'et'));
  const typ = { client: 'Klient', supplier: 'Tarnija', both: 'Klient ja tarnija' };
  const sales = (c) => r2(d.invoices.filter((i) => i.status === 'issued' && i.contact_id === c.id).reduce((s, i) => s + num(i.net), 0));
  const buys = (c) => r2(d.expenses.filter((x) => x.status === 'active' && x.contact_id === c.id).reduce((s, x) => s + num(x.net), 0));
  return `${head('Kliendid ja tarnijad', 'Uued partnerid lisanduvad ka arve või kulu sisestamisel automaatselt.', canWrite() ? '<button class="btn primary" data-act="new-contact">Lisa partner</button>' : '')}
  <section class="panel">${list.length ? `<div class="tbl"><table><thead><tr><th>Nimi</th><th>Liik</th><th>Registrikood</th><th>KMKR</th><th>E-post</th><th class="num">Müük km-ta</th><th class="num">Ost km-ta</th></tr></thead><tbody>
  ${list.map((c) => `<tr class="click" data-act="edit-contact" data-id="${c.id}"><td><b>${esc(c.name)}</b>${c.einvoice ? ' <span class="pill open">e-arve</span>' : ''}</td><td>${typ[c.kind] || '—'}${c.person ? ' · eraisik' : ''}</td><td class="mono">${esc(c.regcode || '—')}</td><td class="mono">${esc(c.vatno || '—')}</td><td>${esc(c.email || '—')}</td><td class="num">${n2(sales(c))}</td><td class="num">${n2(buys(c))}</td></tr>`).join('')}
  </tbody></table></div>` : '<div class="empty"><b>Partnereid pole veel</b><span>Lisa kliente ja tarnijaid koos registrikoodi ja KMKR numbriga.</span></div>'}</section>`;
}

function vBank() {
  const b = S.bank;
  let rows = '';
  if (b) {
    rows = b.rows.length ? `<div class="tbl"><table><thead><tr><th>Kuupäev</th><th>Partner ja selgitus</th><th class="num">Summa</th><th>Vaste</th><th></th></tr></thead><tbody>
    ${b.rows.map((r, ix) => {
      let m = '', a = '';
      if (r.done) m = '<span class="pill paid">Seotud</span>';
      else if (r.match) {
        const o = r.match.type === 'inv' ? D().invById[r.match.id] : D().expenses.find((x) => x.id === r.match.id);
        if (o) {
          m = r.match.type === 'inv' ? `Arve <b class="mono">${esc(o.no)}</b> · ${esc(o.contact_name)}` : `Ostuarve · ${esc(o.supplier)}`;
          m += `<div class="muted small">${esc(r.match.why)}</div>`;
          if (canWrite()) a = `<button class="btn sm primary" data-act="bank-link" data-ix="${ix}">Seo</button>`;
        }
      } else {
        m = '<span class="muted">Vastet ei leitud</span>';
        if (r.amount < 0 && canWrite()) a = `<button class="btn sm" data-act="bank-exp" data-ix="${ix}">Lisa kuluna</button>`;
      }
      return `<tr><td class="mono">${fd(r.date)}</td><td><b>${esc(r.partner || '—')}</b><div class="muted small">${esc(r.desc || '')}${r.ref ? ` · viide ${esc(r.ref)}` : ''}</div></td><td class="num" style="color:${r.amount < 0 ? 'var(--ink)' : 'var(--good)'}">${r.amount < 0 ? '−' : '+'}${n2(Math.abs(r.amount))}</td><td>${m}</td><td class="num">${a}</td></tr>`;
    }).join('')}</tbody></table></div>` : '<div class="empty"><b>Failist ei leitud tehinguid</b><span>Kontrolli, et fail on panga CSV-väljavõte.</span></div>';
  }
  const matched = b ? b.rows.filter((r) => r.match && !r.done).length : 0;
  return `${head('Pank', 'Laadi internetipangast alla konto väljavõte CSV-vormingus ja seo laekumised arvetega. Sobib Swedbanki, SEB, LHV ja Coop Panga failiga.', b && matched && canWrite() ? `<button class="btn primary" data-act="bank-link-all">Seo kõik ${matched} vastet</button>` : '')}
  <section class="panel"><div class="pad">
    <label class="drop" id="drop" for="bankFile"><b>${b ? esc(b.fileName) : 'Vali pangaväljavõtte fail'}</b>
      <span class="muted small">${b ? `${b.rows.length} tehingut · ${matched} soovitatud vastet` : 'Fail loetakse ainult sinu brauseris ja seda ei salvestata.'}</span>
      <span class="btn sm">${b ? 'Vali teine fail' : 'Vali fail'}</span><input type="file" id="bankFile" accept=".csv,text/csv,text/plain" hidden></label>
  </div>${rows}</section>
  <p class="note">Vaste leitakse viitenumbri, arve numbri või summa järgi. Laekumine kirjendatakse kandega D 1020 / K 1210, tasumine D 2110 / K 1020.</p>`;
}

const SRC = { invoice: 'Arve', payment: 'Makse', expense: 'Ostuarve', manual: 'Käsitsi', vat: 'Käibemaks', vatpay: 'Käibemaks', reversal: 'Storno', import: 'Import' };
function vLedger() {
  const d = D(), tab = S.ledgerTab;
  const sub = `<div class="subtabs" role="tablist"><button role="tab" data-act="ltab" data-t="journal" aria-selected="${tab === 'journal'}">Päevaraamat</button><button role="tab" data-act="ltab" data-t="trial" aria-selected="${tab === 'trial'}">Käibeandmik</button></div>`;
  let body;
  if (tab === 'journal') {
    const acc = S.ledgerAcc;
    const list = (acc ? d.entries.filter((e) => e.lines.some((l) => l.account === acc)) : d.entries).slice().reverse().slice(0, 400);
    const byId = Object.fromEntries(d.entries.map((e) => [e.id, e]));
    const B = acc ? balances(d.ledger, null, null) : null;
    body = `<header><select id="ledgerAcc" data-bind="ledgerAcc" aria-label="Konto" style="width:auto"><option value="">Kõik kontod</option>${accOpts(d.accounts.map((a) => a.code), acc)}</select>${acc ? `<span class="mono small">Saldo ${eur(bal(B, acc))}</span>` : `<span class="muted mono small">${d.entries.length} kannet</span>`}</header>
    ${list.length ? `<div class="tbl"><table><thead><tr><th>Nr</th><th>Kuupäev</th><th>Konto</th><th class="num">Deebet</th><th class="num">Kreedit</th></tr></thead><tbody>
    ${list.map((e) => {
      const rev = d.reversed.has(e.id), canRev = canWrite() && !rev && ['manual', 'vat', 'vatpay', 'import'].includes(e.source);
      const tag = e.reversal_of ? ` <span class="pill rev">storno kandele nr ${byId[e.reversal_of]?.no ?? '?'}</span>` : rev ? ' <span class="pill rev">stornitud</span>' : '';
      return `<tr class="entry-head"><td class="mono">${e.no}</td><td class="mono">${fd(e.date)}</td><td colspan="2">${esc(e.description)} <span class="muted">· ${SRC[e.source] || e.source}</span>${tag}</td><td class="num">${canRev ? `<button class="btn sm ghost" data-act="rev-ask" data-id="${e.id}">Storno</button>` : ''}</td></tr>`
        + e.lines.filter((l) => !acc || l.account === acc).map((l) => `<tr><td></td><td></td><td><span class="mono muted">${l.account}</span> ${esc(l.account_name)}</td><td class="num">${num(l.debit) ? n2(l.debit) : ''}</td><td class="num">${num(l.credit) ? n2(l.credit) : ''}</td></tr>`).join('');
    }).join('')}</tbody></table></div>` : '<div class="empty"><b>Kandeid pole</b><span>Kanded tekivad arvetest, kuludest ja maksetest. Algsaldod sisesta käsitsi kandena.</span></div>'}`;
  } else {
    const { from, to } = S.rep;
    const before = balances(d.ledger, null, addDays(from, -1)), per = balances(d.ledger, from, to);
    const accs = [...new Set([...Object.keys(before), ...Object.keys(per)])].sort();
    let td = 0, tk = 0;
    body = `<header><div class="row"><span class="muted small">Periood</span><input type="date" id="tbFrom" data-bind="rep.from" value="${from}" style="width:auto" aria-label="Algus"><span class="muted">–</span><input type="date" id="tbTo" data-bind="rep.to" value="${to}" style="width:auto" aria-label="Lõpp"></div></header>
    <div class="tbl"><table><thead><tr><th>Konto</th><th class="num">Algsaldo</th><th class="num">Deebetkäive</th><th class="num">Kreeditkäive</th><th class="num">Lõppsaldo</th></tr></thead><tbody>
    ${accs.map((a) => {
      const p = per[a] || { d: 0, k: 0 }; td += p.d; tk += p.k;
      const type = (per[a] || before[a]).type, pl = type === 'R' || type === 'X';
      const s0 = pl ? 0 : bal(before, a), mv = type === 'A' || type === 'X' ? p.d - p.k : p.k - p.d;
      return `<tr class="click" data-act="acc-open" data-a="${a}"><td><span class="mono muted">${a}</span> ${esc(accName(a))}</td><td class="num">${n2(s0)}</td><td class="num">${n2(p.d)}</td><td class="num">${n2(p.k)}</td><td class="num"><b>${n2(s0 + mv)}</b></td></tr>`;
    }).join('')}</tbody><tfoot><tr><td>Kokku</td><td></td><td class="num">${n2(td)}</td><td class="num">${n2(tk)}</td><td class="num">${Math.abs(r2(td - tk)) < 0.01 ? '<span class="pill paid">Tasakaalus</span>' : `<span class="pill late">Erinevus ${n2(td - tk)}</span>`}</td></tr></tfoot></table></div>`;
  }
  return `${head('Pearaamat', 'Kandeid ei saa muuta ega kustutada. Vea korral tee stornokanne.', canWrite() ? '<button class="btn primary" data-act="new-jr">Uus käsitsi kanne</button>' : '')}${sub}<section class="panel">${body}</section>`;
}

function vReports() {
  const d = D(), tab = S.repTab;
  const sub = `<div class="subtabs" role="tablist"><button role="tab" data-act="rtab" data-t="pl" aria-selected="${tab === 'pl'}">Kasumiaruanne</button><button role="tab" data-act="rtab" data-t="bs" aria-selected="${tab === 'bs'}">Bilanss</button><button role="tab" data-act="rtab" data-t="kmd" aria-selected="${tab === 'kmd'}">Käibedeklaratsioon</button></div>`;
  let body;
  if (tab === 'pl') {
    const { B, rev, cost, profit: pr } = profit(d.ledger, S.rep.from, S.rep.to);
    const rows = (t) => Object.keys(B).filter((a) => B[a].type === t && bal(B, a)).sort().map((a) => `<tr><td class="ind"><span class="mono muted">${a}</span> ${esc(accName(a))}</td><td class="num">${n2(bal(B, a))}</td></tr>`).join('');
    body = `<header><h2>Kasumiaruanne</h2><div class="row"><input type="date" id="plFrom" data-bind="rep.from" value="${S.rep.from}" style="width:auto" aria-label="Algus"><span class="muted">–</span><input type="date" id="plTo" data-bind="rep.to" value="${S.rep.to}" style="width:auto" aria-label="Lõpp"></div></header>
    <div class="tbl"><table class="rep"><tbody>
      <tr><td><b>Tulud</b></td><td></td></tr>${rows('R') || '<tr><td class="ind muted">Tulusid pole</td><td></td></tr>'}<tr class="sum"><td>Tulud kokku</td><td class="num">${n2(rev)}</td></tr>
      <tr><td><b>Kulud</b></td><td></td></tr>${rows('X') || '<tr><td class="ind muted">Kulusid pole</td><td></td></tr>'}<tr class="sum"><td>Kulud kokku</td><td class="num">${n2(cost)}</td></tr>
      <tr class="grand"><td>${pr >= 0 ? 'Aruandeperioodi kasum' : 'Aruandeperioodi kahjum'}</td><td class="num">${n2(pr)}</td></tr>
    </tbody></table></div><div class="pad"><p class="note">Eestis jaotamata kasumit tulumaksuga ei maksustata. Tulumaks tuleb tasuda siis, kui kasumit jaotatakse dividendidena või tehakse muid väljamakseid.</p></div>`;
  } else if (tab === 'bs') {
    const t = S.rep.asof, B = balances(d.ledger, null, t), ys = `${t.slice(0, 4)}-01-01`;
    const prior = profit(d.ledger, null, addDays(ys, -1)).profit, cur = profit(d.ledger, ys, t).profit;
    const sect = (ty) => Object.keys(B).filter((a) => B[a].type === ty && bal(B, a)).sort();
    const A = sect('A'), L = sect('L'), Q = sect('E');
    const sum = (arr) => r2(arr.reduce((s, a) => s + bal(B, a), 0));
    const sa = sum(A), sl = sum(L), sq = r2(sum(Q) + prior + cur), ok = Math.abs(sa - sl - sq) < 0.01;
    const rr = (a) => `<tr><td class="ind"><span class="mono muted">${a}</span> ${esc(accName(a))}</td><td class="num">${n2(bal(B, a))}</td></tr>`;
    body = `<header><h2>Bilanss</h2><div class="row"><span class="muted small">Seisuga</span><input type="date" id="bsAsof" data-bind="rep.asof" value="${t}" style="width:auto" aria-label="Seisuga">${ok ? '<span class="pill paid">Tasakaalus</span>' : '<span class="pill late">Ei ole tasakaalus</span>'}</div></header>
    <div class="tbl"><table class="rep"><tbody>
      <tr><td><b>Varad</b></td><td></td></tr>${A.map(rr).join('') || '<tr><td class="ind muted">—</td><td></td></tr>'}<tr class="grand"><td>Varad kokku</td><td class="num">${n2(sa)}</td></tr>
      <tr><td><b>Kohustised</b></td><td></td></tr>${L.map(rr).join('') || '<tr><td class="ind muted">—</td><td></td></tr>'}<tr class="sum"><td>Kohustised kokku</td><td class="num">${n2(sl)}</td></tr>
      <tr><td><b>Omakapital</b></td><td></td></tr>${Q.map(rr).join('')}${prior ? `<tr><td class="ind">Eelmiste perioodide kasum</td><td class="num">${n2(prior)}</td></tr>` : ''}<tr><td class="ind">Aruandeaasta kasum</td><td class="num">${n2(cur)}</td></tr>
      <tr class="sum"><td>Omakapital kokku</td><td class="num">${n2(sq)}</td></tr><tr class="grand"><td>Kohustised ja omakapital kokku</td><td class="num">${n2(sl + sq)}</td></tr>
    </tbody></table></div>`;
  } else {
    const k = S.rep.month, v = vatMonth(k, d.invoices, d.linesBy, d.expenses), pay = r2(v.outVat - v.inVat);
    const done = (src) => d.entries.some((e) => e.source === src && e.source_ref === k && !d.reversed.has(e.id));
    const [y, m] = k.split('-').map(Number), due = iso(new Date(y, m, 20));
    const regOf = (n) => d.contacts.find((c) => c.name === n)?.regcode || '—';
    const infA = kmdInf(v.invs, (i) => i.contact_name, (i) => i.net), infB = kmdInf(v.exps, (x) => x.supplier, (x) => x.net);
    const months = []; { const x = new Date(); x.setDate(1); for (let i = 0; i < 18; i++) { const z = new Date(x); z.setMonth(x.getMonth() - i); months.push(iso(z).slice(0, 7)); } }
    if (!months.includes(k)) months.push(k);
    const infT = (rows, empty) => (rows.length ? `<div class="tbl"><table><thead><tr><th>Registrikood</th><th>Partner</th><th>Arve</th><th>Kuupäev</th><th class="num">Km-ta</th></tr></thead><tbody>${rows.map((g) => g.docs.map((o) => `<tr><td class="mono">${esc(regOf(g.name))}</td><td>${esc(g.name)}</td><td class="mono">${esc(o.no || o.doc_no || '—')}</td><td class="mono">${fd(o.date)}</td><td class="num">${n2(o.net)}</td></tr>`).join('')).join('')}</tbody></table></div>` : `<div class="pad muted small">${empty}</div>`);
    body = `<header><h2>Käibedeklaratsioon (KMD)</h2><select id="kmdMonth" data-bind="rep.month" style="width:auto" aria-label="Kuu">${months.sort().reverse().map((x) => `<option value="${x}" ${x === k ? 'selected' : ''}>${monthLabel(x)}</option>`).join('')}</select></header>
    ${!d.company.vat_payer ? '<div class="pad"><div class="banner">Ettevõte ei ole seadete järgi käibemaksukohustuslane. KMD-d esitama ei pea.</div></div>' : ''}
    <div class="tbl"><table class="kmd"><thead><tr><th>Rida</th><th>Näitaja</th><th class="num">Maksustatav väärtus</th><th class="num">Käibemaks</th></tr></thead><tbody>
      ${[24, 13, 9].map((r) => `<tr><td>${KMD_ROW[r]}</td><td>${r}% määraga maksustatavad toimingud ja tehingud</td><td class="num">${n2(v.out[r].net)}</td><td class="num">${n2(v.out[r].vat)}</td></tr>`).join('')}
      <tr><td>3</td><td>0% määraga maksustatavad toimingud ja tehingud</td><td class="num">${n2(v.out[0].net)}</td><td></td></tr>
      <tr><td>4</td><td><b>Käibemaks kokku</b></td><td></td><td class="num"><b>${n2(v.outVat)}</b></td></tr>
      <tr><td>5</td><td>Sisendkäibemaks, mis on lubatud maha arvata</td><td class="num muted">${n2(v.inNet)}</td><td class="num">${n2(v.inVat)}</td></tr>
      <tr><td>12</td><td><b>Tasumisele kuuluv käibemaks</b></td><td></td><td class="num"><b>${pay > 0 ? n2(pay) : '0,00'}</b></td></tr>
      <tr><td>13</td><td><b>Enammakstud käibemaks</b></td><td></td><td class="num"><b>${pay < 0 ? n2(-pay) : '0,00'}</b></td></tr>
    </tbody></table></div>
    <div class="pad row" style="justify-content:space-between"><span class="note">Esita KMD ja tasu käibemaks EMTA-le hiljemalt <b>${fd(due)}</b>. Kontrolli ridu enne esitamist e-maksuametis.</span>
      ${canWrite() && d.company.vat_payer ? `<span class="row">${done('vat') ? '<span class="pill paid">Tasaarveldus kirjendatud</span>' : `<button class="btn sm" data-act="vat" data-k="settle" data-amt="${v.inVat}" ${v.inVat > 0 ? '' : 'disabled'}>Kirjenda tasaarveldus</button>`}${pay > 0 ? (done('vatpay') ? '<span class="pill paid">Tasumine kirjendatud</span>' : `<button class="btn sm" data-act="vat" data-k="pay" data-amt="${pay}">Kirjenda tasumine EMTA-le</button>`) : ''}</span>` : ''}</div>
    <div class="pad" style="border-top:1px solid var(--line-2)"><h3 style="font-size:15px">KMD INF lisa</h3><p class="note" style="margin-top:4px">Arved partnerite kohta, kellega kuu tehingud on vähemalt 1000 € käibemaksuta.</p></div>
    <div class="pad" style="padding-top:0"><span class="label">A-osa · müügiarved</span></div>${infT(infA, 'Ühegi kliendiga ei ületatud 1000 € piiri.')}
    <div class="pad" style="padding-bottom:0"><span class="label">B-osa · ostuarved</span></div>${infT(infB, 'Ühegi tarnijaga ei ületatud 1000 € piiri.')}`;
  }
  return `${head('Aruanded', 'Arvutatakse otse pearaamatu kannetest.')}${sub}<section class="panel">${body}</section>`;
}

function vSettings() {
  const c = D().company, owner = S.role === 'owner', dis = canWrite() ? '' : 'disabled';
  const others = S.members.filter((m) => m.company_id !== S.cid);
  return `${head('Seaded', 'Ettevõtte andmed ilmuvad müügiarvetele ja e-arvetele.')}
  <section class="panel"><header><h2>Ettevõte</h2></header><form class="form pad" data-form="company">
    <div class="fgrid">
      <label class="field"><span>Ärinimi</span><input id="coN" name="name" value="${esc(c.name)}" required ${dis}></label>
      <label class="field"><span>Registrikood</span><input id="coR" name="regcode" value="${esc(c.regcode)}" inputmode="numeric" ${dis}></label>
      <label class="field"><span>KMKR number</span><input id="coV" name="vatno" value="${esc(c.vatno)}" placeholder="EE123456789" ${dis}></label>
      <label class="field"><span>E-post</span><input id="coE" name="email" type="email" value="${esc(c.email)}" ${dis}></label>
      <label class="field"><span>Telefon</span><input id="coP" name="phone" value="${esc(c.phone)}" ${dis}></label>
      <label class="field"><span>Aadress</span><input id="coA" name="address" value="${esc(c.address)}" placeholder="Tänav 1, 10111 Tallinn" ${dis}></label>
      <label class="field"><span>Pank</span><input id="coB" name="bank" value="${esc(c.bank)}" ${dis}></label>
      <label class="field"><span>IBAN</span><input id="coI" name="iban" value="${esc(c.iban)}" ${dis}></label>
      <label class="field"><span>Arve numbri eesliide</span><input id="coX" name="invoice_prefix" value="${esc(c.invoice_prefix)}" ${dis}></label>
      <label class="field"><span>Maksetähtaeg (päeva)</span><input id="coT" name="payment_term_days" type="number" min="0" max="365" value="${esc(c.payment_term_days)}" ${dis}></label>
    </div>
    <label class="check"><input type="checkbox" id="coVP" name="vat_payer" ${c.vat_payer ? 'checked' : ''} ${dis}> Ettevõte on käibemaksukohustuslane</label>
    <div class="err" id="fErr"></div>
    ${canWrite() ? '<div class="row"><button class="btn primary" type="submit">Salvesta</button></div>' : ''}
  </form></section>

  <section class="panel"><header><h2>Arve kujundus</h2><button class="btn sm" data-act="design-preview">Vaata näidist</button></header>
    <form class="form pad" data-form="design">
      <div class="row" style="gap:24px;align-items:flex-start">
        <div class="field"><span>Logo</span>
          <div class="row">${c.logo ? `<img src="${esc(c.logo)}" alt="Logo" style="max-height:56px;max-width:180px;border:1px solid var(--line);border-radius:6px;padding:6px;background:#fff">` : '<span class="muted small">Logo pole lisatud</span>'}
          ${canWrite() ? `<label class="btn sm" for="logoFile">${c.logo ? 'Vaheta' : 'Lisa logo'}<input type="file" id="logoFile" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden></label>${c.logo ? '<button type="button" class="btn sm ghost" data-act="logo-remove">Eemalda</button>' : ''}` : ''}</div>
          <span class="muted small">PNG, JPG või SVG. Läbipaistva taustaga logo näeb kõige parem välja.</span></div>
        <label class="field"><span>Arve põhivärv</span><span class="row"><input type="color" id="dColor" name="invoice_color" value="${esc(c.invoice_color || '#1C5DC2')}" style="width:56px;height:36px;padding:2px" ${dis}>
          ${['#1C5DC2', '#0F766E', '#7C3AED', '#B4472D', '#1F2937'].map((col) => `<button type="button" class="swatch" data-act="swatch" data-c="${col}" style="background:${col}" aria-label="Värv ${col}"></button>`).join('')}</span></label>
      </div>
      <div class="err" id="fErr"></div>
      ${canWrite() ? '<div class="row"><button class="btn primary" type="submit">Salvesta värv</button></div>' : ''}
    </form></section>

  <section class="panel"><header><h2>Perioodi sulgemine</h2></header><form class="form pad" data-form="lock">
    <p class="note">Pärast deklaratsioonide esitamist sulge periood. Siis ei saa kogemata lisada kandeid, mis muudaksid juba esitatud numbreid.</p>
    <div class="row"><label class="field" style="max-width:220px"><span>Suletud kuni (kaasa arvatud)</span><input id="lockD" name="lock_date" type="date" value="${c.lock_date || ''}" ${owner ? '' : 'disabled'}></label>
    ${owner ? '<button class="btn" type="submit" style="align-self:flex-end">Salvesta</button>' : '<span class="muted small">Perioodi saab sulgeda ainult omanik.</span>'}</div>
  </form></section>

  <section class="panel"><header><h2>Kontoplaan</h2>${canWrite() ? '<button class="btn sm" data-act="new-account">Lisa konto</button>' : ''}</header>
    <div class="tbl"><table><thead><tr><th>Konto</th><th>Nimi</th><th>Liik</th><th></th></tr></thead><tbody>
    ${D().accounts.map((a) => `<tr class="${a.active ? '' : 'cancelled'}"><td class="mono">${a.code}</td><td>${esc(a.name)}</td><td>${{ A: 'Vara', L: 'Kohustis', E: 'Omakapital', R: 'Tulu', X: 'Kulu' }[a.type]}</td><td class="num">${canWrite() && !a.is_system ? `<button class="btn sm ghost" data-act="toggle-account" data-a="${a.code}">${a.active ? 'Peida' : 'Taasta'}</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div></section>

  <section class="panel"><header><h2>Turvalisus</h2></header><div class="pad stack" id="mfaBox">${mfaBox()}</div></section>

  <section class="panel"><header><h2>Andmed</h2></header><div class="pad stack">
    <div class="row" style="justify-content:space-between"><div><b>Too andmed Saldo prototüübist</b><div class="muted small">Prototüübi seadetes vali „Laadi alla kõik andmed (JSON)“ ja lae see fail siia.</div></div>
      ${canWrite() ? '<label class="btn" for="impFile">Vali fail<input type="file" id="impFile" accept=".json,application/json" hidden></label>' : ''}</div>
    <div class="row" style="justify-content:space-between"><div><b>Ekspordi pearaamat</b><div class="muted small">Kõik kanded CSV-failina Excelile või raamatupidajale.</div></div><button class="btn" data-act="export-csv">Laadi alla CSV</button></div>
    <div class="row" style="justify-content:space-between"><div><b>Varukoopia</b><div class="muted small">Kõik andmed ühes JSON-failis.</div></div><button class="btn" data-act="export-json">Laadi alla JSON</button></div>
    <div class="row" style="justify-content:space-between"><div><b>Muudatuste ajalugu</b><div class="muted small">Viimased 100 muudatust dokumentides ja seadetes.</div></div><button class="btn" data-act="audit">Näita</button></div>
    ${S.audit ? auditTable() : ''}
  </div></section>

  <section class="panel"><header><h2>Ettevõtted</h2></header><div class="pad stack">
    ${others.length ? `<div class="row">${others.map((m) => `<button class="btn sm" data-act="switch-co" data-id="${m.company_id}">Ava ${esc(m.companies?.name || 'ettevõte')}</button>`).join('')}</div>` : ''}
    <form class="row" data-form="new-co"><input id="ncName" name="name" placeholder="Uue ettevõtte nimi" style="max-width:280px" required><button class="btn" type="submit">Loo uus ettevõte</button></form>
  </div></section>
  <p class="note">Saldo ei esita deklaratsioone ise. Kontrolli aruanded ja KMD enne esitamist üle või lase seda teha raamatupidajal.</p>`;
}
function mfaBox() {
  const m = S.mfa;
  if (!m) return '<span class="muted small">Laadin…</span>';
  if (m.enrolling) {
    return `<p style="margin:0">Skaneeri QR-kood autentimisrakendusega (nt Google Authenticator või Microsoft Authenticator) ja sisesta kuvatav kood.</p>
      <div class="qr"><img src="${esc(m.enrolling.totp.qr_code)}" alt="QR-kood"></div>
      <div class="small muted">Kui skaneerida ei saa, sisesta võti käsitsi: <span class="code">${esc(m.enrolling.totp.secret)}</span></div>
      <form class="row" data-form="mfa-verify"><input id="mvCode" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="123456" class="mono" style="max-width:140px" required><button class="btn primary" type="submit">Kinnita</button><button class="btn ghost" type="button" data-act="mfa-cancel">Loobu</button></form><div class="err" id="mfaErr"></div>`;
  }
  if (m.verified) return `<div class="row" style="justify-content:space-between"><div><b>Kaheastmeline kinnitus on sees</b><div class="muted small">Sisselogimisel küsitakse lisaks paroolile koodi telefonist.</div></div><span class="row" id="mfaOff"><button class="btn danger" data-act="mfa-off-ask">Lülita välja</button></span></div>`;
  return `<div class="row" style="justify-content:space-between"><div><b>Kaheastmeline kinnitus</b><div class="muted small">Soovitame tungivalt. Kui keegi saab su parooli teada, ei pääse ta ilma telefonita andmetele ligi.</div></div><button class="btn primary" data-act="mfa-on">Lülita sisse</button></div>`;
}
function auditTable() {
  const T = { companies: 'Ettevõte', contacts: 'Partner', accounts: 'Konto', invoices: 'Arve', expenses: 'Kulu', payments: 'Makse' };
  const A = { insert: 'lisatud', update: 'muudetud', delete: 'kustutatud' };
  const label = (r) => { const x = r.new_data || r.old_data || {}; return x.no || x.name || x.supplier || x.code || ''; };
  return `<div class="tbl"><table><thead><tr><th>Aeg</th><th>Mis</th><th>Toiming</th><th>Kes</th></tr></thead><tbody>${S.audit.map((r) => `<tr><td class="mono small">${fd(r.at.slice(0, 10))} ${r.at.slice(11, 16)}</td><td>${T[r.tbl] || r.tbl} <span class="muted">${esc(label(r))}</span></td><td>${A[r.action] || r.action}</td><td class="small">${r.user_id === S.user.id ? 'sina' : esc(String(r.user_id || 'süsteem').slice(0, 8))}</td></tr>`).join('')}</tbody></table></div>`;
}

// ====================================================================
// Dialoogid
// ====================================================================
const UNITS = [['tk', 'tk'], ['h', 'h (tund)']];
const decStr = (v) => (v === '' || v == null ? '' : String(+num(v)).replace('.', ','));
const unitOpts = (u) => {
  const cur = u || 'tk';
  const list = UNITS.some(([k]) => k === cur) ? UNITS : [...UNITS, [cur, cur]];
  return list.map(([k, t]) => `<option value="${esc(k)}" ${k === cur ? 'selected' : ''}>${esc(t)}</option>`).join('');
};

/** Kliendi plokk arve ja pakkumise vormil: nimi, liik (ettevõte/eraisik) ja kontaktandmed. */
function clientPanel(name, idp) {
  const c = D().contacts.find((x) => x.name === name) || {};
  const person = !!c.person;
  return `<div class="client">
    <div class="row" style="align-items:flex-end">
      <label class="field" style="flex:1;min-width:200px"><span>Klient</span><input id="${idp}C" name="client" list="contactsDL" value="${esc(name)}" required autocomplete="off" data-client-name></label>
      <div class="seg" role="radiogroup" aria-label="Kliendi liik">
        <label><input type="radio" name="ctype" value="company" ${person ? '' : 'checked'}><span>Ettevõte</span></label>
        <label><input type="radio" name="ctype" value="person" ${person ? 'checked' : ''}><span>Eraisik</span></label>
      </div>
    </div>
    <div class="fgrid">
      <label class="field" data-only="company" ${person ? 'hidden' : ''}><span>Registrikood</span><input id="${idp}cR" name="c_regcode" value="${esc(c.regcode || '')}" inputmode="numeric"></label>
      <label class="field" data-only="company" ${person ? 'hidden' : ''}><span>KMKR number</span><input id="${idp}cV" name="c_vatno" value="${esc(c.vatno || '')}"></label>
      <label class="field"><span>Aadress</span><input id="${idp}cA" name="c_address" value="${esc(c.address || '')}"></label>
      <label class="field"><span>E-post</span><input id="${idp}cE" name="c_email" type="email" value="${esc(c.email || '')}"></label>
      <label class="field"><span>Telefon</span><input id="${idp}cT" name="c_phone" type="tel" value="${esc(c.phone || '')}"></label>
    </div></div>`;
}
function applyClientType(f) {
  const person = f.ctype?.value === 'person';
  f.querySelectorAll('[data-only=company]').forEach((el) => { el.hidden = person; });
}
function fillClient(f) {
  const c = D().contacts.find((x) => x.name.trim().toLowerCase() === f.client.value.trim().toLowerCase());
  if (!c) return;
  f.c_regcode.value = c.regcode || ''; f.c_vatno.value = c.vatno || ''; f.c_address.value = c.address || '';
  f.c_email.value = c.email || ''; f.c_phone.value = c.phone || '';
  f.querySelector(`input[name=ctype][value=${c.person ? 'person' : 'company'}]`).checked = true;
  applyClientType(f);
}
/** Salvestab kliendi andmed (uus või olemasolev) ja tagastab id. */
async function saveClientContact(f) {
  const name = f.client.value.trim(), person = f.ctype.value === 'person';
  const row = { name, person, address: f.c_address.value.trim(), email: f.c_email.value.trim(), phone: f.c_phone.value.trim() };
  if (!person) { row.regcode = f.c_regcode.value.trim(); row.vatno = f.c_vatno.value.trim(); }
  const ex = D().contacts.find((c) => c.name.trim().toLowerCase() === name.toLowerCase());
  if (ex) {
    await api.saveContact({ id: ex.id, ...row, name: ex.name, kind: ex.kind === 'supplier' ? 'both' : ex.kind });
    return ex.id;
  }
  return (await api.saveContact({ company_id: S.cid, kind: 'client', ...row })).id;
}

function lineRow(l, revAccs) {
  return `<tr class="ln"><td style="min-width:170px"><input name="description" value="${esc(l.description)}" placeholder="Teenus või kaup" aria-label="Kirjeldus"></td>
  <td style="width:78px"><input name="qty" inputmode="decimal" value="${esc(decStr(l.qty))}" placeholder="1" aria-label="Kogus" class="mono"></td>
  <td style="width:116px"><select name="unit" aria-label="Ühik">${unitOpts(l.unit)}</select></td>
  <td style="width:104px"><input name="price" inputmode="decimal" value="${esc(decStr(l.price))}" placeholder="0,00" aria-label="Hind km-ta" class="mono"></td>
  <td style="width:82px"><select name="vat_rate" aria-label="KM määr">${vatOpts(l.vat_rate)}</select></td>
  ${revAccs.length > 1 ? `<td style="width:150px"><select name="account" aria-label="Tulukonto">${accOpts(revAccs, l.account || '4000')}</select></td>` : ''}
  <td class="num lsum mono" style="width:92px"></td>
  <td style="width:34px"><button type="button" class="btn ghost sm" data-act="rmline" aria-label="Eemalda rida">✕</button></td></tr>`;
}
function invoiceForm(inv) {
  const c = D().company, t = today(), revAccs = revenueChoices();
  const d = inv ? { ...inv, lines: D().linesBy[inv.id] || [] }
    : { no: nextInvoiceNo(D().invoices, c.invoice_prefix), date: t, due: addDays(t, c.payment_term_days ?? 14), contact_name: '', buyer_ref: '', notes: '',
      lines: [{ description: '', qty: 1, unit: 'tk', price: '', vat_rate: c.vat_payer ? 24 : 0, account: '4000' }] };
  openModal(`${mHead(inv ? `Muuda mustandit ${esc(inv.no)}` : 'Uus müügiarve')}
  <form data-form="invoice" data-id="${inv ? inv.id : ''}"><div class="body form">
    ${clientPanel(d.contact_name, 'fi')}
    <div class="fgrid">
      <label class="field"><span>Arve number</span><input id="fiN" name="no" value="${esc(d.no)}" required class="mono"></label>
      <label class="field"><span>Kuupäev</span><input id="fiD" name="date" type="date" value="${d.date}" required></label>
      <label class="field"><span>Maksetähtaeg</span><input id="fiDue" name="due" type="date" value="${d.due}" required></label>
    </div>${contactList()}
    <div class="tbl"><table class="lines"><thead><tr><th>Kirjeldus</th><th>Kogus</th><th>Ühik</th><th>Hind</th><th>KM</th>${revAccs.length > 1 ? '<th>Tulukonto</th>' : ''}<th class="num">Summa</th><th></th></tr></thead><tbody id="lnBody">${d.lines.map((l) => lineRow(l, revAccs)).join('')}</tbody></table></div>
    <div><button type="button" class="btn sm" data-act="addline">Lisa rida</button></div>
    <div class="totals" id="invTot"></div>
    <label class="field"><span>Märkus arvel</span><textarea id="fiNote" name="notes" rows="2">${esc(d.notes || '')}</textarea></label>
    <div class="err" id="fErr"></div>
  </div><footer><span class="muted small">Viitenumber: <span class="mono" id="fiRef">${refNo(d.no)}</span></span>
  <div class="row"><button type="button" class="btn" data-act="close">Loobu</button><button class="btn" type="submit" value="draft">Salvesta mustandina</button><button class="btn primary" type="submit" value="issue">Salvesta ja kinnita</button></div></footer></form>`);
  recalcInvoice(sheet.querySelector('form'));
}
function readLines(f) {
  return [...f.querySelectorAll('tr.ln')].map((tr) => ({
    description: tr.querySelector('[name=description]').value.trim(), qty: num(tr.querySelector('[name=qty]').value),
    unit: tr.querySelector('[name=unit]').value.trim(), price: num(tr.querySelector('[name=price]').value),
    vat_rate: Number(tr.querySelector('[name=vat_rate]').value), account: tr.querySelector('[name=account]')?.value || '4000' }));
}
function recalcInvoice(f) {
  const L = readLines(f);
  f.querySelectorAll('tr.ln').forEach((tr, i) => { tr.querySelector('.lsum').textContent = n2(L[i].qty * L[i].price); });
  const c = calcLines(L);
  f.querySelector('#invTot').innerHTML = `<span class="muted">Summa km-ta</span><span class="num">${eur(c.net)}</span>${Object.keys(c.by).filter((r) => +r > 0).map((r) => `<span class="muted">Käibemaks ${r}%</span><span class="num">${eur(c.by[r].vat)}</span>`).join('')}<span class="g">Kokku tasuda</span><span class="num g">${eur(c.gross)}</span>`;
  const rf = f.querySelector('#fiRef'); if (rf) rf.textContent = refNo(f.no.value);
}
async function saveInvoice(f, mode) {
  const err = f.querySelector('#fErr');
  const L = readLines(f).filter((l) => l.description || l.price);
  const name = f.client.value.trim();
  if (!name) { err.textContent = 'Lisa kliendi nimi.'; return; }
  if (!L.length || L.some((l) => !l.description)) { err.textContent = 'Igal arve real peab olema kirjeldus.'; return; }
  if (L.some((l) => !l.qty)) { err.textContent = 'Igal real peab olema kogus.'; return; }
  if (f.due.value < f.date.value) { err.textContent = 'Maksetähtaeg ei saa olla enne arve kuupäeva.'; return; }
  await act(async () => {
    const contactId = await saveClientContact(f);
    const id = await api.saveInvoiceDraft({ id: f.dataset.id || null, company_id: S.cid, no: f.no.value.trim(), contact_id: contactId, contact_name: name,
      date: f.date.value, due: f.due.value, buyer_ref: D().invById[f.dataset.id]?.buyer_ref || '', notes: f.notes.value.trim(), lines: L });
    if (mode === 'issue') await api.issueInvoice(id);
    return id;
  }, mode === 'issue' ? 'Arve kinnitatud ja kirjendatud' : 'Mustand salvestatud', (id) => { closeModal(); openInvoice(id); });
}

function openInvoice(id) {
  const i = D().invById[id];
  if (!i) return;
  const x = invInfo(i), w = canWrite();
  const pays = D().payments.filter((p) => p.invoice_id === id);
  const paysHtml = pays.length ? `<div class="einv"><b>Laekumised</b><div class="tbl"><table><tbody>${pays.map((p) => `<tr class="${p.status === 'cancelled' ? 'cancelled' : ''}"><td class="mono">${fd(p.date)}</td><td class="num">${n2(p.amount)}</td><td class="muted small">${p.account}${p.status === 'cancelled' ? ' · tühistatud' : ''}</td><td class="num">${w && p.status === 'active' ? `<button class="btn sm ghost" data-act="pay-cancel" data-id="${p.id}" data-back="inv:${id}">Tühista</button>` : ''}</td></tr>`).join('')}</tbody></table></div></div>` : '';
  let actions = `<button class="btn" data-act="print-inv" data-id="${id}">Prindi / PDF</button>`;
  let left = '';
  if (w && i.status === 'draft') {
    actions += `<button class="btn" data-act="edit-inv" data-id="${id}">Muuda</button><button class="btn primary" data-act="issue-inv" data-id="${id}">Kinnita arve</button>`;
    left = `<span class="row" id="delZone"><button class="btn danger" data-act="del-draft-ask" data-id="${id}">Kustuta mustand</button></span>`;
  } else if (w && i.kind === 'invoice' && !i.credited_by) {
    if (x.open > 0.004) actions += `<button class="btn primary" data-act="pay-inv" data-id="${id}">Lisa laekumine</button>`;
    if (!x.paid) left = `<span class="row" id="delZone"><button class="btn danger" data-act="credit-ask" data-id="${id}">Koosta kreeditarve</button></span>`;
  }
  openModal(`${mHead(`${i.kind === 'credit' ? 'Kreeditarve' : 'Arve'} ${esc(i.no)} ${pill(x.st, i.due)}`)}<div class="body"><iframe class="docframe" title="Arve eelvaade" srcdoc="${esc(invoiceDocFor(i))}"></iframe>
    ${i.status === 'issued' && i.kind === 'invoice' ? `<p class="muted small" style="margin:10px 0 0">Laekunud ${eur(x.paid)} · tasumata ${eur(Math.max(0, x.open))}</p>` : ''}${paysHtml}${i.status === 'issued' ? (contactOf(i)?.person ? '<p class="note" style="margin-top:12px">Klient on eraisik. Eraisikule saadetakse arve PDF-ina, e-arvet ei koostata.</p>' : einvPanel(i)) : ''}
    <div class="err" id="fErr"></div></div><footer>${left || '<span></span>'}<div class="row">${actions}</div></footer>`);
}
function einvPanel(i) {
  const cl = contactOf(i), ck = einvCheck(i, D().linesBy[i.id] || [], D().company, cl), errs = ck.filter((c) => c.level === 'err');
  return `<section class="einv"><div class="row" style="justify-content:space-between"><div><b>E-arve</b> <span class="muted small">EN 16931 · Peppol BIS Billing 3.0</span></div>${i.e_sent ? `<span class="pill paid">Saadetud ${fd(i.e_sent)}</span>` : cl?.einvoice ? '<span class="pill soon">Klient soovib e-arvet</span>' : ''}</div>
    ${ck.length ? `<ul class="checks">${ck.map((c) => `<li class="${c.level}">${esc(c.msg)}</li>`).join('')}</ul>` : '<p class="muted small" style="margin:6px 0 0">Kõik kohustuslikud andmed on olemas.</p>'}
    <div class="row" style="margin-top:10px"><button class="btn sm ${errs.length ? '' : 'primary'}" data-act="dl-einv" data-id="${i.id}" ${errs.length ? 'disabled' : ''}>Laadi alla e-arve (XML)</button>
    ${canWrite() ? `<button class="btn sm ghost" data-act="esent" data-id="${i.id}" data-v="${i.e_sent ? '' : '1'}">${i.e_sent ? 'Eemalda saatmise märge' : 'Märgi saadetuks'}</button>` : ''}</div>
    <p class="note" style="margin-top:8px">Lae XML-fail üles oma e-arve operaatori keskkonda (nt Omniva, Finbite või Telema).</p></section>`;
}
function paymentForm(kind, id) {
  const o = kind === 'inv' ? D().invById[id] : D().expenses.find((x) => x.id === id);
  const open = kind === 'inv' ? invInfo(o).open : expInfo(o).open;
  openModal(`${mHead(kind === 'inv' ? 'Lisa laekumine' : 'Lisa tasumine')}<form data-form="payment" data-kind="${kind}" data-id="${id}"><div class="body form">
    <p style="margin:0">${kind === 'inv' ? `Arve <b class="mono">${esc(o.no)}</b> · ${esc(o.contact_name)}` : `${esc(o.supplier)} ${esc(o.doc_no || '')}`} · tasumata <b class="mono">${eur(open)}</b></p>
    <div class="fgrid"><label class="field"><span>Kuupäev</span><input id="fpD" type="date" name="date" value="${today()}" required></label>
    <label class="field"><span>Summa</span><input id="fpA" name="amount" type="number" step="0.01" min="0.01" max="${open}" value="${open}" required class="mono"></label>
    <label class="field"><span>Konto</span><select id="fpAcc" name="account">${accOpts(accountsOfType('A').filter((a) => ['1000', '1020'].includes(a) || !['1210', '1520', '1700'].includes(a)), '1020')}</select></label></div>
    <div class="err" id="fErr"></div></div>
    <footer><span></span><div class="row"><button type="button" class="btn" data-act="close">Loobu</button><button class="btn primary" type="submit">Kinnita</button></div></footer></form>`);
}

function expenseForm(x, pre) {
  const t = today();
  const d = x || { supplier: '', doc_no: '', date: t, due: t, account: '6900', description: '', gross: '', vat_rate: D().company.vat_payer ? 24 : 0, ...(pre || {}) };
  const accs = accountsOfType('X').concat(D().acc['1700']?.active ? ['1700'] : []);
  openModal(`${mHead(x ? 'Muuda kulu' : 'Lisa kulu')}<form data-form="expense" data-id="${x ? x.id : ''}"><div class="body form">
    <div class="fgrid">
      <label class="field"><span>Tarnija</span><input id="feS" name="supplier" list="contactsDL" value="${esc(d.supplier)}" required autocomplete="off"></label>
      <label class="field"><span>Dokumendi nr</span><input id="feN" name="doc_no" value="${esc(d.doc_no || '')}"></label>
      <label class="field"><span>Kuupäev</span><input id="feD" name="date" type="date" value="${d.date}" required></label>
      <label class="field"><span>Maksetähtaeg</span><input id="feDue" name="due" type="date" value="${d.due || d.date}"></label>
    </div>${contactList()}
    <div class="fgrid">
      <label class="field"><span>Kulukonto</span><select id="feA" name="account">${accOpts(accs, d.account)}</select></label>
      <label class="field"><span>Summa koos KM-ga</span><input id="feG" name="gross" type="number" step="0.01" min="0.01" value="${esc(d.gross)}" required class="mono"></label>
      <label class="field"><span>KM määr</span><select id="feV" name="vat_rate" ${D().company.vat_payer ? '' : 'disabled'}>${vatOpts(d.vat_rate)}</select></label>
    </div>
    <label class="field"><span>Selgitus</span><input id="feX" name="description" value="${esc(d.description || '')}" placeholder="Nt kontori üür, oktoober"></label>
    <label class="field"><span>Algdokument (PDF või pilt)${x?.attachment_path ? ' · lisatud, uus fail asendab' : ''}</span><input id="feF" name="file" type="file" accept="application/pdf,image/*"></label>
    <div class="totals" id="expTot"></div>
    ${x ? '' : `<div class="row"><label class="check"><input type="checkbox" id="fePaid" name="paid" ${pre?.paid ? 'checked' : ''}> Tasutud</label><input type="date" id="fePD" name="paid_date" value="${pre?.paid_date || d.date}" style="width:auto" aria-label="Tasumise kuupäev"></div>`}
    ${x ? '<p class="note">Muutmisel tehakse vanale kandele storno ja kirjendatakse uus kanne.</p>' : ''}
    <div class="err" id="fErr"></div>
  </div><footer><span></span><div class="row"><button type="button" class="btn" data-act="close">Loobu</button><button class="btn primary" type="submit">Salvesta</button></div></footer></form>`);
  recalcExpense(sheet.querySelector('form'));
}
function recalcExpense(f) {
  const c = expCalc(f.gross.value, D().company.vat_payer ? f.vat_rate.value : 0);
  f.querySelector('#expTot').innerHTML = `<span class="muted">Km-ta</span><span class="num">${eur(c.net)}</span><span class="muted">Sisendkäibemaks</span><span class="num">${eur(c.vat)}</span>`;
  if (f.paid_date) f.paid_date.disabled = !f.paid.checked;
}
async function saveExpense(f) {
  const err = f.querySelector('#fErr'), name = f.supplier.value.trim();
  const gross = r2(num(f.gross.value));
  if (!name) { err.textContent = 'Lisa tarnija nimi.'; return; }
  if (gross <= 0) { err.textContent = 'Sisesta summa, mis on suurem kui null.'; return; }
  const file = f.file.files[0];
  if (file && file.size > 10 * 1024 * 1024) { err.textContent = 'Fail on liiga suur (üle 10 MB).'; return; }
  const paid = f.paid?.checked, paidDate = f.paid_date?.value, bankIx = S._bankIx;
  await act(async () => {
    const contactId = await findOrCreateContact(name, 'supplier');
    const path = file ? await api.uploadDocument(S.cid, file) : null;
    const id = await api.saveExpense({ id: f.dataset.id || null, company_id: S.cid, contact_id: contactId, supplier: name, doc_no: f.doc_no.value.trim(),
      date: f.date.value, due: f.due.value || f.date.value, account: f.account.value, description: f.description.value.trim(), gross,
      vat_rate: D().company.vat_payer ? Number(f.vat_rate.value) : 0, attachment_path: path });
    if (paid) await api.addPayment(S.cid, null, id, paidDate || f.date.value, gross);
    return id;
  }, f.dataset.id ? 'Kulu muudetud' : 'Kulu lisatud', () => {
    closeModal();
    if (bankIx != null && S.bank) { S.bank.rows[bankIx].done = true; S._bankIx = null; render(); }
  });
}
function openExpense(id) {
  const x = D().expenses.find((o) => o.id === id);
  if (!x) return;
  const info = expInfo(x), w = canWrite() && x.status === 'active';
  const pays = D().payments.filter((p) => p.expense_id === id);
  openModal(`${mHead(`${esc(x.supplier)} ${pill(info.st, x.due)}`)}<div class="body stack">
    <dl class="kv"><dt>Dokumendi nr</dt><dd class="mono">${esc(x.doc_no || '—')}</dd><dt>Kuupäev</dt><dd class="mono">${fd(x.date)}</dd><dt>Maksetähtaeg</dt><dd class="mono">${fd(x.due)}</dd>
      <dt>Kulukonto</dt><dd>${x.account} ${esc(accName(x.account))}</dd><dt>Selgitus</dt><dd>${esc(x.description || '—')}</dd>
      <dt>Km-ta</dt><dd class="mono">${eur(x.net)}</dd><dt>Käibemaks</dt><dd class="mono">${eur(x.vat)} (${+x.vat_rate}%)</dd><dt>Kokku</dt><dd class="mono"><b>${eur(x.gross)}</b></dd>
      <dt>Tasumata</dt><dd class="mono">${eur(Math.max(0, info.open))}</dd></dl>
    ${x.attachment_path ? `<div><button class="btn sm" data-act="open-doc" data-path="${esc(x.attachment_path)}">Ava algdokument</button></div>` : '<p class="muted small" style="margin:0">Algdokumenti pole lisatud.</p>'}
    ${pays.length ? `<div class="einv"><b>Tasumised</b><div class="tbl"><table><tbody>${pays.map((p) => `<tr class="${p.status === 'cancelled' ? 'cancelled' : ''}"><td class="mono">${fd(p.date)}</td><td class="num">${n2(p.amount)}</td><td class="muted small">${p.account}${p.status === 'cancelled' ? ' · tühistatud' : ''}</td><td class="num">${canWrite() && p.status === 'active' ? `<button class="btn sm ghost" data-act="pay-cancel" data-id="${p.id}" data-back="exp:${id}">Tühista</button>` : ''}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    <div class="err" id="fErr"></div></div>
  <footer>${w ? `<span class="row" id="delZone"><button class="btn danger" data-act="exp-cancel-ask" data-id="${id}">Tühista kulu</button></span>` : '<span></span>'}
  <div class="row">${w ? `<button class="btn" data-act="edit-exp" data-id="${id}">Muuda</button>${info.open > 0.004 ? `<button class="btn primary" data-act="pay-exp" data-id="${id}">Lisa tasumine</button>` : ''}` : ''}</div></footer>`);
}

function contactForm(c) {
  const d = c || { name: '', kind: 'client', regcode: '', vatno: '', email: '', address: '', peppol_id: '', einvoice: false };
  openModal(`${mHead(c ? 'Muuda partnerit' : 'Lisa partner')}<form data-form="contact" data-id="${c ? c.id : ''}"><div class="body form"><div class="fgrid">
    <label class="field"><span>Nimi</span><input id="fcN" name="cname" value="${esc(d.name)}" required></label>
    <label class="field"><span>Liik</span><select id="fcT" name="kind"><option value="client" ${d.kind === 'client' ? 'selected' : ''}>Klient</option><option value="supplier" ${d.kind === 'supplier' ? 'selected' : ''}>Tarnija</option><option value="both" ${d.kind === 'both' ? 'selected' : ''}>Klient ja tarnija</option></select></label>
    <label class="check" style="grid-column:1/-1"><input type="checkbox" id="fcP" name="person" ${d.person ? 'checked' : ''}> Eraisik (mitte ettevõte)</label>
    <label class="field"><span>Registrikood või isikukood</span><input id="fcR" name="regcode" value="${esc(d.regcode)}" inputmode="numeric"></label>
    <label class="field" data-only="company" ${d.person ? 'hidden' : ''}><span>KMKR number</span><input id="fcV" name="vatno" value="${esc(d.vatno)}"></label>
    <label class="field"><span>E-post</span><input id="fcE" name="email" type="email" value="${esc(d.email)}"></label>
    <label class="field"><span>Telefon</span><input id="fcTel" name="phone" type="tel" value="${esc(d.phone || '')}"></label>
    <label class="field"><span>Aadress</span><input id="fcA" name="address" value="${esc(d.address)}" placeholder="Tänav 1, 10111 Tallinn"></label>
    <label class="field" data-only="company" ${d.person ? 'hidden' : ''}><span>Peppol ID (vabatahtlik)</span><input id="fcPP" name="peppol_id" value="${esc(d.peppol_id || '')}" placeholder="0191:registrikood" class="mono"></label>
    <label class="check" data-only="company" ${d.person ? 'hidden' : ''} style="align-self:end;padding-bottom:8px"><input type="checkbox" id="fcEI" name="einvoice" ${d.einvoice ? 'checked' : ''}> Soovib e-arveid</label>
  </div><div class="err" id="fErr"></div></div>
  <footer>${c && canWrite() ? `<span class="row" id="delZone"><button type="button" class="btn danger" data-act="contact-del-ask" data-id="${c.id}">Kustuta</button></span>` : '<span></span>'}<div class="row"><button type="button" class="btn" data-act="close">Loobu</button>${canWrite() ? '<button class="btn primary" type="submit">Salvesta</button>' : ''}</div></footer></form>`);
}

function jrRow(l) {
  return `<tr class="jl"><td><select name="account" aria-label="Konto">${accOpts(accountsOfType('A', 'L', 'E', 'R', 'X'), l.account)}</select></td><td style="width:130px"><input name="debit" type="number" step="0.01" min="0" value="${num(l.debit) || ''}" aria-label="Deebet" class="mono"></td><td style="width:130px"><input name="credit" type="number" step="0.01" min="0" value="${num(l.credit) || ''}" aria-label="Kreedit" class="mono"></td><td style="width:34px"><button type="button" class="btn ghost sm" data-act="rmjl" aria-label="Eemalda rida">✕</button></td></tr>`;
}
function journalForm() {
  openModal(`${mHead('Uus käsitsi kanne')}<form data-form="journal"><div class="body form">
    <div class="fgrid"><label class="field"><span>Kuupäev</span><input id="fjD" name="date" type="date" value="${today()}" required></label><label class="field" style="grid-column:span 2"><span>Kirjeldus</span><input id="fjX" name="description" placeholder="Nt algsaldod, osakapitali sissemakse" required></label></div>
    <div class="tbl"><table class="lines"><thead><tr><th>Konto</th><th class="num">Deebet</th><th class="num">Kreedit</th><th></th></tr></thead><tbody id="jlBody">${jrRow({ account: '1020' })}${jrRow({ account: '3000' })}</tbody></table></div>
    <div><button type="button" class="btn sm" data-act="addjl">Lisa rida</button></div>
    <div class="totals" id="jrTot"></div><p class="note">Salvestatud kannet muuta ei saa. Vea korral tee stornokanne.</p><div class="err" id="fErr"></div>
  </div><footer><span></span><div class="row"><button type="button" class="btn" data-act="close">Loobu</button><button class="btn primary" type="submit">Salvesta kanne</button></div></footer></form>`);
  recalcJournal(sheet.querySelector('form'));
}
const readJl = (f) => [...f.querySelectorAll('tr.jl')].map((tr) => ({ account: tr.querySelector('[name=account]').value, debit: r2(num(tr.querySelector('[name=debit]').value)), credit: r2(num(tr.querySelector('[name=credit]').value)) })).filter((l) => l.debit || l.credit);
function recalcJournal(f) {
  const L = readJl(f), d = r2(L.reduce((s, l) => s + l.debit, 0)), k = r2(L.reduce((s, l) => s + l.credit, 0));
  f.querySelector('#jrTot').innerHTML = `<span class="muted">Deebet</span><span class="num">${n2(d)}</span><span class="muted">Kreedit</span><span class="num">${n2(k)}</span><span class="muted">Vahe</span><span class="num" style="color:${Math.abs(d - k) < 0.005 ? 'var(--good)' : 'var(--bad)'}">${n2(d - k)}</span>`;
}
function accountForm() {
  openModal(`${mHead('Lisa konto')}<form data-form="account"><div class="body form"><div class="fgrid">
    <label class="field"><span>Konto number</span><input id="faC" name="code" inputmode="numeric" pattern="[0-9]{3,6}" required class="mono" placeholder="6110"></label>
    <label class="field"><span>Nimi</span><input id="faN" name="aname" required></label>
    <label class="field"><span>Liik</span><select id="faT" name="type"><option value="X">Kulu</option><option value="R">Tulu</option><option value="A">Vara</option><option value="L">Kohustis</option><option value="E">Omakapital</option></select></label>
  </div><div class="err" id="fErr"></div></div><footer><span></span><div class="row"><button type="button" class="btn" data-act="close">Loobu</button><button class="btn primary" type="submit">Lisa</button></div></footer></form>`);
}

// ====================================================================
// Failid: printimine, e-arve, eksport, import
// ====================================================================
function invoiceDocFor(i) {
  const x = invInfo(i);
  const pays = D().payments.filter((p) => p.invoice_id === i.id && p.status === 'active').map((p) => p.date).sort();
  return invoiceDoc(i, D().linesBy[i.id] || [], D().company, contactOf(i) || {},
    { origNo: i.credit_of ? D().invById[i.credit_of]?.no : '', paidDate: x.st === 'paid' ? pays[pays.length - 1] : null, accent: D().company.invoice_color });
}
function printHtml(html) {
  const w = window.open('', '_blank');
  if (!w) { toast('Brauser blokeeris uue akna. Luba hüpikaknad selle lehe jaoks.'); return; }
  w.document.write(html.replace('</body>', '<script>window.onload=()=>setTimeout(()=>window.print(),400)<\/script></body>'));
  w.document.close();
}
function printInvoice(i) { printHtml(invoiceDocFor(i)); }
function quoteDocFor(q) {
  return invoiceDoc({ ...q, kind: 'quote' }, D().quoteLinesBy[q.id] || [], D().company, contactOf(q) || {}, { accent: D().company.invoice_color });
}
function ledgerCSV() {
  const q = (s) => { let v = String(s); if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`; return `"${v.replace(/"/g, '""')}"`; };
  const out = ['Kande nr;Kuupäev;Kirjeldus;Konto;Konto nimi;Deebet;Kreedit'];
  for (const l of D().ledger) out.push([l.no, fd(l.date), q(l.description), l.account, q(l.account_name), num(l.debit) ? n2(l.debit).replace(/\s/g, '') : '', num(l.credit) ? n2(l.credit).replace(/\s/g, '') : ''].join(';'));
  return '﻿' + out.join('\r\n');
}
/** Vähendab logo suuruseks max 600×240 px ja salvestab selle ettevõtte andmetesse. */
async function uploadLogo(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast('Fail on liiga suur (üle 5 MB).'); return; }
  let data;
  if (file.type === 'image/svg+xml') {
    const text = await file.text();
    if (/<script|on\w+\s*=|javascript:/i.test(text)) { toast('See SVG-fail sisaldab skripte. Kasuta PNG- või JPG-faili.'); return; }
    data = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(text)));
  } else {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
      const k = Math.min(1, 600 / img.width, 240 / img.height);
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      data = cv.toDataURL('image/png');
      if (data.length > 380000) data = cv.toDataURL('image/jpeg', 0.85);
    } catch { toast('Pilti ei õnnestunud lugeda.'); return; } finally { URL.revokeObjectURL(url); }
  }
  if (data.length > 400000) { toast('Logo on liiga suur. Proovi väiksemat faili.'); return; }
  await act(() => api.updateCompany(S.cid, { logo: data }), 'Logo salvestatud');
}
async function importFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('Fail ei ole korrektne JSON.'); return; }
  if (!data || data.format !== 'saldo-prototype') { toast('See ei ole Saldo prototüübi andmefail.'); return; }
  await act(async () => {
    const c = data.company || {};
    if (c.name && !D().company.regcode) {
      await api.updateCompany(S.cid, { name: c.name, regcode: c.regcode || '', vatno: c.vatno || '', address: c.address || '', email: c.email || '',
        phone: c.phone || '', bank: c.bank || '', iban: c.iban || '', payment_term_days: Number(c.termDays) || 14, vat_payer: c.vatPayer !== false });
    }
    return api.importPrototype(S.cid, data);
  }, null, (r) => {
    toast(`Imporditud: ${r.contacts} partnerit, ${r.invoices} arvet, ${r.expenses} kulu, ${r.journal} kannet`);
  });
}
async function loadBankFile(file) {
  if (!file) return;
  let text = await file.text();
  if (text.includes('�')) text = new TextDecoder('windows-1257').decode(await file.arrayBuffer());
  const openInv = D().invoices.filter((i) => i.status === 'issued' && i.kind === 'invoice' && !i.credited_by && invInfo(i).open > 0.004)
    .map((i) => ({ id: i.id, no: i.no, ref_no: i.ref_no, contact_name: i.contact_name, open: invInfo(i).open }));
  const openExp = D().expenses.filter((x) => x.status === 'active' && expInfo(x).open > 0.004).map((x) => ({ id: x.id, supplier: x.supplier, open: expInfo(x).open }));
  S.bank = { fileName: file.name, rows: matchBank(bankRows(text), openInv, openExp) };
  render();
}
async function bankLink(ix) {
  const r = S.bank.rows[ix];
  if (!r || !r.match || r.done) return;
  await api.addPayment(S.cid, r.match.type === 'inv' ? r.match.id : null, r.match.type === 'exp' ? r.match.id : null, r.date, r.match.amount);
  r.done = true;
}

// ====================================================================
// Sündmused
// ====================================================================
function confirmZone(btn, text, yesAct, extra = '') {
  const z = btn.closest('[id]');
  z.innerHTML = `<span class="muted small">${text}</span>${extra}<button type="button" class="btn danger solid" data-act="${yesAct}" data-id="${btn.dataset.id}">Jah</button><button type="button" class="btn ghost" data-act="zone-no">Ei</button>`;
}
const ACTS = {
  go: (b) => { S.view = b.dataset.v; try { localStorage.setItem('saldo.view', S.view); } catch { /* ignore */ } render(); window.scrollTo(0, 0); },
  close: () => closeModal(),
  'auth-mode': (b) => { S.authMode = b.dataset.m; S.authErr = ''; S.authMsg = ''; render(); },
  signout: async () => { await api.signOut(); location.reload(); },
  'new-inv': () => invoiceForm(null),
  'new-quote': () => quoteForm(null),
  'open-quote': (b) => openQuote(b.dataset.id),
  'edit-quote': (b) => quoteForm(D().quotes.find((q) => q.id === b.dataset.id)),
  'copy-quote': (b) => { const q = D().quotes.find((x) => x.id === b.dataset.id); quoteForm(null, q); },
  'quote-status': (b) => act(() => api.setQuoteStatus(b.dataset.id, b.dataset.s), { sent: 'Märgitud saadetuks', accepted: 'Pakkumine kinnitatud', declined: 'Märgitud tagasi lükatuks', draft: 'Muudetud mustandiks' }[b.dataset.s], () => openQuote(b.dataset.id)),
  'quote-del-ask': (b) => confirmZone(b, 'Kustutada pakkumine?', 'quote-del'),
  'quote-del': (b) => act(() => api.deleteQuote(b.dataset.id), 'Pakkumine kustutatud', () => closeModal()),
  'quote-inv-ask': (b) => {
    const z = b.closest('[id]');
    z.innerHTML = `<span class="muted small">Arve nr</span><input id="qiNo" value="${esc(nextInvoiceNo(D().invoices, D().company.invoice_prefix))}" class="mono" style="width:120px" aria-label="Arve number"><input id="qiDate" type="date" value="${today()}" style="width:auto" aria-label="Arve kuupäev"><button type="button" class="btn primary" data-act="quote-inv" data-id="${b.dataset.id}">Koosta arve</button><button type="button" class="btn ghost" data-act="close">Loobu</button>`;
  },
  'quote-inv': (b) => act(() => api.quoteToInvoice(b.dataset.id, sheet.querySelector('#qiNo').value.trim(), sheet.querySelector('#qiDate').value),
    'Arve mustand koostatud. Kontrolli ja kinnita.', (id) => { S.view = 'invoices'; render(); openInvoice(id); }),
  'print-quote': (b) => printHtml(quoteDocFor(D().quotes.find((q) => q.id === b.dataset.id))),
  'open-inv': (b) => openInvoice(b.dataset.id),
  'edit-inv': (b) => invoiceForm(D().invById[b.dataset.id]),
  'issue-inv': (b) => act(() => api.issueInvoice(b.dataset.id), 'Arve kinnitatud ja kirjendatud', () => openInvoice(b.dataset.id)),
  'del-draft-ask': (b) => confirmZone(b, 'Kustutada mustand?', 'del-draft'),
  'del-draft': (b) => act(() => api.deleteInvoiceDraft(b.dataset.id), 'Mustand kustutatud', () => closeModal()),
  'credit-ask': (b) => {
    const z = b.closest('[id]');
    z.innerHTML = `<input id="crNo" value="${esc(nextInvoiceNo(D().invoices, D().company.invoice_prefix))}" class="mono" style="width:120px" aria-label="Kreeditarve number"><input id="crDate" type="date" value="${today()}" style="width:auto" aria-label="Kreeditarve kuupäev"><button type="button" class="btn danger solid" data-act="credit" data-id="${b.dataset.id}">Koosta kreeditarve</button><button type="button" class="btn ghost" data-act="close">Loobu</button>`;
  },
  credit: (b) => act(() => api.creditInvoice(b.dataset.id, sheet.querySelector('#crNo').value.trim(), sheet.querySelector('#crDate').value), 'Kreeditarve koostatud', (id) => openInvoice(id)),
  'pay-inv': (b) => paymentForm('inv', b.dataset.id),
  'pay-exp': (b) => paymentForm('exp', b.dataset.id),
  'pay-cancel': (b) => {
    const [k, id] = b.dataset.back.split(':');
    act(() => api.cancelPayment(b.dataset.id, today()), 'Makse tühistatud (storno)', () => (k === 'inv' ? openInvoice(id) : openExpense(id)));
  },
  'print-inv': (b) => printInvoice(D().invById[b.dataset.id]),
  'dl-einv': (b) => {
    const i = D().invById[b.dataset.id];
    const inv = { ...i, credit_of_no: i.credit_of ? D().invById[i.credit_of]?.no : '' };
    download(`e-arve-${String(i.no).replace(/[^\w.-]+/g, '-')}.xml`, ublXML(inv, D().linesBy[i.id] || [], D().company, contactOf(i)), 'application/xml');
  },
  esent: (b) => act(() => api.markEinvoiceSent(b.dataset.id, !!b.dataset.v), b.dataset.v ? 'E-arve märgitud saadetuks' : 'Märge eemaldatud', () => openInvoice(b.dataset.id)),
  'new-exp': () => { S._bankIx = null; expenseForm(null); },
  'open-exp': (b) => openExpense(b.dataset.id),
  'edit-exp': (b) => { S._bankIx = null; expenseForm(D().expenses.find((x) => x.id === b.dataset.id)); },
  'exp-cancel-ask': (b) => confirmZone(b, 'Tühistada kulu? Kandele tehakse storno.', 'exp-cancel'),
  'exp-cancel': (b) => act(() => api.cancelExpense(b.dataset.id, today()), 'Kulu tühistatud', () => closeModal()),
  'open-doc': async (b) => { try { window.open(await api.documentUrl(b.dataset.path), '_blank', 'noopener'); } catch (e) { toast(e.message); } },
  'new-contact': () => contactForm(null),
  'edit-contact': (b) => contactForm(D().contactById[b.dataset.id]),
  'contact-del-ask': (b) => confirmZone(b, 'Kustutada partner? Dokumendid jäävad alles.', 'contact-del'),
  'contact-del': (b) => act(() => api.deleteContact(b.dataset.id), 'Partner kustutatud', () => closeModal()),
  'new-jr': () => journalForm(),
  addline: () => { const tb = sheet.querySelector('#lnBody'); tb.insertAdjacentHTML('beforeend', lineRow({ description: '', qty: 1, unit: 'tk', price: '', vat_rate: D().company.vat_payer ? 24 : 0, account: '4000' }, revenueChoices())); recalcInvoice(sheet.querySelector('form')); tb.lastElementChild.querySelector('input').focus(); },
  rmline: (b) => { const f = b.closest('form'); if (f.querySelectorAll('tr.ln').length > 1) { b.closest('tr').remove(); recalcInvoice(f); } },
  addjl: () => sheet.querySelector('#jlBody').insertAdjacentHTML('beforeend', jrRow({ account: '1020' })),
  rmjl: (b) => { const f = b.closest('form'); if (f.querySelectorAll('tr.jl').length > 2) { b.closest('tr').remove(); recalcJournal(f); } },
  'rev-ask': (b) => {
    const e = D().entries.find((x) => x.id === b.dataset.id);
    openModal(`${mHead(`Storno kandele nr ${e.no}`)}<form data-form="reverse" data-id="${e.id}"><div class="body form"><p style="margin:0">${esc(e.description)} · ${fd(e.date)}</p>
      <p class="note">Tehakse uus kanne, kus deebet ja kreedit on vahetatud. Algne kanne jääb alles.</p>
      <label class="field" style="max-width:220px"><span>Storno kuupäev</span><input id="frD" name="date" type="date" value="${today()}" required></label><div class="err" id="fErr"></div></div>
      <footer><span></span><div class="row"><button type="button" class="btn" data-act="close">Loobu</button><button class="btn danger solid" type="submit">Tee storno</button></div></footer></form>`);
  },
  invf: (b) => { S.invFilter = b.dataset.f; render(); },
  quotef: (b) => { S.quoteFilter = b.dataset.f; render(); },
  expf: (b) => { S.expFilter = b.dataset.f; render(); },
  ltab: (b) => { S.ledgerTab = b.dataset.t; render(); },
  rtab: (b) => { S.repTab = b.dataset.t; render(); },
  'acc-open': (b) => { S.ledgerAcc = b.dataset.a; S.ledgerTab = 'journal'; render(); },
  vat: (b) => {
    const k = S.rep.month, [y, m] = k.split('-').map(Number);
    const date = b.dataset.k === 'settle' ? lastDay(k) : (iso(new Date(y, m, 20)) < today() ? iso(new Date(y, m, 20)) : today());
    act(() => api.postVat(S.cid, k, b.dataset.k, Number(b.dataset.amt), date), 'Kirjendatud');
  },
  'bank-link': async (b) => { setBusy(1); try { await bankLink(+b.dataset.ix); await reload(); render(); toast('Makse seotud'); } catch (e) { toast(e.message); } finally { setBusy(-1); } },
  'bank-link-all': async () => {
    setBusy(1);
    let n = 0;
    try { for (let i = 0; i < S.bank.rows.length; i++) { if (S.bank.rows[i].match && !S.bank.rows[i].done) { await bankLink(i); n++; } } toast(`${n} makset seotud`); }
    catch (e) { toast(e.message); } finally { await reload(); render(); setBusy(-1); }
  },
  'bank-exp': (b) => { const r = S.bank.rows[+b.dataset.ix]; S._bankIx = +b.dataset.ix; expenseForm(null, { supplier: r.partner, date: r.date, due: r.date, gross: Math.abs(r.amount), description: r.desc, paid: true, paid_date: r.date }); },
  'new-account': () => accountForm(),
  swatch: (b) => { const el = document.getElementById('dColor'); if (el) el.value = b.dataset.c; },
  'logo-remove': () => act(() => api.updateCompany(S.cid, { logo: null }), 'Logo eemaldatud'),
  'design-preview': () => {
    const c = { ...D().company, invoice_color: document.getElementById('dColor')?.value || D().company.invoice_color };
    const t = today();
    const sample = { no: nextInvoiceNo(D().invoices, c.invoice_prefix), kind: 'invoice', date: t, due: addDays(t, c.payment_term_days ?? 14), contact_name: 'Näidisklient OÜ', buyer_ref: '', notes: '' };
    const lines = [{ description: 'Teenus', qty: 10, unit: 'h', price: 50, vat_rate: c.vat_payer ? 24 : 0 }, { description: 'Materjalid', qty: 2, unit: 'tk', price: 35, vat_rate: c.vat_payer ? 24 : 0 }];
    const html = invoiceDoc(sample, lines, c, { address: 'Näidistänav 5, 10111 Tallinn', regcode: '12345678' }, { accent: c.invoice_color });
    openModal(`${mHead('Arve näidis')}<div class="body"><iframe class="docframe" title="Arve näidis" srcdoc="${esc(html)}"></iframe></div>`);
  },
  'toggle-account': (b) => { const a = D().acc[b.dataset.a]; act(() => api.updateAccount(S.cid, a.code, { active: !a.active }), a.active ? 'Konto peidetud' : 'Konto taastatud'); },
  'export-csv': () => download(`pearaamat-${today()}.csv`, ledgerCSV(), 'text/csv'),
  'export-json': () => { const { acc, linesBy, paidInv, paidExp, contactById, invById, entries, reversed, ...rest } = D(); download(`saldo-varukoopia-${today()}.json`, JSON.stringify({ format: 'saldo-backup', exported: new Date().toISOString(), ...rest }, null, 1), 'application/json'); },
  audit: async () => { try { S.audit = await api.auditLog(S.cid); render(); } catch (e) { toast(e.message); } },
  'switch-co': async (b) => { await openCompany(b.dataset.id); },
  'mfa-on': async () => {
    try {
      const f = await api.listFactors();
      for (const x of (f.all || []).filter((x) => x.status !== 'verified')) await api.unenroll(x.id);
      S.mfa = { ...S.mfa, enrolling: await api.enrollTotp() };
    } catch (e) { toast(e.message); }
    render();
  },
  'mfa-cancel': async () => { try { if (S.mfa.enrolling) await api.unenroll(S.mfa.enrolling.id); } catch { /* ignore */ } S.mfa.enrolling = null; render(); },
  'mfa-off-ask': (b) => { b.closest('#mfaOff').innerHTML = '<span class="muted small">Kindel?</span><button class="btn danger solid" data-act="mfa-off">Jah, lülita välja</button><button class="btn ghost" data-act="zone-no">Ei</button>'; },
  'mfa-off': async () => { try { await api.unenroll(S.mfa.verified.id); await refreshMfa(); toast('Kaheastmeline kinnitus välja lülitatud'); } catch (e) { toast(e.message); } render(); },
};
// „Ei“ kinnitusküsimusele: suleb dialoogi või taastab vaate.
ACTS['zone-no'] = () => { if (!modal.hidden) closeModal(); render(); };

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const fn = ACTS[b.dataset.act];
  if (fn) { e.preventDefault(); fn(b, e); }
});

document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const t = f.dataset.form, err = f.querySelector('#fErr');
  const btn = e.submitter;
  if (btn) btn.disabled = true;
  try {
    if (t === 'login' || t === 'signup' || t === 'forgot') {
      S.authErr = ''; S.authMsg = '';
      try {
        if (t === 'login') { await api.signIn(f.email.value.trim(), f.password.value); await afterLogin(); return; }
        if (t === 'signup') {
          if (f.password.value !== f.password2.value) throw new Error('Paroolid ei ühti.');
          const r = await api.signUp(f.email.value.trim(), f.password.value);
          if (r.session) { await afterLogin(); return; }
          S.authMode = 'login'; S.authMsg = 'Saatsime sulle kinnituslingi. Ava e-kiri ja seejärel logi sisse.';
        }
        if (t === 'forgot') { await api.resetPassword(f.email.value.trim()); S.authMsg = 'Kui see e-post on registreeritud, saatsime parooli taastamise lingi.'; }
      } catch (ex) { S.authErr = ex.message; }
      render();
      return;
    }
    if (t === 'mfa') {
      try { const fs = await api.listFactors(); await api.verifyTotp(fs.totp[0].id, f.code.value); S.authErr = ''; await afterLogin(); }
      catch (ex) { S.authErr = ex.message; render(); }
      return;
    }
    if (t === 'newpass') {
      try { await api.updatePassword(f.password.value); toast('Parool muudetud'); await afterLogin(); } catch (ex) { S.authErr = ex.message; render(); }
      return;
    }
    if (t === 'onboard' || t === 'new-co') {
      try { const id = await api.createCompany(f.name.value.trim()); await loadMembers(); await openCompany(id); S.view = 'settings'; render(); toast('Raamatupidamine loodud. Lisa ettevõtte andmed.'); }
      catch (ex) { if (err) err.textContent = ex.message; else toast(ex.message); }
      return;
    }
    if (t === 'invoice') return await saveInvoice(f, btn?.value || 'draft');
    if (t === 'quote') return await saveQuoteForm(f);
    if (t === 'expense') return await saveExpense(f);
    if (t === 'payment') {
      const kind = f.dataset.kind, id = f.dataset.id;
      return await act(() => api.addPayment(S.cid, kind === 'inv' ? id : null, kind === 'exp' ? id : null, f.date.value, r2(num(f.amount.value)), f.account.value),
        kind === 'inv' ? 'Laekumine kirjendatud' : 'Tasumine kirjendatud', () => (kind === 'inv' ? openInvoice(id) : openExpense(id)));
    }
    if (t === 'contact') {
      const row = { company_id: S.cid, name: f.cname.value.trim(), kind: f.kind.value, regcode: f.regcode.value.trim(), vatno: f.vatno.value.trim(), email: f.email.value.trim(),
        address: f.address.value.trim(), peppol_id: f.peppol_id.value.trim(), einvoice: f.einvoice.checked && !f.person.checked, person: f.person.checked, phone: f.phone.value.trim() };
      if (f.dataset.id) { row.id = f.dataset.id; delete row.company_id; }
      return await act(() => api.saveContact(row), 'Partner salvestatud', () => closeModal());
    }
    if (t === 'journal') {
      const L = readJl(f), d = r2(L.reduce((s, l) => s + l.debit, 0)), k = r2(L.reduce((s, l) => s + l.credit, 0));
      if (L.length < 2 || !d) { err.textContent = 'Kandes peab olema vähemalt kaks rida summaga.'; return; }
      if (Math.abs(d - k) >= 0.005) { err.textContent = `Deebet ja kreedit peavad olema võrdsed. Vahe on ${n2(d - k)}.`; return; }
      return await act(() => api.createManualEntry({ company_id: S.cid, date: f.date.value, description: f.description.value.trim(), lines: L }), 'Kanne salvestatud', () => closeModal());
    }
    if (t === 'reverse') return await act(() => api.reverseEntry(f.dataset.id, f.date.value), 'Storno tehtud', () => closeModal());
    if (t === 'account') {
      return await act(() => api.addAccount({ company_id: S.cid, code: f.code.value.trim(), name: f.aname.value.trim(), type: f.type.value }), 'Konto lisatud', () => closeModal());
    }
    if (t === 'company') {
      const patch = { name: f.name.value.trim(), regcode: f.regcode.value.trim(), vatno: f.vatno.value.trim(), email: f.email.value.trim(), phone: f.phone.value.trim(),
        address: f.address.value.trim(), bank: f.bank.value.trim(), iban: f.iban.value.trim(), invoice_prefix: f.invoice_prefix.value,
        payment_term_days: Number(f.payment_term_days.value) || 0, vat_payer: f.vat_payer.checked };
      return await act(() => api.updateCompany(S.cid, patch), 'Seaded salvestatud');
    }
    if (t === 'design') return await act(() => api.updateCompany(S.cid, { invoice_color: f.invoice_color.value }), 'Arve värv salvestatud');
    if (t === 'lock') return await act(() => api.updateCompany(S.cid, { lock_date: f.lock_date.value || null }), f.lock_date.value ? `Periood suletud kuni ${fd(f.lock_date.value)}` : 'Periood avatud');
    if (t === 'mfa-verify') {
      try { await api.verifyTotp(S.mfa.enrolling.id, f.code.value); S.mfa.enrolling = null; await refreshMfa(); toast('Kaheastmeline kinnitus on sees'); render(); }
      catch (ex) { const m = document.getElementById('mfaErr'); if (m) m.textContent = ex.message; }
    }
  } finally { if (btn && btn.isConnected) btn.disabled = false; }
});

document.addEventListener('input', (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  if (f.dataset.form === 'quote') { recalcInvoice(f); return; }
  if (f.dataset.form === 'invoice') {
    recalcInvoice(f);
    if (e.target.name === 'date' && !f.dataset.id) f.due.value = addDays(f.date.value, D().company.payment_term_days ?? 14);
  } else if (f.dataset.form === 'expense') recalcExpense(f);
  else if (f.dataset.form === 'journal') recalcJournal(f);
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.matches?.('[data-client-name]')) { fillClient(el.form); return; }
  if (el.name === 'ctype') { applyClientType(el.form); return; }
  if (el.id === 'fcP') { el.form.querySelectorAll('[data-only=company]').forEach((x) => { x.hidden = el.checked; }); return; }
  if (el.id === 'bankFile') { loadBankFile(el.files[0]); return; }
  if (el.id === 'impFile') { importFile(el.files[0]); el.value = ''; return; }
  if (el.id === 'logoFile') { uploadLogo(el.files[0]); el.value = ''; return; }
  if (el.form?.dataset.form === 'expense') { recalcExpense(el.form); return; }
  const b = el.dataset?.bind;
  if (!b) return;
  if (b.startsWith('rep.')) S.rep[b.slice(4)] = el.value; else S[b] = el.value;
  render();
});
document.addEventListener('dragover', (e) => { const d = e.target.closest?.('#drop'); if (d) { e.preventDefault(); d.classList.add('over'); } });
document.addEventListener('dragleave', (e) => { const d = e.target.closest?.('#drop'); if (d) d.classList.remove('over'); });
document.addEventListener('drop', (e) => { const d = e.target.closest?.('#drop'); if (d) { e.preventDefault(); d.classList.remove('over'); loadBankFile(e.dataTransfer.files[0]); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

// ====================================================================
// Käivitus
// ====================================================================
async function refreshMfa() {
  try { const f = await api.listFactors(); S.mfa = { verified: (f.totp || []).find((x) => x.status === 'verified') || null, enrolling: null }; }
  catch { S.mfa = { verified: null, enrolling: null }; }
}
async function loadMembers() { S.members = await api.memberships(S.user.id); }
async function openCompany(id) {
  setBusy(1);
  try {
    const m = S.members.find((x) => x.company_id === id) || S.members[0];
    S.cid = m.company_id; S.role = m.role; S.bank = null; S.audit = null;
    try { localStorage.setItem('saldo.company', S.cid); } catch { /* ignore */ }
    await reload();
    S.screen = 'app';
    render();
  } catch (e) { toast(e.message); } finally { setBusy(-1); }
}
async function afterLogin() {
  const session = await api.getSession();
  if (!session) { S.screen = 'auth'; render(); return; }
  S.user = session.user;
  const level = await api.aal();
  if (level.nextLevel === 'aal2' && level.currentLevel !== 'aal2') { S.screen = 'mfa'; render(); return; }
  await refreshMfa();
  await loadMembers();
  if (!S.members.length) { S.screen = 'onboard'; render(); return; }
  let saved = null;
  try { saved = localStorage.getItem('saldo.company'); } catch { /* ignore */ }
  await openCompany(S.members.some((m) => m.company_id === saved) ? saved : S.members[0].company_id);
}

(async function boot() {
  if (!cfg.url || !cfg.anonKey || /SINU|YOUR/.test(cfg.url)) { S.screen = 'setup'; render(); return; }
  api.init(cfg);
  api.sb.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') { S.screen = 'recovery'; S.authErr = ''; render(); }
    if (event === 'SIGNED_OUT') { S.screen = 'auth'; S.D = null; render(); }
  });
  render();
  try {
    if (location.hash.includes('type=recovery')) { S.screen = 'recovery'; render(); return; }
    await afterLogin();
  } catch (e) { S.screen = 'auth'; S.authErr = e.message; render(); }
})();

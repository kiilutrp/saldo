// Pangaväljavõtte (CSV) lugemine ja maksete sidumine arvetega.
// Toetab Swedbanki, SEB, LHV ja Coop Panga CSV-vorminguid.
import { num, r2, n2 } from './util.js';

export function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const semi = (first.match(/;/g) || []).length, comma = (first.match(/,/g) || []).length;
  const delim = first.includes('\t') && !semi ? '\t' : semi >= comma ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

export function parseDate(s) {
  s = (s || '').trim();
  let m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : '';
}

export function bankRows(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const H = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (re, exclude) => H.findIndex((h) => re.test(h) && !(exclude && exclude.test(h)));
  const iDate = idx(/kuup|date|kpv/);
  let iAmt = idx(/^summa$|^amount$|^sum$/);
  if (iAmt < 0) iAmt = idx(/summa|amount/, /valuuta|currency/);
  const iDC = idx(/deebet\/kreedit|^d\/k$|debit\/credit|^d\/c$/);
  let iP = idx(/saaja\/maksja|maksja\/saaja|sender\/receiver name|counterparty|beneficiary/, /konto|account|iban|kood|code/);
  if (iP < 0) iP = idx(/maksja|saaja|sender|receiver|nimi|name/, /konto|account|iban|kood|code/);
  const iDesc = idx(/selgitus|description|details|explanation|sisu/);
  const iRef = idx(/viitenumber|viide|reference/, /dokumendi|archive|arhiiv/);
  const iType = idx(/reatüüp|reatuup|row type/);
  const out = [];
  for (const r of rows.slice(1)) {
    if (iType >= 0 && r[iType] && r[iType].trim() !== '20') continue; // Swedbank: 20 = tehing
    const date = parseDate(r[iDate]);
    if (!date) continue;
    let amount = num(r[iAmt]);
    if (!amount) continue;
    if (iDC >= 0) {
      const dc = (r[iDC] || '').trim().toUpperCase();
      if (dc === 'D') amount = -Math.abs(amount);
      else if (dc === 'K' || dc === 'C') amount = Math.abs(amount);
    }
    out.push({ date, amount: r2(amount), partner: (r[iP] || '').trim(), desc: (r[iDesc] || '').trim(),
      ref: iRef >= 0 ? (r[iRef] || '').trim() : '', match: null, done: false });
  }
  return out;
}

/** openInvoices: [{id, no, ref_no, contact_name, open}], openExpenses: [{id, supplier, open}] */
export function matchBank(rows, openInvoices, openExpenses) {
  const used = new Set();
  for (const r of rows) {
    const text = `${r.desc} ${r.ref} ${r.partner}`.toLowerCase();
    const tokens = text.replace(/[^\d]/g, ' ').split(/\s+/);
    if (r.amount > 0) {
      const open = openInvoices.filter((i) => !used.has(i.id));
      let m = open.find((i) => i.ref_no && (r.ref === i.ref_no || tokens.includes(i.ref_no)));
      let why = 'viitenumber kattub';
      if (!m) { m = open.find((i) => text.includes(String(i.no).toLowerCase())); why = 'arve number selgituses'; }
      if (!m) { const s = open.filter((i) => Math.abs(i.open - r.amount) < 0.005); if (s.length === 1) { m = s[0]; why = 'summa kattub'; } }
      if (m) {
        const diff = Math.abs(m.open - r.amount) >= 0.005;
        r.match = { type: 'inv', id: m.id, amount: Math.min(r.amount, m.open), why: diff ? `${why}, tasumata ${n2(m.open)}` : why };
        used.add(m.id);
      }
    } else {
      const open = openExpenses.filter((x) => !used.has(x.id) && Math.abs(x.open + r.amount) < 0.005);
      const m = open.find((x) => text.includes(x.supplier.toLowerCase().split(' ')[0])) || (open.length === 1 ? open[0] : null);
      if (m) { r.match = { type: 'exp', id: m.id, amount: -r.amount, why: 'summa kattub' }; used.add(m.id); }
    }
  }
  return rows;
}

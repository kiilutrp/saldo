// Aruannete arvutused pearaamatu ridadest.
// ledger rida: {date, account, account_type ('A','L','E','R','X'), debit, credit}
import { r2, num, monthKey, VAT_RATES, calcLines } from './util.js';

export function balances(ledger, from, to) {
  const B = {};
  for (const l of ledger) {
    if (from && l.date < from) continue;
    if (to && l.date > to) continue;
    const b = B[l.account] || (B[l.account] = { d: 0, k: 0, type: l.account_type, name: l.account_name });
    b.d += num(l.debit); b.k += num(l.credit);
  }
  return B;
}

/** Saldo konto loomulikul poolel: varad ja kulud deebetis, ülejäänud kreeditis. */
export function bal(B, a) {
  const b = B[a];
  if (!b) return 0;
  return r2(b.type === 'A' || b.type === 'X' ? b.d - b.k : b.k - b.d);
}

export function profit(ledger, from, to) {
  const B = balances(ledger, from, to);
  let rev = 0, cost = 0;
  for (const a of Object.keys(B)) {
    if (B[a].type === 'R') rev += bal(B, a);
    if (B[a].type === 'X') cost += bal(B, a);
  }
  return { rev: r2(rev), cost: r2(cost), profit: r2(rev - cost), B };
}

/** KMD andmed kuu kohta. invoices: kinnitatud arved (koos kreeditarvetega) ja nende read; expenses: aktiivsed kulud. */
export function vatMonth(k, invoices, linesByInvoice, expenses) {
  const out = {};
  for (const r of VAT_RATES) out[r] = { net: 0, vat: 0 };
  let outVat = 0, inVat = 0, inNet = 0;
  const invs = invoices.filter((i) => i.status === 'issued' && monthKey(i.date) === k);
  const exps = expenses.filter((x) => x.status === 'active' && monthKey(x.date) === k);
  for (const i of invs) {
    const c = calcLines(linesByInvoice[i.id] || []);
    for (const r of Object.keys(c.by)) {
      const o = out[r] || (out[r] = { net: 0, vat: 0 });
      o.net += c.by[r].net; o.vat += c.by[r].vat; outVat += c.by[r].vat;
    }
  }
  for (const x of exps) { inVat += num(x.vat); inNet += num(x.net); }
  for (const r of Object.keys(out)) { out[r].net = r2(out[r].net); out[r].vat = r2(out[r].vat); }
  return { out, outVat: r2(outVat), inVat: r2(inVat), inNet: r2(inNet), invs, exps };
}

/** KMD INF: partnerid, kellega kuu tehingud on vähemalt 1000 € km-ta. */
export function kmdInf(docs, nameOf, netOf) {
  const g = {};
  for (const o of docs) {
    const n = nameOf(o);
    (g[n] = g[n] || { name: n, docs: [], net: 0 }).docs.push(o);
    g[n].net += num(netOf(o));
  }
  return Object.values(g).filter((x) => x.net >= 1000);
}

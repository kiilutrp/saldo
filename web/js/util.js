// Üldised abifunktsioonid: vormindus, kuupäevad, ümardamine, viitenumber, arve summad.

export const MONTHS = ['jaan', 'veebr', 'märts', 'apr', 'mai', 'juuni', 'juuli', 'aug', 'sept', 'okt', 'nov', 'dets'];
export const VAT_RATES = [24, 13, 9, 0];
export const KMD_ROW = { 24: '1', 9: '2', 13: '2²', 0: '3' };

const eurF = new Intl.NumberFormat('et-EE', { style: 'currency', currency: 'EUR' });
const n2F = new Intl.NumberFormat('et-EE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Ümardab 2 kohani, sümmeetriliselt nulli suhtes (nagu PostgreSQL round). */
export function r2(x) {
  const v = Number(x) || 0;
  const s = v < 0 ? -1 : 1;
  return (s * Math.round(Math.abs(v) * 100 + 1e-9)) / 100;
}
export const eur = (x) => eurF.format(r2(x));
export const n2 = (x) => n2F.format(r2(x));
export function num(v) {
  const x = parseFloat(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(x) ? x : 0;
}
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export const today = () => iso(new Date());
export function addDays(s, n) { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + Number(n || 0)); return iso(d); }
export const fd = (s) => (s ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : '—');
export const monthKey = (s) => (s || '').slice(0, 7);
export const monthLabel = (k) => `${MONTHS[+k.slice(5, 7) - 1]} ${k.slice(0, 4)}`;
export function lastDay(k) { const [y, m] = k.split('-').map(Number); return iso(new Date(y, m, 0)); }
export const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5);

/** Eesti viitenumber (meetod 7-3-1), sama mis andmebaasi app.ref_no. */
export function refNo(no) {
  let b = String(no || '').replace(/\D/g, '').replace(/^0+/, '');
  if (!b) return '';
  if (b.length < 2) b = '1' + b;
  b = b.slice(-19);
  const w = [7, 3, 1];
  let s = 0;
  for (let i = 0; i < b.length; i++) s += Number(b[b.length - 1 - i]) * w[i % 3];
  return b + ((10 - (s % 10)) % 10);
}

/** Arve summad EN 16931 järgi: käibemaks ümardatakse määra kaupa (sama mis app.recalc_invoice). */
export function calcLines(lines) {
  const by = {};
  let net = 0, vat = 0;
  for (const l of lines || []) {
    const rate = Number(l.vat_rate ?? l.vat) || 0;
    const ln = r2(num(l.qty) * num(l.price));
    by[rate] = by[rate] || { net: 0, vat: 0 };
    by[rate].net += ln;
  }
  for (const k of Object.keys(by)) {
    by[k].net = r2(by[k].net);
    by[k].vat = r2((by[k].net * Number(k)) / 100);
    net += by[k].net; vat += by[k].vat;
  }
  return { net: r2(net), vat: r2(vat), gross: r2(net + vat), by };
}

/** Ostuarve: summast koos KM-ga eraldatakse käibemaks. */
export function expCalc(gross, rate) {
  const g = r2(num(gross)), r = Number(rate) || 0;
  const vat = r2((g * r) / (100 + r));
  return { gross: g, vat, net: r2(g - vat) };
}

export function nextInvoiceNo(invoices, prefix) {
  const p = prefix || `${new Date().getFullYear()}-`;
  let max = 0;
  for (const i of invoices) {
    if (String(i.no).startsWith(p)) { const t = parseInt(String(i.no).slice(p.length), 10); if (t > max) max = t; }
  }
  return p + String(max + 1).padStart(3, '0');
}

export function download(filename, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

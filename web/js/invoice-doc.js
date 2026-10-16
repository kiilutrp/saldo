// Arve dokumendi kujundus (A4). Kasutatakse eelvaates ja printimisel / PDF-is.
import { calcLines, esc, fd, n2, num, refNo } from './util.js';

const CSS = `
@page{size:A4;margin:0}
*{box-sizing:border-box}
html,body{margin:0;background:#E9EDF2}
body{font:13px/1.5 "Schibsted Grotesk",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#141A24;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.mono{font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums}
.sheet{width:210mm;min-height:297mm;margin:24px auto;background:#fff;box-shadow:0 6px 30px rgba(20,26,36,.12);display:flex;flex-direction:column;position:relative;overflow:hidden}
.band{height:7mm;background:var(--accent)}
.inner{padding:14mm 16mm 0;display:flex;flex-direction:column;gap:9mm;flex:1}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:10mm}
.brand{display:flex;align-items:center;gap:5mm}
.logo{max-height:24mm;max-width:50mm;object-fit:contain;display:block}
.co{font-size:21px;font-weight:750;letter-spacing:-.02em;line-height:1.15}
.co-sub{color:#5B6575;font-size:12px;margin-top:3px}
.title{text-align:right}
.kind{font-size:30px;font-weight:800;letter-spacing:.08em;color:var(--accent);line-height:1}
.no{font-size:14px;margin-top:6px;color:#3A4352}
.stamp{display:inline-block;margin-top:8px;border:1.5px solid #1D7A4E;color:#1D7A4E;font-weight:700;font-size:11px;letter-spacing:.12em;padding:3px 8px;border-radius:4px;text-transform:uppercase}
.parties{display:grid;grid-template-columns:1fr auto;gap:10mm;align-items:start}
.lbl{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#7A8494;font-weight:700;margin-bottom:5px}
.to b{font-size:15px;font-weight:700;display:block;margin-bottom:2px}
.to div{color:#3A4352}
.meta{margin:0;display:grid;grid-template-columns:auto 1fr;gap:6px 14px;background:var(--soft);border-radius:8px;padding:12px 14px}
.meta dt{color:#5B6575}
.meta dd{margin:0;text-align:right;font-weight:600;white-space:nowrap}
table{width:100%;border-collapse:collapse}
thead th{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#7A8494;font-weight:700;text-align:left;padding:0 8px 8px;border-bottom:1.5px solid #141A24}
thead th.r,td.r{text-align:right}
tbody td{padding:10px 8px;border-bottom:1px solid #E4E8EE;vertical-align:top}
tbody td.desc{font-weight:500}
tbody tr:last-child td{border-bottom:1px solid #C9D0DA}
.bottom{display:grid;grid-template-columns:1fr 78mm;gap:10mm;align-items:start}
.after{display:flex;flex-direction:column;gap:3mm;margin-top:-2mm}
.notes{color:#3A4352;white-space:pre-line;max-width:120mm}
.totals{display:grid;grid-template-columns:1fr auto;gap:5px 14px}
.totals span:nth-child(odd){color:#5B6575}
.totals span:nth-child(even){text-align:right}
.grand{grid-column:1/-1;display:flex;justify-content:space-between;align-items:baseline;margin-top:8px;padding-top:10px;border-top:1.5px solid #141A24}
.grand b{font-size:14px;font-weight:700}
.grand .mono{font-size:18px;font-weight:600}
.pay{border-top:1px solid #E4E8EE;padding-top:10px;display:grid;grid-template-columns:repeat(4,auto);gap:2px 18px;justify-content:space-between}
.pay .lbl{margin:0;font-size:9.5px}
.pay .v{font-size:13px;font-weight:500}
.thanks{margin:0;font-size:13px;font-weight:500;color:#3A4352}
.foot{margin-top:auto;padding:7mm 16mm 9mm;border-top:1px solid #E4E8EE;color:#6B7585;font-size:10.5px;display:flex;flex-wrap:wrap;gap:4px 16px}
.foot b{color:#3A4352;font-weight:600}
@media screen and (max-width:850px){.sheet{width:100%;margin:0;box-shadow:none;min-height:0}}
@media screen and (max-width:600px){
  .sheet{width:auto;min-height:0;margin:0;box-shadow:none}
  .inner{padding:22px 18px 0}
  .top,.parties,.bottom{display:flex;flex-direction:column;gap:18px}
  .parties>*,.bottom>*{width:100%}
  .title{text-align:left}
  .pay{grid-template-columns:1fr 1fr}
  .foot{padding:18px}
  table{font-size:12px}
}
@media print{html,body{background:#fff}.sheet{margin:0;box-shadow:none}}
`;

/**
 * @param {object} i arve; @param {Array} lines read; @param {object} c ettevõte; @param {object} cl klient
 * @param {object} opt {origNo, paidDate, accent}
 */
export function invoiceDoc(i, lines, c, cl = {}, opt = {}) {
  const credit = i.kind === 'credit';
  const quote = i.kind === 'quote';
  const title = quote ? 'Hinnapakkumine' : credit ? 'Kreeditarve' : 'Arve';
  const cc = calcLines(lines);
  const ref = i.ref_no || refNo(i.no);
  const accent = /^#[0-9a-f]{6}$/i.test(opt.accent || '') ? opt.accent : '#1C5DC2';
  const qty = (q) => String(+num(q)).replace('.', ',');
  const rates = Object.keys(cc.by).map(Number).sort((a, b) => b - a);
  const vatRows = rates.filter((r) => r > 0).map((r) => `<span>Käibemaks ${r}% (${n2(cc.by[r].net)} €)</span><span class="mono">${n2(cc.by[r].vat)}</span>`).join('');
  const sellerBits = [
    c.regcode && `Reg. kood <b>${esc(c.regcode)}</b>`, c.vatno && `KMKR <b>${esc(c.vatno)}</b>`,
    c.address && esc(c.address), c.email && esc(c.email), c.phone && esc(c.phone),
  ].filter(Boolean);
  return `<!doctype html><html lang="et"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} ${esc(i.no)} · ${esc(c.name || '')}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>:root{--accent:${accent};--soft:${accent}12}${CSS}</style></head><body>
<div class="sheet">
  <div class="band"></div>
  <div class="inner">
    <div class="top">
      <div class="brand">${c.logo && /^data:image\//.test(c.logo) ? `<img class="logo" src="${esc(c.logo)}" alt="">` : ''}<div><div class="co">${esc(c.name || 'Ettevõtte nimi')}</div><div class="co-sub">${esc(c.address || '')}</div></div></div>
      <div class="title"><div class="kind">${title.toUpperCase()}</div><div class="no">Nr <span class="mono">${esc(i.no)}</span></div>
        ${!credit && !quote && opt.paidDate ? `<div class="stamp">Tasutud ${fd(opt.paidDate)}</div>` : ''}</div>
    </div>
    <div class="parties">
      <div class="to"><div class="lbl">${quote ? 'Pakkumise saaja' : 'Arve saaja'}</div><b>${esc(i.contact_name)}</b>
        ${cl.address ? `<div>${esc(cl.address)}</div>` : ''}${cl.regcode ? `<div>${cl.person ? 'Isikukood' : 'Reg. kood'} ${esc(cl.regcode)}</div>` : ''}${cl.vatno && !cl.person ? `<div>KMKR ${esc(cl.vatno)}</div>` : ''}</div>
      <dl class="meta">
        <dt>${quote ? 'Kuupäev' : 'Arve kuupäev'}</dt><dd class="mono">${fd(i.date)}</dd>
        ${quote ? `<dt>Kehtib kuni</dt><dd class="mono">${fd(i.valid_until)}</dd>` : credit ? (opt.origNo ? `<dt>Algne arve</dt><dd class="mono">${esc(opt.origNo)}</dd>` : '') : `<dt>Maksetähtaeg</dt><dd class="mono">${fd(i.due)}</dd><dt>Viitenumber</dt><dd class="mono">${esc(ref)}</dd><dt>Arveldusarve</dt><dd class="mono">${esc(c.iban || '—')}</dd>${c.bank ? `<dt>Pank</dt><dd>${esc(c.bank)}</dd>` : ''}`}
        ${i.buyer_ref ? `<dt>Teie viide</dt><dd>${esc(i.buyer_ref)}</dd>` : ''}
      </dl>
    </div>
    <table>
      <thead><tr><th>Kirjeldus</th><th class="r">Kogus</th><th class="r">Ühiku hind</th><th class="r">KM</th><th class="r">Summa</th></tr></thead>
      <tbody>${lines.map((l) => `<tr><td class="desc">${esc(l.description)}</td><td class="r mono">${qty(l.qty)}&nbsp;${esc(l.unit || '')}</td><td class="r mono">${n2(l.price)}</td><td class="r mono">${+l.vat_rate}%</td><td class="r mono">${n2(num(l.qty) * num(l.price))}</td></tr>`).join('')}</tbody>
    </table>
    <div class="bottom">
      <div></div>
      <div class="totals">
        <span>Summa käibemaksuta</span><span class="mono">${n2(cc.net)}</span>${vatRows}
        <div class="grand"><b>${credit || quote ? 'Kokku' : 'Tasuda'}</b><span class="mono">${n2(cc.gross)} €</span></div>
      </div>
    </div>
    <div class="after">${quote ? `<p class="thanks">Pakkumine kehtib kuni ${fd(i.valid_until)}.</p>` : credit ? '' : '<p class="thanks">Aitäh arve õigeaegse tasumise eest!</p>'}${i.notes ? `<div class="notes">${esc(i.notes)}</div>` : ''}</div>
  </div>
  <div class="foot"><b>${esc(c.name || '')}</b>${sellerBits.map((b) => `<span>${b}</span>`).join('')}</div>
</div></body></html>`;
}

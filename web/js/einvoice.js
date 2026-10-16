// E-arve: EN 16931 / Peppol BIS Billing 3.0 (UBL 2.1)
import { calcLines, r2, num, fd, refNo } from './util.js';

const xe = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const amt = (x) => r2(x).toFixed(2);

export function splitAddr(a) {
  const p = String(a || '').split(',').map((s) => s.trim()).filter(Boolean);
  const street = p[0] || '';
  const rest = p.slice(1).join(' ');
  const m = rest.match(/(\d{5})\s*(.*)/);
  return m ? { street, zip: m[1], city: m[2] } : { street, zip: '', city: rest };
}

export function unitCode(u) {
  u = String(u || '').toLowerCase().replace(/\./g, '').trim();
  return ({ tk: 'H87', h: 'HUR', t: 'HUR', tund: 'HUR', tundi: 'HUR', kuu: 'MON', p: 'DAY', 'päev': 'DAY', paev: 'DAY',
    km: 'KMT', kg: 'KGM', l: 'LTR', m: 'MTR', m2: 'MTK', kmpl: 'SET', komplekt: 'SET' })[u] || 'C62';
}

/** Puuduvad andmed: level "err" takistab allalaadimist, "warn" on hoiatus. */
export function einvCheck(inv, lines, company, contact) {
  const c = company || {}, cl = contact || {}, out = [];
  const E = (msg) => out.push({ level: 'err', msg }), W = (msg) => out.push({ level: 'warn', msg });
  if (inv.status !== 'issued') E('Kinnita arve enne e-arve koostamist.');
  if (!c.name) E('Lisa seadetes ettevõtte ärinimi.');
  if (!c.regcode) E('Lisa seadetes registrikood. See on e-arve saatja tunnus.');
  if (!c.iban) E('Lisa seadetes IBAN.');
  if (c.vat_payer && !c.vatno) E('Lisa seadetes KMKR number. Käibemaksuga arvel on see kohustuslik.');
  if (!cl.regcode && !cl.peppol_id) E('Lisa kliendi registrikood partnerite alt, et e-arve jõuaks õige ostjani.');
  if (!c.address) W('Ettevõtte aadress puudub.');
  if (!cl.address) W('Kliendi aadress puudub.');
  return out;
}

function party(p) {
  const ad = splitAddr(p.address);
  const ep = String(p.endpoint || '').trim();
  const [sch, id] = ep ? (ep.includes(':') ? [ep.slice(0, ep.indexOf(':')), ep.slice(ep.indexOf(':') + 1)] : ['0191', ep]) : ['0191', p.regcode];
  return `<cac:Party>
      <cbc:EndpointID schemeID="${xe(sch)}">${xe(id)}</cbc:EndpointID>
      <cac:PartyName><cbc:Name>${xe(p.name)}</cbc:Name></cac:PartyName>
      <cac:PostalAddress>${ad.street ? `<cbc:StreetName>${xe(ad.street)}</cbc:StreetName>` : ''}${ad.city ? `<cbc:CityName>${xe(ad.city)}</cbc:CityName>` : ''}${ad.zip ? `<cbc:PostalZone>${xe(ad.zip)}</cbc:PostalZone>` : ''}<cac:Country><cbc:IdentificationCode>EE</cbc:IdentificationCode></cac:Country></cac:PostalAddress>${p.vatno ? `
      <cac:PartyTaxScheme><cbc:CompanyID>${xe(p.vatno.replace(/\s/g, ''))}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>` : ''}
      <cac:PartyLegalEntity><cbc:RegistrationName>${xe(p.name)}</cbc:RegistrationName>${p.regcode ? `<cbc:CompanyID>${xe(p.regcode)}</cbc:CompanyID>` : ''}</cac:PartyLegalEntity>${p.email ? `
      <cac:Contact><cbc:ElectronicMail>${xe(p.email)}</cbc:ElectronicMail></cac:Contact>` : ''}
    </cac:Party>`;
}

/** Koostab UBL 2.1 XML-i. Kreeditarve puhul InvoiceTypeCode 381 ja positiivsed summad (BT-3). */
export function ublXML(inv, lines, company, contact) {
  const c = company, cl = contact || {}, vp = !!c.vat_payer;
  const isCredit = inv.kind === 'credit';
  const sign = isCredit ? -1 : 1;
  const L = lines.map((l) => ({ ...l, qty: num(l.qty) * sign }));
  const cc = calcLines(L);
  const cat = (r) => (!vp ? 'O' : +r > 0 ? 'S' : 'Z');
  const taxCat = (tag, r) => `<cac:${tag}><cbc:ID>${cat(r)}</cbc:ID>${vp ? `<cbc:Percent>${Number(r)}</cbc:Percent>` : ''}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:${tag}>`;
  const subs = vp
    ? Object.keys(cc.by).map((r) => `
    <cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">${amt(cc.by[r].net)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">${amt(cc.by[r].vat)}</cbc:TaxAmount>${taxCat('TaxCategory', r)}</cac:TaxSubtotal>`).join('')
    : `
    <cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">${amt(cc.net)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">0.00</cbc:TaxAmount><cac:TaxCategory><cbc:ID>O</cbc:ID><cbc:TaxExemptionReason>Müüja ei ole käibemaksukohustuslane</cbc:TaxExemptionReason><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`;
  const tax = vp ? cc.vat : 0, gross = r2(cc.net + tax);
  const lineTag = isCredit ? 'CreditNoteLine' : 'InvoiceLine';
  const qtyTag = isCredit ? 'CreditedQuantity' : 'InvoicedQuantity';
  const rows = L.map((l, ix) => `
  <cac:${lineTag}>
    <cbc:ID>${ix + 1}</cbc:ID>
    <cbc:${qtyTag} unitCode="${unitCode(l.unit)}">${num(l.qty)}</cbc:${qtyTag}>
    <cbc:LineExtensionAmount currencyID="EUR">${amt(num(l.qty) * num(l.price))}</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>${xe(l.description)}</cbc:Name>${taxCat('ClassifiedTaxCategory', l.vat_rate)}</cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">${num(l.price)}</cbc:PriceAmount></cac:Price>
  </cac:${lineTag}>`).join('');
  const root = isCredit ? 'CreditNote' : 'Invoice';
  const ns = isCredit ? 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2' : 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
  const ref = inv.ref_no || refNo(inv.no);
  return `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="${ns}" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>${xe(inv.no)}</cbc:ID>
  <cbc:IssueDate>${inv.date}</cbc:IssueDate>${isCredit ? '' : `
  <cbc:DueDate>${inv.due}</cbc:DueDate>`}
  <cbc:${isCredit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'}>${isCredit ? 381 : 380}</cbc:${isCredit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'}>${inv.notes ? `
  <cbc:Note>${xe(inv.notes)}</cbc:Note>` : ''}
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>${xe(inv.buyer_ref || ref || inv.no)}</cbc:BuyerReference>${isCredit && inv.credit_of_no ? `
  <cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${xe(inv.credit_of_no)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>` : ''}
  <cac:AccountingSupplierParty>
    ${party({ name: c.name, regcode: c.regcode, vatno: vp ? c.vatno : '', address: c.address, email: c.email })}
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    ${party({ name: inv.contact_name, regcode: cl.regcode, vatno: vp ? cl.vatno : '', address: cl.address, email: cl.email, endpoint: cl.peppol_id })}
  </cac:AccountingCustomerParty>${isCredit ? '' : `
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>
    <cbc:PaymentID>${xe(ref)}</cbc:PaymentID>
    <cac:PayeeFinancialAccount><cbc:ID>${xe(String(c.iban || '').replace(/\s/g, ''))}</cbc:ID><cbc:Name>${xe(c.name)}</cbc:Name></cac:PayeeFinancialAccount>
  </cac:PaymentMeans>
  <cac:PaymentTerms><cbc:Note>Maksetähtaeg ${fd(inv.due)}</cbc:Note></cac:PaymentTerms>`}
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">${amt(tax)}</cbc:TaxAmount>${subs}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="EUR">${amt(cc.net)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">${amt(cc.net)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">${amt(gross)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">${amt(gross)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${rows}
</${root}>
`;
}

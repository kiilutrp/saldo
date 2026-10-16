// Andmekiht: kõik päringud Supabase'i poole.
// Kirjendamine käib andmebaasi funktsioonide (RPC) kaudu; need kontrollivad õigusi ja kannete tasakaalu.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.0/+esm';

export let sb = null;

export function init(cfg) {
  sb = createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return sb;
}

/** Teeb Supabase'i vea kasutajale arusaadavaks. */
export function friendly(error) {
  const m = String(error?.message || error || '');
  if (/Invalid login credentials/i.test(m)) return 'Vale e-post või parool.';
  if (/Email not confirmed/i.test(m)) return 'Kinnita enne oma e-posti aadress. Vaata postkasti.';
  if (/User already registered/i.test(m)) return 'Selle e-postiga konto on juba olemas. Logi sisse.';
  if (/Password should be at least/i.test(m)) return 'Parool peab olema vähemalt 8 märki pikk.';
  if (/rate limit/i.test(m)) return 'Liiga palju katseid. Oota natuke ja proovi uuesti.';
  if (/Invalid TOTP|Invalid MFA|invalid.*code/i.test(m)) return 'Kood ei sobi. Kontrolli, et telefoni kellaaeg on õige, ja proovi uuesti.';
  if (/duplicate key.*invoices_company_id_no/i.test(m)) return 'Selle numbriga arve on juba olemas.';
  if (/permission denied|row-level security/i.test(m)) return 'Sul pole selleks õigust.';
  if (/violates foreign key.*contacts/i.test(m)) return 'Partner on dokumentidega seotud.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Ühendus serveriga katkes. Kontrolli internetiühendust.';
  return m || 'Midagi läks valesti.';
}

async function must(p) {
  const { data, error } = await p;
  if (error) throw new Error(friendly(error));
  return data;
}

/** Laeb kogu tabeli 1000 rea kaupa (PostgREST piirab vastuse suurust). */
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = await must(build().range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

// ---------- autentimine ----------
export const redirectUrl = () => location.origin + location.pathname;
export const getSession = async () => (await sb.auth.getSession()).data.session;
export const signIn = (email, password) => must(sb.auth.signInWithPassword({ email, password }));
export const signUp = (email, password) => must(sb.auth.signUp({ email, password, options: { emailRedirectTo: redirectUrl() } }));
export const resetPassword = (email) => must(sb.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() }));
export const updatePassword = (password) => must(sb.auth.updateUser({ password }));
export const signOut = () => sb.auth.signOut();

export const aal = () => must(sb.auth.mfa.getAuthenticatorAssuranceLevel());
export const listFactors = () => must(sb.auth.mfa.listFactors());
export const enrollTotp = () => must(sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Saldo ' + new Date().toISOString().slice(0, 10) }));
export async function verifyTotp(factorId, code) {
  const ch = await must(sb.auth.mfa.challenge({ factorId }));
  return must(sb.auth.mfa.verify({ factorId, challengeId: ch.id, code: String(code).replace(/\s/g, '') }));
}
export const unenroll = (factorId) => must(sb.auth.mfa.unenroll({ factorId }));

// ---------- ettevõtted ----------
export const memberships = (uid) =>
  must(sb.from('company_members').select('company_id, role, companies(name)').eq('user_id', uid));
export const createCompany = (name) => must(sb.rpc('create_company', { p_name: name }));
export const updateCompany = (id, patch) => must(sb.from('companies').update(patch).eq('id', id));

export async function loadAll(cid) {
  const q = (t, order, opts) => () => sb.from(t).select('*').eq('company_id', cid).order(order, opts || { ascending: true });
  const [company, accounts, contacts, invoices, lines, expenses, payments, ledger, quotes, quoteLines] = await Promise.all([
    must(sb.from('companies').select('*').eq('id', cid).single()),
    fetchAll(q('accounts', 'code')),
    fetchAll(q('contacts', 'name')),
    fetchAll(q('invoices', 'date', { ascending: false })),
    fetchAll(() => sb.from('invoice_lines').select('*').eq('company_id', cid).order('invoice_id').order('position')),
    fetchAll(q('expenses', 'date', { ascending: false })),
    fetchAll(q('payments', 'date')),
    fetchAll(() => sb.from('ledger').select('*').eq('company_id', cid).order('date').order('no').order('line_id')),
    fetchAll(q('quotes', 'date', { ascending: false })).catch(() => null),
    fetchAll(() => sb.from('quote_lines').select('*').eq('company_id', cid).order('quote_id').order('position')).catch(() => []),
  ]);
  return { company, accounts, contacts, invoices, lines, expenses, payments, ledger, quotes, quoteLines };
}

export const auditLog = (cid) => must(sb.from('audit_log').select('*').eq('company_id', cid).order('at', { ascending: false }).limit(100));

// ---------- partnerid ja kontod ----------
export const saveContact = (row) => row.id
  ? must(sb.from('contacts').update(row).eq('id', row.id))
  : must(sb.from('contacts').insert(row).select('id').single());
export const deleteContact = (id) => must(sb.from('contacts').delete().eq('id', id));
export const addAccount = (row) => must(sb.from('accounts').insert(row));
export const updateAccount = (cid, code, patch) => must(sb.from('accounts').update(patch).eq('company_id', cid).eq('code', code));

// ---------- dokumendid ja kanded ----------
const rpc = (fn, args) => must(sb.rpc(fn, args));
export const saveInvoiceDraft = (p) => rpc('save_invoice_draft', { p });
export const issueInvoice = (id) => rpc('issue_invoice', { p_id: id });
export const deleteInvoiceDraft = (id) => rpc('delete_invoice_draft', { p_id: id });
export const creditInvoice = (id, no, date) => rpc('credit_invoice', { p_id: id, p_no: no, p_date: date });
export const markEinvoiceSent = (id, sent) => rpc('mark_einvoice_sent', { p_id: id, p_sent: sent });
export const saveExpense = (p) => rpc('save_expense', { p });
export const cancelExpense = (id, date) => rpc('cancel_expense', { p_id: id, p_date: date });
export const addPayment = (cid, invoiceId, expenseId, date, amount, account = '1020', note = '') =>
  rpc('add_payment', { p_company: cid, p_invoice: invoiceId, p_expense: expenseId, p_date: date, p_amount: amount, p_account: account, p_note: note });
export const cancelPayment = (id, date) => rpc('cancel_payment', { p_id: id, p_date: date });
export const createManualEntry = (p) => rpc('create_manual_entry', { p });
export const reverseEntry = (id, date) => rpc('reverse_entry', { p_id: id, p_date: date });
export const postVat = (cid, month, kind, amount, date) => rpc('post_vat', { p_company: cid, p_month: month, p_kind: kind, p_amount: amount, p_date: date });
export const saveQuote = (p) => rpc('save_quote', { p });
export const setQuoteStatus = (id, status) => rpc('set_quote_status', { p_id: id, p_status: status });
export const deleteQuote = (id) => rpc('delete_quote', { p_id: id });
export const quoteToInvoice = (id, no, date) => rpc('quote_to_invoice', { p_id: id, p_no: no, p_date: date });
export const importPrototype = (cid, data) => rpc('import_prototype', { p_company: cid, p: data });

// ---------- algdokumendid ----------
export async function uploadDocument(cid, file) {
  const safe = file.name.normalize('NFKD').replace(/[^\w.-]+/g, '_').slice(-80);
  const path = `${cid}/${crypto.randomUUID()}-${safe}`;
  await must(sb.storage.from('documents').upload(path, file, { contentType: file.type || undefined, upsert: false }));
  return path;
}
export async function documentUrl(path) {
  const d = await must(sb.storage.from('documents').createSignedUrl(path, 300));
  return d.signedUrl;
}

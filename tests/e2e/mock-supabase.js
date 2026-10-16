// Supabase'i kliendi jäljendus testimiseks. Suunab päringud tests/e2e/server.py-le.
const API = location.origin + '/api';
const KEY = 'mock.session';
const getS = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
const setS = (s) => { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); };
async function call(body) {
  const s = getS();
  const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, token: s?.access_token }) });
  return r.json();
}
class Q {
  constructor(t) { this.t = t; this.op = 'select'; this.f = []; this.o = []; }
  select(cols) { this.cols = cols || '*'; this.ret = true; return this; }
  eq(k, v) { this.f.push([k, v]); return this; }
  order(k, o) { this.o.push([k, o?.ascending ?? true]); return this; }
  range(a, b) { this.rg = [a, b]; return this; }
  limit(n) { this.lim = n; return this; }
  single() { this.one = true; return this; }
  insert(v) { this.op = 'insert'; this.vals = v; return this; }
  update(v) { this.op = 'update'; this.vals = v; return this; }
  delete() { this.op = 'delete'; return this; }
  then(res, rej) {
    return call({ kind: 'table', table: this.t, op: this.op, cols: this.cols, filters: this.f, order: this.o, range: this.rg, limit: this.lim,
      single: !!this.one, values: this.vals, returning: !!this.ret }).then(res, rej);
  }
}
export function createClient() {
  let cb = () => {};
  const auth = {
    async getSession() { return { data: { session: getS() } }; },
    async signInWithPassword({ email, password }) { const r = await call({ kind: 'login', email, password }); if (r.data) setS(r.data.session); return r; },
    async signUp({ email, password }) { const r = await call({ kind: 'signup', email, password }); if (r.data) setS(r.data.session); return r; },
    async resetPasswordForEmail() { return { data: {}, error: null }; },
    async updateUser() { return { data: {}, error: null }; },
    async signOut() { setS(null); cb('SIGNED_OUT'); return { error: null }; },
    onAuthStateChange(f) { cb = f; return { data: { subscription: { unsubscribe() {} } } }; },
    mfa: {
      async getAuthenticatorAssuranceLevel() {
        const s = getS(); const f = await call({ kind: 'factors' });
        const cur = (s?.access_token || '').endsWith('aal2') ? 'aal2' : 'aal1';
        return { data: { currentLevel: cur, nextLevel: (f.data || []).some((x) => x.status === 'verified') ? 'aal2' : 'aal1' }, error: null };
      },
      async listFactors() { const f = await call({ kind: 'factors' }); const all = f.data || []; return { data: { all, totp: all.filter((x) => x.status === 'verified') }, error: null }; },
      async enroll() { return call({ kind: 'enroll' }); },
      async challenge() { return { data: { id: 'challenge' }, error: null }; },
      async verify({ factorId, code }) { const r = await call({ kind: 'verify', factorId, code }); if (r.data) { const s = getS(); s.access_token = r.data.access_token; setS(s); } return r; },
      async unenroll({ factorId }) { return call({ kind: 'unenroll', factorId }); },
    },
  };
  return {
    auth,
    from: (t) => new Q(t),
    rpc: (fn, args) => call({ kind: 'rpc', fn, args }),
    storage: { from: (bucket) => ({
      upload: (path) => call({ kind: 'upload', bucket, path }),
      createSignedUrl: async () => ({ data: { signedUrl: 'about:blank' }, error: null }),
    }) },
  };
}

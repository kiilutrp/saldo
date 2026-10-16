"""Testserver: jäljendab Supabase'i (autentimine + PostgREST) kohaliku PostgreSQL-i peal.

Iga päring käivitatakse rollis `authenticated` koos JWT väidetega, nii et
Row Level Security ja andmebaasi funktsioonid töötavad nagu päris Supabase'is.
Ainult testimiseks, mitte tootmiseks.
"""
import json, os, re, subprocess, sys, uuid
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

WEB = os.path.join(os.path.dirname(__file__), '..', '..', 'web')
PG = ['psql', '-h', os.environ.get('PGHOST', '/tmp/pgsaldo'), '-p', os.environ.get('PGPORT', '54329'),
      '-U', 'postgres', '-d', os.environ.get('PGDATABASE', 'saldo_e2e'), '-At', '-q', '-v', 'ON_ERROR_STOP=1']
USERS = {}  # email -> {id, password}
IDENT = re.compile(r'^[a-z_][a-z0-9_]*$')


def lit(v):
    if v is None:
        return 'null'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, (dict, list)):
        return "'" + json.dumps(v).replace("'", "''") + "'::jsonb"
    return "'" + str(v).replace("'", "''") + "'"


def ident(x):
    if not IDENT.match(x):
        raise ValueError('bad identifier ' + x)
    return x


def run_sql(sql, uid=None, aal='aal1'):
    pre = ''
    if uid:
        claims = json.dumps({'sub': uid, 'aal': aal, 'role': 'authenticated'}).replace("'", "''")
        pre = f"set local role authenticated; select set_config('request.jwt.claims', '{claims}', true) \\g /dev/null\n"
    script = f"begin;\n{pre}{sql};\ncommit;\n"
    p = subprocess.run(PG, input=script, capture_output=True, text=True)
    if p.returncode != 0:
        m = re.search(r'ERROR:\s+(.*)', p.stderr)
        raise RuntimeError(m.group(1) if m else p.stderr.strip())
    out = p.stdout.strip()
    return json.loads(out) if out else None


def table_query(b, uid, aal):
    t = ident(b['table'])
    where = ' and '.join(f"{ident(k)} = {lit(v)}" for k, v in b.get('filters') or [])
    w = f' where {where}' if where else ''
    op = b['op']
    if op == 'select':
        cols = b.get('cols') or '*'
        embed = ''
        if 'companies(name)' in cols:
            cols = 'company_id, role'
            embed = ", (select json_build_object('name', c.name) from public.companies c where c.id = x.company_id) as companies"
        else:
            cols = '*' if cols.strip() == '*' else ', '.join(ident(c.strip()) for c in cols.split(','))
        order = ', '.join(f"{ident(k)} {'asc' if a else 'desc'}" for k, a in b.get('order') or [])
        o = f' order by {order}' if order else ''
        lim = ''
        if b.get('range'):
            a, z = b['range']; lim = f' limit {int(z) - int(a) + 1} offset {int(a)}'
        elif b.get('limit'):
            lim = f" limit {int(b['limit'])}"
        sql = f"select coalesce(json_agg(r), '[]') from (select {cols}{embed} from public.{t} x{w}{o}{lim}) r"
        rows = run_sql(sql, uid, aal)
        if b.get('single'):
            if not rows:
                raise RuntimeError('JSON object requested, multiple (or no) rows returned')
            return rows[0]
        return rows
    if op == 'insert':
        v = b['values']; v = v if isinstance(v, list) else [v]
        cols = list(v[0].keys())
        vals = ', '.join('(' + ', '.join(lit(r.get(c)) for c in cols) + ')' for r in v)
        sql = f"with ins as (insert into public.{t} ({', '.join(map(ident, cols))}) values {vals} returning *) select coalesce(json_agg(ins), '[]') from ins"
        rows = run_sql(sql, uid, aal)
        return rows[0] if b.get('single') else (rows if b.get('returning') else None)
    if op == 'update':
        sets = ', '.join(f"{ident(k)} = {lit(v)}" for k, v in b['values'].items())
        sql = f"with u as (update public.{t} set {sets}{w} returning *) select coalesce(json_agg(u), '[]') from u"
        run_sql(sql, uid, aal); return None
    if op == 'delete':
        sql = f"with d as (delete from public.{t}{w} returning 1) select coalesce(json_agg(d), '[]') from d"
        run_sql(sql, uid, aal); return None
    raise ValueError('op')


def rpc(b, uid, aal):
    fn = ident(b['fn'])
    args = ', '.join(f"{ident(k)} => {lit(v)}" for k, v in (b.get('args') or {}).items())
    return run_sql(f"select to_json(public.{fn}({args}))", uid, aal)


def factors(uid):
    return run_sql(f"select coalesce(json_agg(f), '[]') from (select id, status, 'totp' as factor_type from auth.mfa_factors where user_id = {lit(uid)}) f")


def handle(b):
    tok = b.get('token') or ''
    uid, _, aal = tok.partition('|')
    k = b['kind']
    if k == 'signup':
        if b['email'] in USERS:
            raise RuntimeError('User already registered')
        uid = str(uuid.uuid4()); USERS[b['email']] = {'id': uid, 'password': b['password']}
        run_sql(f"insert into auth.users (id, email) values ({lit(uid)}, {lit(b['email'])})")
        return {'session': {'access_token': f'{uid}|aal1', 'user': {'id': uid, 'email': b['email']}}, 'user': {'id': uid, 'email': b['email']}}
    if k == 'login':
        u = USERS.get(b['email'])
        if not u or u['password'] != b['password']:
            raise RuntimeError('Invalid login credentials')
        return {'session': {'access_token': f"{u['id']}|aal1", 'user': {'id': u['id'], 'email': b['email']}}, 'user': {'id': u['id'], 'email': b['email']}}
    if k == 'factors':
        return factors(uid)
    if k == 'enroll':
        fid = str(uuid.uuid4())
        run_sql(f"insert into auth.mfa_factors (id, user_id, status) values ({lit(fid)}, {lit(uid)}, 'unverified')")
        svg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><rect width='10' height='10' fill='black'/></svg>"
        return {'id': fid, 'type': 'totp', 'totp': {'qr_code': svg, 'secret': 'JBSWY3DPEHPK3PXP', 'uri': ''}}
    if k == 'verify':
        if b['code'] != '123456':
            raise RuntimeError('Invalid TOTP code entered')
        run_sql(f"update auth.mfa_factors set status = 'verified' where id = {lit(b['factorId'])}")
        return {'access_token': f'{uid}|aal2'}
    if k == 'unenroll':
        run_sql(f"delete from auth.mfa_factors where id = {lit(b['factorId'])}")
        return {}
    if k == 'table':
        return table_query(b, uid, aal or 'aal1')
    if k == 'rpc':
        return rpc(b, uid, aal or 'aal1')
    if k == 'upload':
        run_sql(f"insert into storage.objects (bucket_id, name) values ({lit(b['bucket'])}, {lit(b['path'])})", uid, aal or 'aal1')
        return {'path': b['path']}
    raise ValueError('kind')


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def log_message(self, *a):
        pass

    def do_POST(self):
        b = json.loads(self.rfile.read(int(self.headers['content-length'])))
        try:
            res = {'data': handle(b), 'error': None}
        except Exception as e:  # noqa
            res = {'data': None, 'error': {'message': str(e)}}
        out = json.dumps(res).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else 8765), H).serve_forever()

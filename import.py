#!/usr/bin/env python3
"""Import Proppy exports into irg_crm.db. Usage: import.py <contacts.csv> <props.json> <photos.json> <owner_links.csv> <option_dict.txt> <out.db>"""
import sys, re, json, csv, html, sqlite3, os, collections
sys.path.insert(0, os.path.dirname(__file__))
from parse_contacts import parse, COLS as COLS_
from feature_en import EN

contacts_csv, props_json, photos_json, links_csv, optdict, out = sys.argv[1:7]
if os.path.exists(out): os.remove(out)
db = sqlite3.connect(out)
db.executescript(open(os.path.join(os.path.dirname(__file__), 'schema.sql')).read())
log = lambda lvl, ent, ref, msg: db.execute('INSERT INTO import_log(level,entity,ref,message) VALUES(?,?,?,?)', (lvl, ent, str(ref), msg))

def iso(s):
    m = re.match(r'(\d{2})/(\d{2})/(\d{4})(?:\s+(\d{2}):(\d{2}))?', (s or '').strip())
    if not m: return None
    d, mo, y, h, mi = m.groups()
    return f'{y}-{mo}-{d}' + (f'T{h}:{mi}' if h else '')

def num(s):
    s = (s or '').strip().replace('\xa0', '').replace(' ', '')
    if not s or s == '-': return None
    if ',' in s and '.' in s: s = s.replace('.', '').replace(',', '.')
    else: s = s.replace(',', '.')
    try: return float(s)
    except ValueError: return None

def lab(s):  # 'Venda [2]' -> 'Venda'
    return re.sub(r'\s*\[[^\]]*\]\s*$', '', s or '').strip() or None

# ---------- users ----------
users = {}
def user(name):
    name = (name or '').strip()
    if not name or name == '-': return None
    if name not in users:
        users[name] = db.execute('INSERT INTO users(name) VALUES(?)', (name,)).lastrowid
    return users[name]

# ---------- phones ----------
def norm_phone(raw, country=''):
    raw = (raw or '').strip()
    if not raw or raw == '-' or '*' in raw or 'x' in raw.lower().replace('ext', ''): return None, 'masked'
    d = re.sub(r'[^\d+]', '', raw)
    if d.startswith('+00'): d = '+' + d[3:]
    elif d.startswith('00'): d = '+' + d[2:]
    if d.startswith('+'):
        ok = 8 <= len(d) - 1 <= 15
        return (d if ok else None), (None if ok else 'bad')
    cc = CC.get(country)
    if cc:
        dd = d[1:] if d.startswith('0') else d
        if dd.startswith(cc) and len(dd) >= 11: return '+' + dd, 'assumed_country'
        if 7 <= len(dd) <= 11: return '+' + cc + dd, 'assumed_country'
        return None, 'bad'
    return (d, 'no_country') if 9 <= len(d) <= 15 else (None, 'bad')

CC = {'United Kingdom': '44', 'Portugal': '351', 'France': '33', 'Germany': '49', 'Netherlands': '31', 'Canada': '1', 'Switzerland': '41',
      'Spain': '34', 'Italy': '39', 'Ireland': '353', 'Sweden': '46', 'Belgium': '32', 'Denmark': '45', 'Norway': '47', 'Brazil': '55'}

EMAIL = re.compile(r'[\w.+\-\']+@[\w\-]+(?:\.[\w\-]+)+')

def clean_notes(h):
    t = re.sub(r'<\s*br\s*/?>|</p>|</div>|</li>|</tr>', '\n', h or '', flags=re.I)
    t = re.sub(r'<style.*?</style>', '', t, flags=re.S | re.I)
    t = html.unescape(re.sub(r'<[^>]+>', '', t)).replace('\xa0', ' ')
    t = re.sub(r'[ \t]+', ' ', t)
    t = re.sub(r'\n\s*\n+', '\n\n', t).strip()
    return t

ORIGIN_MAP = {'-': None, '': None, 'Green Acres': 'Greenacres', 'GreenAcres': 'Greenacres'}

# ---------- contacts ----------
rows, loose, bad = parse(contacts_csv)
log('info', 'contacts', '', f'parsed {len(rows)} rows, {len(loose)} recovered loosely, {len(bad)} unparsed')
# re-attempt unparsed rows: two emails inside one quoted cell
for b in bad:
    m = re.match(r'^(\d+),((?:[^,"]|"[^"]*")*)$', b.split('\n')[0]) 
    first = next(csv.reader([b.split('\n')[0] + ('"' if b.split('\n')[0].count('"') % 2 else '')]))
    if len(first) >= 11 and first[0].isdigit():
        rows.append(dict(zip(COLS_, first[:11] + [''])) | {'Notes': b.split('\n', 1)[1] if '\n' in b else ','.join(first[11:])})
        log('info', 'contacts', first[0], 'recovered from unparsed row')
    else:
        log('warn', 'contacts', b[:10], 'row could not be parsed: ' + b[:120].replace('\n', ' '))

seen_email = collections.defaultdict(list)
for r in rows:
    cid = int(r['EntityID'])
    flags = []
    country = r['Country'].strip() or None
    origin = r['Origin'].strip()
    origin = ORIGIN_MAP.get(origin, origin)
    emails = list(dict.fromkeys(e.lower() for e in EMAIL.findall(r['Email'])))
    if len(emails) > 1: flags.append('multi_email')
    if not emails: flags.append('no_email')
    year = (iso(r['CreateTime']) or '')[:4]
    reliable = 0 if year == '2018' else 1
    db.execute('INSERT INTO contacts(id,name,country,origin,assigned_user_id,active,created_at,created_reliable,last_event,proppy_notes_raw) VALUES(?,?,?,?,?,?,?,?,?,?)',
               (cid, r['Name'].strip() or None, country, origin, user(r['User']), 1 if r['Active'] == 'Yes' else 0,
                iso(r['CreateTime']), reliable, iso(r['LastEvent']), r['Notes'] or None))
    for i, e in enumerate(emails):
        db.execute('INSERT INTO contact_emails(contact_id,email,is_primary) VALUES(?,?,?)', (cid, e, 1 if i == 0 else 0))
        seen_email[e].append(cid)
    first = True
    for kind, raw in (('mobile', r['Cellphone']), ('phone', r['Phone'])):
        p, note = norm_phone(raw, country or '')
        if note == 'masked':
            if raw.strip() not in ('', '-'): flags.append('masked_phone')
            continue
        if p is None:
            flags.append('bad_phone'); p = raw.strip()[:60]; note = None; kind = 'unparsed'
        if note: flags.append('phone_' + note)
        if db.execute('SELECT 1 FROM contact_phones WHERE contact_id=? AND phone=?', (cid, p)).fetchone(): continue
        db.execute('INSERT INTO contact_phones(contact_id,phone,phone_raw,kind,is_primary) VALUES(?,?,?,?,?)', (cid, p, raw.strip(), kind, 1 if first else 0))
        first = False
    txt = clean_notes(r['Notes'])
    if txt:
        db.execute('INSERT INTO notes(contact_id,body,created_at) VALUES(?,?,?)', (cid, txt, iso(r['CreateTime'])))
    if flags:
        db.execute('UPDATE contacts SET import_flags=? WHERE id=?', (','.join(sorted(set(flags))), cid))
for e, ids in seen_email.items():
    if len(ids) > 1:
        for i in ids:
            f = db.execute('SELECT import_flags FROM contacts WHERE id=?', (i,)).fetchone()[0]
            db.execute('UPDATE contacts SET import_flags=? WHERE id=?', ((f + ',' if f else '') + 'dup_email', i))
        log('info', 'contacts', ','.join(map(str, ids)), 'shared email ' + e)

# origins into lookups
for o, in db.execute('SELECT DISTINCT origin FROM contacts WHERE origin IS NOT NULL ORDER BY 1').fetchall():
    db.execute('INSERT INTO lookups(kind,code,label) VALUES("origin",?,?)', (o, o))

# ---------- feature dictionary ----------
fd = {}
for line in open(optdict, encoding='utf-8'):
    line = line.strip()
    if not line: continue
    k, l = line.split('|', 1)
    kind, i = k.split('-')
    fd[int(i)] = (kind, l)
fd[313] = ('select', 'Certificado energético')
VIEW = {136, 137, 138, 139, 241, 242, 401, 421, 422, 423, 430, 568, 569}
ORI = {440, 441, 442, 443}
PROX = {3, 4, 5, 9, 75, 217, 218, 219, 609, 597, 598, 599, 600, 601}
for i, (kind, l) in fd.items():
    grp = 'view' if i in VIEW else 'orientation' if i in ORI else 'proximity' if i in PROX else 'general'
    db.execute('INSERT INTO feature_defs(id,kind,label_pt,label_en,grp) VALUES(?,?,?,?,?)', (i, kind, l, EN.get(l), grp))
ENERGY = {'431': 'A+', '432': 'A', '433': 'B', '434': 'B-', '435': 'C', '436': 'D', '437': 'E', '438': 'F', '439': 'G', '564': 'Isento', '565': 'Em curso'}
for c, l in ENERGY.items(): db.execute('INSERT INTO lookups(kind,code,label,sort) VALUES("energy_rating",?,?,?)', (c, l, int(c)))

# ---------- properties ----------
props = json.load(open(props_json, encoding='utf-8'))
photos = json.load(open(photos_json))
STATUS = {'Ativa': 'active', 'Inativa': 'inactive', 'Pendente': 'pending'}
lookup_vals = collections.defaultdict(set)
unknown_opts = set()
for r in props:
    d = r['detail']; pid = int(r['pid'])
    g = lambda k: (d.get(k) or '').strip() if isinstance(d.get(k), str) else d.get(k)
    on = lambda k: 1 if d.get(k) == 'on' else 0
    st = STATUS.get(lab(g('__propertystatus')[1] if isinstance(d.get('__propertystatus'), list) else r['active']) if False else r['active'], r['active'])
    ptype, typo, cond, biz = lab(g('__propertytype')), lab(g('__propertytypology')), lab(g('__propertycondition')), lab(g('__propertybusinesstype'))
    for k, v in (('property_type', ptype), ('typology', typo), ('condition', cond), ('business_type', biz), ('status_reason', r.get('reason') or None)):
        if v: lookup_vals[k].add(v)
    en = None
    sel = d.get('property-option-select--313')
    if sel:
        m = re.search(r'\[(\d+)\]', sel); en = ENERGY.get(m.group(1)) if m else None
    num_opt = lambda i: num(d.get(f'property-option-text--{i}'))
    broker = user(re.sub(r'<[^>]+>', '', r.get('broker') or '').strip())
    db.execute('''INSERT INTO properties(id,reference,status,status_reason,sold,visible_on_website,block_export,exclusive,pre_off_market,
        business_type,property_type,typology,condition,price,price_to,price_prefix,price_visible,bedrooms,bathrooms,area_house,area_land,area_gross,
        country,city,locality,zone,zipcode,address,latitude,longitude,year_built,year_renovated,floors,imi_value,condo_fee,energy_rating,
        energy_cert_number,habitation_licence,registry_number,contract_number,contract_start,contract_end,commission,internal_name,key_notes,internal_notes,
        broker_user_id,created_at,published_at,raw_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
        (pid, str(r['ref']) if r.get('ref') not in (None, '') else None, st, r.get('reason') or None, on('__propertysold'), on('__propertyvisibleonwebsite'),
         on('__propertyblockexport'), on('__propertyexclusive'), on('__propertypreoffmarket'),
         biz, ptype, typo, cond, num(r['price']) if isinstance(r['price'], str) else r['price'], num(g('__propertypriceto')), 'EUR', on('__propertypricevisible'),
         int(num(g('__propertybedrooms')) or 0) if num(g('__propertybedrooms')) is not None else None,
         int(num(g('__propertybathrooms')) or 0) if num(g('__propertybathrooms')) is not None else None,
         num(g('__propertyhousearea')), num(g('__propertylandarea')), num(g('__propertygrossarea')),
         'Portugal', r.get('city') or None, r.get('loc') or None, g('__propertyzone') or r.get('zone') or None, g('__propertyzipcode') or None, g('__propertyaddress') or None,
         num(g('__modalpropertylocationlatitude')), num(g('__modalpropertylocationlongitude')),
         int(num_opt(14)) if num_opt(14) else None, int(num_opt(577)) if num_opt(577) else None, int(num_opt(17)) if num_opt(17) else None,
         num_opt(176), num_opt(108), en,
         g('__propertyenergeticcontractnumber') or None, g('__propertyhabitationlicencenumber') or None, g('__propertyregisternumber') or None,
         g('__propertycontractnumber') or None, iso(g('__propertycontractnumber--start')), iso(g('__propertycontractnumber--end')),
         g('__propertycomissionpercentage') or None, g('__propertyinternal') or None, g('__propertykeynotes') or None, clean_notes(g('__propertynotes')) or None,
         broker, iso(r.get('created')), iso(r.get('published')), json.dumps(d, ensure_ascii=False)))
    # texts
    langs = collections.defaultdict(dict)
    for k, v in d.items():
        m = re.match(r'__property--(title|meta|shortdescription|fulldescription|htmldescription|printdescription|keywords)--([a-z]{2,3})$', k)
        if m and isinstance(v, str) and v.strip(): langs[m.group(2)][m.group(1)] = v
    for lg, t in langs.items():
        db.execute('INSERT INTO property_texts VALUES(?,?,?,?,?,?,?,?,?)', (pid, lg, t.get('title'), t.get('meta'), t.get('shortdescription'), t.get('fulldescription'), t.get('htmldescription'), t.get('printdescription'), t.get('keywords')))
    # features
    for k, v in d.items():
        m = re.match(r'property-option-(bit|text)--(\d+)$', k)
        if m and v not in (None, '', 'off'):
            i = int(m.group(2))
            if i not in fd: unknown_opts.add(i); continue
            db.execute('INSERT OR IGNORE INTO property_features VALUES(?,?,?)', (pid, i, None if m.group(1) == 'bit' else v))
    for item in d.get('__features') or []:
        i = int(item.split(':')[0])
        if i not in fd: unknown_opts.add(i); continue
        db.execute('INSERT OR IGNORE INTO property_features VALUES(?,?,NULL)', (pid, i))
    # photos
    for pos, (phid, url, vis) in enumerate(photos.get(str(pid), []), 1):
        db.execute('INSERT OR REPLACE INTO photos(id,property_id,position,visible,source_url) VALUES(?,?,?,?,?)', (int(phid), pid, pos, vis, url))

for k, vs in lookup_vals.items():
    for v in sorted(vs): db.execute('INSERT INTO lookups(kind,code,label) VALUES(?,?,?)', (k, v, v))
if unknown_opts: log('warn', 'properties', '', f'unknown option ids: {sorted(unknown_opts)}')

# ---------- owners ----------
missing_owner = set(); multi = 0; n_links = 0
for r in props:
    for cid, name in re.findall(r'(?:^|\|,?\s*)(\d+):([^|]*)', r.get('owner') or ''):
        cid = int(cid)
        db.execute('INSERT OR IGNORE INTO property_owners VALUES(?,?,?)', (int(r['pid']), cid, name.strip()))
        n_links += 1
        if db.execute('SELECT 1 FROM contacts WHERE id=?', (cid,)).fetchone() is None: missing_owner.add(cid)
        else: db.execute('UPDATE contacts SET is_seller=1 WHERE id=?', (cid,))
for cid in sorted(missing_owner): log('warn', 'owners', cid, 'owner contact id not in contacts export')
# cross-check with owner-links csv
chk = 0
for row in csv.DictReader(open(links_csv, encoding='utf-8')):
    ids = {int(x) for x in row['OwnerEntityIDs'].split('+') if x}
    have = {c for c, in db.execute('SELECT contact_id FROM property_owners WHERE property_id=?', (int(row['PropertyID']),))}
    if ids != have: chk += 1; log('warn', 'owners', row['PropertyID'], f'csv owners {sorted(ids)} vs json {sorted(have)}')
log('info', 'owners', '', f'{n_links} links; {len(missing_owner)} owner ids missing from contacts; {chk} mismatches vs owner csv')

db.commit()
q = lambda s: db.execute(s).fetchone()[0]
rep = f'''IMPORT REPORT
contacts: {q('select count(*) from contacts')}  (with email {q('select count(distinct contact_id) from contact_emails')}, with phone {q('select count(distinct contact_id) from contact_phones')}, sellers {q('select count(*) from contacts where is_seller=1')})
emails: {q('select count(*) from contact_emails')}  phones: {q('select count(*) from contact_phones')}  notes: {q('select count(*) from notes')}
flags: ''' + str(dict(collections.Counter(f for fl, in db.execute('select import_flags from contacts where import_flags is not null') for f in fl.split(',')))) + f'''
properties: {q('select count(*) from properties')} (active {q("select count(*) from properties where status='active'")}, inactive {q("select count(*) from properties where status='inactive'")}, pending {q("select count(*) from properties where status='pending'")}, sold {q('select count(*) from properties where sold=1')}, online {q('select count(*) from properties where visible_on_website=1')})
texts: {q('select count(*) from property_texts')} in {q('select count(distinct lang) from property_texts')} languages; features: {q('select count(*) from property_features')}; photos: {q('select count(*) from photos')} on {q('select count(distinct property_id) from photos')} properties
with GPS: {q('select count(*) from properties where latitude is not null')}; with energy rating: {q('select count(*) from properties where energy_rating is not null')}
owner links: {q('select count(*) from property_owners')}; properties without owner: {q('select count(*) from properties where id not in (select property_id from property_owners)')}
log warnings: {q("select count(*) from import_log where level='warn'")}
'''
print(rep)
open(os.path.join(os.path.dirname(out) or '.', 'import_report.txt'), 'w').write(rep)

#!/usr/bin/env python3
"""Turn irg_crm.db into chunked SQL files for `wrangler d1 execute --remote --file`.
Usage: python tools/make_sql.py path/to/irg_crm.db out_dir"""
import sqlite3, sys, os
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
db = sqlite3.connect(src)
ORDER = ['users','lookups','feature_defs','contacts','contact_emails','contact_phones','notes','searches','events','properties',
         'property_texts','property_features','photos','property_owners','import_log']
LIMIT = 700_000   # bytes per file
n, buf, size = 0, [], 0
def flush():
    global n, buf, size
    if buf:
        n += 1; open(f'{out}/{n:03d}.sql', 'w', encoding='utf-8').write('\n'.join(buf) + '\n'); buf, size = [], 0
for t in ORDER:
    cols = [r[1] for r in db.execute(f'pragma table_info({t})')]
    q = ','.join("'NULL'" if c in ('proppy_notes_raw', 'raw_json') else f'quote("{c}")' for c in cols)
    for row in db.execute(f'select {q} from {t}'):
        s = f'INSERT INTO {t}({",".join(cols)}) VALUES({",".join(row)});'
        if len(s) > 95_000:   # D1 statement limit ~100KB: blank the bulky print/html copies of descriptions
            r = list(row)
            for i, c in enumerate(cols):
                if c in ('html_description', 'print_description', 'full_description') and len(r[i]) > 20_000: r[i] = "'NULL'" if False else 'NULL'
            s = f'INSERT INTO {t}({",".join(cols)}) VALUES({",".join(r)});'
            if len(s) > 95_000: print('STILL TOO LONG', t, row[0], len(s))
        buf.append(s); size += len(s)
        if size > LIMIT: flush()
    flush()
print(n, 'files in', out)

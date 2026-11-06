"""Parse the Proppy 'whole database' contact export (multi-line notes, some broken quotes)."""
import csv, io, re, sys
START = re.compile(r'^\d{4,7},')
COLS = ['EntityID','Name','Email','Cellphone','Country','Active','Origin','User','CreateTime','Phone','LastEvent','Notes']
LOOSE = re.compile(r'^(\d+),([^,]*),([^,]*),([^,]*),([^,]*),(Yes|No),([^,]*),([^,]*),(\d{2}/\d{2}/\d{4}),([^,]*),([^,]*),(.*)$', re.S)

def split_records(text):
    recs, cur = [], None
    for line in text.splitlines(keepends=True):
        if START.match(line) and (cur is None or cur.count('"') % 2 == 0):
            if cur is not None: recs.append(cur)
            cur = line
        else:
            cur = (cur or '') + line
    if cur: recs.append(cur)
    return recs

def parse(path):
    text = open(path, encoding='utf-8-sig', errors='replace').read()
    header, _, body = text.partition('\n')
    rows, loose, bad = [], [], []
    for rec in split_records(body):
        try:
            r = next(csv.reader(io.StringIO(rec.rstrip('\r\n'))))
            if len(r) == 12:
                rows.append(dict(zip(COLS, r))); continue
        except Exception: pass
        m = LOOSE.match(rec.rstrip('\r\n'))
        if m:
            d = dict(zip(COLS, m.groups())); loose.append(d['EntityID']); rows.append(d)
        else:
            bad.append(rec[:200])
    return rows, loose, bad

if __name__ == '__main__':
    rows, loose, bad = parse(sys.argv[1])
    print(len(rows), 'rows;', len(loose), 'recovered loosely;', len(bad), 'unparsed')
    for b in bad: print('BAD:', b.replace('\n', ' ')[:160])

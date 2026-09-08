#!/usr/bin/env python3
"""Merge pull buffers into pops.json / cl-extra.json and rebuild dependents.
Usage: python3 tools/apply_pulls.py [--pops /tmp/pops_buf.json] [--cl /tmp/cl_buf.json] [--requeue-js /tmp/popall_bN.js]
Always rebuilds lowpop.json and watchlist-stats.json from current data."""
import json, re, sys, argparse
from datetime import datetime, timedelta

ap = argparse.ArgumentParser()
ap.add_argument('--pops'); ap.add_argument('--cl'); ap.add_argument('--requeue-js')
a = ap.parse_args()

PREF = ['holofoil','unlimitedHolofoil','1stEditionHolofoil','reverseHolofoil','unlimited','1stEdition','normal']
def market_of(c):
    p = c.get('p') or {}
    for k in PREF:
        if k in p and p[k].get('market') is not None: return p[k]['market']
    for v in p.values():
        if v.get('market') is not None: return v['market']
    return None

doc = json.load(open('pops.json')); pops = doc['cards']
if a.pops:
    buf = json.load(open(a.pops)); added = 0
    for k, v in buf.items():
        if k not in pops: pops[k] = v; added += 1
    json.dump(doc, open('pops.json','w'))
    print('pops.json ->', len(pops), '(+%d)' % added)

if a.requeue_js:
    s = open(a.requeue_js).read()
    i0 = s.index('const QS = ')+11; i1 = s.index(';', i0)
    qs = json.loads(s[i0:i1])
    missed = [c for c in qs if c['cid'] not in pops]
    try: rest = json.load(open('/tmp/popall_queue_rest.json'))
    except FileNotFoundError: rest = []
    rest = [c for c in rest if c['cid'] not in pops]
    seen = set()
    out = []
    for c in missed + rest:
        if c['cid'] not in seen: seen.add(c['cid']); out.append(c)
    json.dump(out, open('/tmp/popall_queue_rest.json','w'))
    print('requeued', len(missed), '| queue remaining:', len(out))

# lowpop.json
sets = json.load(open('catalog/sets.json'))
rows = []
for s in sets:
    try: cards = json.load(open('catalog/%s.json' % s['id']))
    except FileNotFoundError: continue
    for c in cards:
        pv = pops.get(c['id'])
        if not pv or pv.get('p') is None or pv['p'] >= 80: continue
        rows.append({'cid': c['id'], 'setId': s['id'], 'n': c['n'], 'num': c['num'], 'r': c['r'],
                     'img': c.get('img'), 'price': market_of(c), 'pop': pv['p'], 'total': pv.get('t')})
rows.sort(key=lambda r: (r['pop'], -(r['price'] or 0)))
json.dump({'rows': rows, 'sets': sets}, open('lowpop.json','w'))
print('lowpop:', len(rows), 'rows,', sum(1 for r in rows if r['price']), 'priced,', len(set(r['setId'] for r in rows)), 'sets')

# cl-extra merge
EXCL = re.compile(r'1st edition|1st ed', re.I)
cut90 = datetime.now() - timedelta(days=90)
def pdte(s):
    for f in ('%Y-%m-%d', '%b %d, %Y'):
        try: return datetime.strptime(s, f)
        except: pass
    return None
def filt(rows, num, grade):
    g = re.compile(r'\bPSA\s*%d\b(?!\d)' % grade, re.I)
    return [r for r in rows if not EXCL.search(r.get('t','')) and g.search(r.get('t',''))
            and (not num or ('#'+str(num)) in r['t'] or (str(num)+'/') in r['t'])]
def med(rows):
    rr = [r for r in rows if pdte(r['d']) and pdte(r['d']) >= cut90]
    if not rr: return None, 0
    ps = sorted(r['p'] for r in rr); return ps[len(ps)//2], len(rr)
try: extra = json.load(open('cl-extra.json'))
except FileNotFoundError: extra = {}
if a.cl:
    clb = json.load(open(a.cl)); n = 0
    for k, v in clb.items():
        num = re.sub(r'.*-','',k.replace('cid:','')) if k.startswith('cid:') else None
        r10 = filt(v.get('r10',[]), num, 10); r9 = filt(v.get('r9',[]), num, 9)
        v['r10'], v['r9'] = r10[:8], r9[:8]
        v['med10'], v['n10'] = med(r10); v['med9'], v['n9'] = med(r9)
        extra[k] = v; n += 1
    json.dump(extra, open('cl-extra.json','w'))
    print('cl-extra.json ->', len(extra), '(+%d)' % n)

# watchlist-stats.json
html = open('index.html').read()
cards = json.loads(re.search(r'const CARDS = (\[.*?\]);\n', html, re.S).group(1))
cl_seed = json.loads(re.search(r'const CL_SALES = (\{.*?\});\n', html, re.S).group(1))
setcache = {}
def set_cards(sid):
    if sid not in setcache:
        try: setcache[sid] = json.load(open('catalog/%s.json' % sid))
        except: setcache[sid] = []
    return setcache[sid]
def norm(s): return re.sub(r'[^a-z0-9]', '', (s or '').lower())
def map_catalog(c):
    m = re.search(r'#(\d+[a-zA-Z]*)', c['name'])
    num = m.group(1) if m else None
    target = norm(re.sub(r'\s*#.*', '', c['set']))
    for s in sets:
        if norm(s['n']) == target or target in norm(s['n']) or (len(norm(s['n'])) > 4 and norm(s['n']) in target):
            for cc in set_cards(s['id']):
                if num and str(cc['num']) == str(num) and norm(c['name'].split('#')[0].split('★')[0].split('☆')[0].strip()) in norm(cc['n']):
                    return cc
    return None
def grade_block(rows):
    out = {}
    dated = [(pdte(r['d']), r) for r in rows]; dated = [(d, r) for d, r in dated if d]
    m, n = med(rows)
    if m is not None: out['med90'] = m; out['n90'] = n
    if dated:
        d, r = max(dated, key=lambda x: x[0])
        out['last'] = {'d': r['d'], 'p': r['p'], 'pf': (r.get('pf') or '').split(' - ')[0]}
    return out, rows
stats = {}
for c in cards:
    cid = str(c['id']); cc = map_catalog(c)
    num = cc['num'] if cc else (re.search(r'#(\d+[a-zA-Z]*)', c['name']) or [0, None])[1]
    s10 = list(cl_seed.get(cid, {}).get('r10', [])); s9 = list(cl_seed.get(cid, {}).get('r9', []))
    if cc:
        ex = extra.get('cid:' + cc['id'], {})
        s10 += ex.get('r10', []); s9 += ex.get('r9', [])
    b10, ok10 = grade_block(filt(s10, num, 10)); b9, ok9 = grade_block(filt(s9, num, 9))
    tcg = market_of(cc) if cc else None
    r90 = sorted((pdte(r['d']), r['p']) for r in ok10 if pdte(r['d']) and pdte(r['d']) >= cut90)
    stats[cid] = {'psa10': b10, 'psa9': b9,
        'raw': ({'tcg': tcg} if tcg else {}), 'cid': cc['id'] if cc else None,
        'sources': (['Card Ladder'] if (ok10 or ok9) else []) + (['TCGplayer'] if tcg else []),
        'trend90d': (round((r90[-1][1]-r90[0][1])/r90[0][1]*100) if len(r90) >= 2 and r90[0][1] else None)}
json.dump(stats, open('watchlist-stats.json','w'))
print('watchlist-stats:', len(stats), 'cards | PSA10 data:', sum(1 for e in stats.values() if e['psa10']),
      '| raw:', sum(1 for e in stats.values() if e['raw']))

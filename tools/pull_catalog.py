#!/usr/bin/env python3
"""Re-pull the full Pokemon TCG catalog into catalog/ (per-set JSON + index + sets)."""
import json, os, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

UA = {'User-Agent': 'PokeGrade/1.0'}
SEL = 'id,name,supertype,subtypes,number,rarity,images,tcgplayer'
HERE = os.path.dirname(os.path.abspath(__file__))
CAT = os.path.join(HERE, '..', 'catalog')

def get(url, retries=6):
    for a in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.load(r)
        except Exception:
            time.sleep(3 + a * 3)
    raise RuntimeError('failed: ' + url)

def pull_set(s):
    sid = s['id']
    url = f"https://api.pokemontcg.io/v2/cards?q=set.id:{sid}&select={SEL}&pageSize=250&orderBy=id"
    data = get(url)
    cards = data['data']
    while len(cards) < data['totalCount']:
        page = len(cards) // 250 + 1
        cards += get(url + f'&page={page}')['data']
    out = []
    for c in cards:
        tp = (c.get('tcgplayer') or {}).get('prices') or {}
        prices = {k: {m: v.get(m) for m in ('low','mid','high','market') if v.get(m) is not None} for k, v in tp.items()}
        out.append({'id': c['id'], 'n': c['name'], 'num': c.get('number',''), 'r': c.get('rarity',''),
                    'st': c.get('supertype',''), 'sub': c.get('subtypes') or [],
                    'img': (c.get('images') or {}).get('small',''), 'p': prices})
    out.sort(key=lambda c: (c['num'].zfill(4) if c['num'].isdigit() else c['num']))
    return sid, out

def main():
    sets = get('https://api.pokemontcg.io/v2/sets?select=id,name,series,total,releaseDate&orderBy=-releaseDate')['data']
    results = {}
    with ThreadPoolExecutor(max_workers=4) as ex:
        for sid, out in ex.map(pull_set, sets):
            results[sid] = out
    idx = []
    os.makedirs(CAT, exist_ok=True)
    for s in sets:
        out = results.get(s['id'], [])
        if out:
            json.dump(out, open(os.path.join(CAT, s['id'] + '.json'), 'w'), separators=(',', ':'))
            for c in out:
                idx.append([c['n'], s['id'], c['num'], c['id']])
    json.dump(idx, open(os.path.join(CAT, 'index.json'), 'w'), separators=(',', ':'))
    meta = [{'id': s['id'], 'n': s['name'], 's': s['series'], 't': s['total'], 'd': s['releaseDate']} for s in sets]
    json.dump(meta, open(os.path.join(CAT, 'sets.json'), 'w'), separators=(',', ':'))
    print(f"{sum(len(v) for v in results.values())} cards across {len(results)} sets")

if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""주식·달러 칸의 「중립」 경계를 한 번 계산해 rules/topdown-v1.json 에 적는다(규칙 고정 전 한 번만).

경계 = 그날 FRED 가 내주는 시리즈 전체 기간의 「20관측 변화율(%)」 33.3·66.7 백분위(선형 보간), 0.1%p 반올림.
이미 경계가 있으면 바꾸지 않고 멈춘다 — 바꾸려면 규칙 판을 올린다.

    FRED_API_KEY=... python3 scripts/topdown_bands.py --root .
"""
import argparse
import datetime as dt
import json
import os
import sys
from decimal import Decimal, ROUND_HALF_UP

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from topdown_data import fred_obs  # noqa: E402

SERIES = {'equities': 'SP500', 'dollar': 'DTWEXBGS'}


def pct(xs, q):
    xs = sorted(xs)
    pos = (len(xs) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)


def band(values):
    ch = [(values[i + 20] / values[i] - 1) * 100 for i in range(len(values) - 20)]
    r = lambda x: float(Decimal(str(x)).quantize(Decimal('0.1'), rounding=ROUND_HALF_UP))  # noqa: E731
    return r(pct(ch, 1 / 3)), r(pct(ch, 2 / 3)), len(ch)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default='.')
    a = ap.parse_args()
    path = os.path.join(a.root, 'rules', 'topdown-v1.json')
    rules = json.load(open(path, encoding='utf-8'))
    today = dt.date.today().isoformat()
    for cell, sid in SERIES.items():
        if rules['cells'][cell]['band'] is not None:
            raise SystemExit(f'{cell} 경계가 이미 있다 — 바꾸지 않는다')
        obs = fred_obs(sid)
        vals = [float(o['value']) for o in obs]
        lo, hi, n = band(vals)
        rules['cells'][cell]['band'] = {'lo_pct': lo, 'hi_pct': hi, 'series': sid, 'computed_on': today,
                                        'sample': {'start': obs[0]['date'], 'end': obs[-1]['date'], 'changes': n}}
        print(f'{cell} {sid}: 아래 {lo}% · 위 {hi}% ({obs[0]["date"]}–{obs[-1]["date"]}, 20관측 변화 {n}개)')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(rules, f, ensure_ascii=False, indent=2)
        f.write('\n')


if __name__ == '__main__':
    main()

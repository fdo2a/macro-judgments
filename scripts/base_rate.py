#!/usr/bin/env python3
"""기후값(과거 지속 비율) → rules/v1-base-rate.json. 규칙 v1 을 고정하기 전에 한 번만 돌린다.

같은 정의(scripts/rule.py)로 2000-01-01 부터 --end 전날까지의 실제 발표일(FRED release/dates, 데이터가 나온 날)을 센다.
금리는 재무부 일별 par yield 2 Yr. 2021-12-06 산출법 변경 전후 표본 수를 따로 적는다.
한 달에 발표일이 둘 이상 잡히면(계절 요인 수정 공표 등이 섞였을 수 있다) needs_review 로 표시한다 — 사람이 BLS 공지와 대조한 뒤
--drop 으로 뺄 날짜를 적고 다시 돌린다.

    FRED_API_KEY=... python3 scripts/base_rate.py --end 2026-12-01 --out rules/v1-base-rate.json [--drop 2020-02-11 ...]
"""
import argparse
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rule import outcome_after, series_from, signal_at  # noqa: E402

METHOD_CHANGE = '2021-12-06'


def compute(series, dates, start, end):
    """series: series_from 결과, dates: 발표일 목록 → 집계."""
    c = {'events': 0, 'series_missing': 0, 'no_signal': 0, 'pending': 0, 'undecidable': 0,
         'scoreable': 0, 'persist': 0, 'scoreable_before_method_change': 0, 'scoreable_after_method_change': 0}
    for t in dates:
        if not (start <= t < end):
            continue
        c['events'] += 1
        sig = signal_at(series, t)
        if sig['status'] != 'signal':
            c[sig['status']] += 1
            continue
        out = outcome_after(series, t, sig['d0'])
        c[out['status']] += 1
        if out['status'] == 'scoreable':
            c['persist'] += out['o']
            c['scoreable_before_method_change' if t < METHOD_CHANGE else 'scoreable_after_method_change'] += 1
    c['persist_share'] = round(c['persist'] / c['scoreable'], 4) if c['scoreable'] else None
    c['persist_pct'] = round(100 * c['persist'] / c['scoreable']) if c['scoreable'] else None
    return c


def multi_date_months(dates):
    seen = {}
    for d in dates:
        seen.setdefault(d[:7], []).append(d)
    return {m: ds for m, ds in seen.items() if len(ds) > 1}


def main():
    from fred import RELEASE_IDS, parse_treasury, release_dates, treasury_csv
    ap = argparse.ArgumentParser()
    ap.add_argument('--start', default='2000-01-01')
    ap.add_argument('--end', required=True, help='이 날짜 전까지만 센다(규칙 고정일)')
    ap.add_argument('--drop', nargs='*', default=[], help='BLS 공지와 대조해 발표일이 아니라고 확인한 날짜')
    ap.add_argument('--out', default='rules/v1-base-rate.json')
    a = ap.parse_args()
    end_year = int(a.end[:4])
    rows = []
    for y in range(int(a.start[:4]) - 1, end_year + 1):
        rows += parse_treasury(treasury_csv(y))
    series = series_from(rows)
    by_kind, review = {}, {}
    for kind in RELEASE_IDS:
        dates = [d for d in release_dates(kind, with_no_data=False) if d not in set(a.drop)]
        in_range = [d for d in dates if a.start <= d < a.end]
        by_kind[kind] = compute(series, dates, a.start, a.end)
        multi = multi_date_months(in_range)
        if multi:
            review[kind] = multi
    doc = {
        'rule': 'v1', 'start': a.start, 'end_exclusive': a.end,
        'series': 'U.S. Treasury Daily Par Yield Curve 2 Yr (home.treasury.gov 연도별 CSV)',
        'release_dates': 'FRED release/dates (include_release_dates_with_no_data=false)',
        'dropped_dates': a.drop,
        'method_change': f'{METHOD_CHANGE} 재무부 수익률곡선 산출법 변경 — 전후 표본 수를 함께 적는다',
        'by_kind': by_kind,
        'needs_review': review,
        'computed_at': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    }
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print(json.dumps({k: {x: v[x] for x in ('events', 'scoreable', 'persist_pct')} for k, v in by_kind.items()}, ensure_ascii=False))
    if review:
        print('확인 필요 — 한 달에 발표일이 둘 이상:', json.dumps(review, ensure_ascii=False))
        sys.exit(2)


if __name__ == '__main__':
    main()

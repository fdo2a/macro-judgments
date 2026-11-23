#!/usr/bin/env python3
"""앞으로의 발표 일정 → rules/schedule.json 에 덧붙이기(지우지 않는다).

FRED release/dates 의 예정일(데이터 없는 날 포함)로 오늘부터 --until 까지의 CPI·고용 날짜를 받아,
일정 파일에 없는 줄만 더한다. 날짜가 바뀐 줄은 이 스크립트가 고치지 않는다 — 사람이 옛 줄에 cancelled 사유를 붙이고
새 줄을 더한다(Worker 가 「보류: 발표 미확인」으로 알려 준다).

    FRED_API_KEY=... python3 scripts/build_schedule.py --until 2027-12-31
"""
import argparse
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def merge(existing, kind_dates):
    have = {(r['kind'], r['t']) for r in existing}
    added = []
    for kind, dates in kind_dates.items():
        for t in dates:
            if (kind, t) not in have:
                added.append({'kind': kind, 't': t, 'source': 'FRED release/dates 예정일'})
    rows = existing + added
    rows.sort(key=lambda r: (r['t'], r['kind']))
    return rows, added


def main():
    from fred import RELEASE_IDS, release_dates
    ap = argparse.ArgumentParser()
    ap.add_argument('--path', default='rules/schedule.json')
    ap.add_argument('--until', required=True)
    a = ap.parse_args()
    today = dt.date.today().isoformat()
    doc = json.load(open(a.path, encoding='utf-8')) if os.path.exists(a.path) else {'rows': []}
    kd = {k: [d for d in release_dates(k, with_no_data=True, realtime_start=today) if today <= d <= a.until] for k in RELEASE_IDS}
    doc['rows'], added = merge(doc['rows'], kd)
    doc['note'] = '줄을 지우지 않는다. 날짜가 바뀌면 옛 줄에 "cancelled": "사유" 를 붙이고 새 줄을 더한다.'
    with open(a.path, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print(f'{len(added)} rows added')
    for r in added:
        print(' ', r['kind'], r['t'])


if __name__ == '__main__':
    main()

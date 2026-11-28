#!/usr/bin/env python3
"""FRED 응답 꼴을 한 번 떠 본다(키는 출력하지 않는다). topdown_data.py 가 기대는 꼴이 맞는지 사람이 눈으로 본다.

    FRED_API_KEY=... python3 scripts/fred_probe.py
"""
import json
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fred import get  # noqa: E402

API = 'https://api.stlouisfed.org/fred/series/observations'


def show(label, **q):
    params = {'file_type': 'json', 'api_key': os.environ['FRED_API_KEY'], **q}
    body = json.loads(get(API + '?' + urllib.parse.urlencode(params)))
    obs = body.get('observations', [])
    head = {k: v for k, v in body.items() if k != 'observations'}
    print(f'== {label}')
    print('  top:', json.dumps(head, ensure_ascii=False))
    print('  n:', len(obs), ' 결측(숫자 아님):', sorted({o["value"] for o in obs if not o["value"].replace(".", "", 1).replace("-", "", 1).isdigit()}))
    for o in obs[:3] + (['…'] if len(obs) > 6 else []) + obs[-3:]:
        print('  ', o if o == '…' else json.dumps(o))


show('UNRATE 첫 발표', series_id='UNRATE', output_type=4, realtime_start='2026-01-01', realtime_end='9999-12-31', observation_start='2025-06-01')
show('CPILFESL 첫 발표', series_id='CPILFESL', output_type=4, realtime_start='2026-01-01', realtime_end='9999-12-31', observation_start='2025-06-01')
show('CPILFESL 2026-11-10 판', series_id='CPILFESL', realtime_start='2026-11-10', realtime_end='2026-11-10', observation_start='2026-06-01')
show('DFEDTARU', series_id='DFEDTARU', observation_start='2026-09-01')
show('SP500 최신 5', series_id='SP500', sort_order='desc', limit=5)
show('DTWEXBGS 최신 5', series_id='DTWEXBGS', sort_order='desc', limit=5)
show('UNRATE 최신 2', series_id='UNRATE', sort_order='desc', limit=2)

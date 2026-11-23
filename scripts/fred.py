"""FRED·재무부 가져오기 — base_rate.py·build_schedule.py 가 같이 쓴다. 키는 환경변수 FRED_API_KEY."""
import json
import os
import ssl
import urllib.parse
import urllib.request

RELEASE_IDS = {'cpi': 10, 'employment': 50}
UA = 'macro-judgments (research ledger)'


def _ctx():
    try:
        import certifi  # python.org 맥 Python 은 기본 인증서가 없다
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=120, context=_ctx()) as r:
        return r.read().decode('utf-8', 'replace')


def release_dates(kind, with_no_data, realtime_start=None):
    key = os.environ.get('FRED_API_KEY')
    if not key:
        raise SystemExit('FRED_API_KEY 가 없다')
    q = {'release_id': RELEASE_IDS[kind], 'include_release_dates_with_no_data': 'true' if with_no_data else 'false',
         'sort_order': 'asc', 'limit': 10000, 'file_type': 'json', 'api_key': key}
    if realtime_start:
        q['realtime_start'] = realtime_start
    body = json.loads(get('https://api.stlouisfed.org/fred/release/dates?' + urllib.parse.urlencode(q)))
    if not isinstance(body.get('release_dates'), list):
        raise SystemExit(f'FRED 응답 형식이 다르다: {list(body)[:5]}')
    return sorted({d['date'] for d in body['release_dates']})


def treasury_csv(year):
    return get(f'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/{year}/all?type=daily_treasury_yield_curve&field_tdr_date_value={year}&page&_format=csv')


def parse_treasury(text):
    lines = [l for l in text.splitlines() if l.strip()]
    head = [c.strip().strip('"') for c in lines[0].split(',')]
    if head[0] != 'Date' or '2 Yr' not in head:
        raise SystemExit('재무부 CSV 에 2 Yr 칸이 없다')
    i = head.index('2 Yr')
    rows = []
    for l in lines[1:]:
        c = [x.strip().strip('"') for x in l.split(',')]
        m, d, y = c[0].split('/')
        rows.append((f'{y}-{m}-{d}', c[i] if i < len(c) else ''))
    return rows

"""탑다운 확인 자료 — 재무부 10 Yr, FRED/ALFRED(UNRATE·CPILFESL 첫 발표와 발표 판, DFEDTARU, SP500, DTWEXBGS).
형식이 예상과 다르면 조용히 넘기지 않고 멈춘다(SystemExit). 키는 환경변수 FRED_API_KEY.

첫 발표값 = output_type=4(「Observations, Initial Release Only」, FRED series/observations 문서),
그 관측의 realtime_start = 처음 공개된 날. 실제 응답 꼴은 fred_probe.py 로 먼저 확인한다.
"""
import datetime as dt
import json
import os
import urllib.parse

from fred import get, parse_treasury, treasury_csv  # noqa: F401  (parse_treasury 는 2 Yr 용 — 10 Yr 는 아래)

API = 'https://api.stlouisfed.org/fred/series/observations'
SINCE = '2026-01-01'   # 이 원장의 첫 기록보다 넉넉히 앞


def fred_obs(series, **q):
    key = os.environ.get('FRED_API_KEY')
    if not key:
        raise SystemExit('FRED_API_KEY 가 없다')
    params = {'series_id': series, 'file_type': 'json', 'api_key': key, **q}
    body = json.loads(get(API + '?' + urllib.parse.urlencode(params)))
    obs = body.get('observations')
    if not isinstance(obs, list):
        raise SystemExit(f'FRED {series} 응답 형식이 다르다: {sorted(body)[:6]}')
    for o in obs:
        if not all(isinstance(o.get(k), str) for k in ('date', 'value', 'realtime_start')):
            raise SystemExit(f'FRED {series} 관측 형식이 다르다: {sorted(o)}')
    return [o for o in obs if _num(o['value'])]


def _num(s):
    try:
        float(s)
        return True
    except ValueError:
        return False


def treasury10(years):
    rows = []
    for y in years:
        lines = [l for l in treasury_csv(y).splitlines() if l.strip()]
        head = [c.strip().strip('"') for c in lines[0].split(',')]
        if head[0] != 'Date' or '10 Yr' not in head:
            raise SystemExit('재무부 CSV 에 10 Yr 칸이 없다')
        i = head.index('10 Yr')
        for l in lines[1:]:
            c = [x.strip().strip('"') for x in l.split(',')]
            m, d, yy = c[0].split('/')
            v = c[i] if i < len(c) else ''
            if v:
                rows.append((f'{yy}-{m}-{d}', v))
    return sorted(rows)


class Data:
    def __init__(self, root, now):
        years = range(2026, now.year + 1)
        self.treasury10 = treasury10(years)
        self.unrate_first = self.first('UNRATE')
        self.cpi_first = self.first('CPILFESL')
        self._vin = {}
        self.fed_upper = [(o['date'], o['value']) for o in fred_obs('DFEDTARU', observation_start=SINCE)]
        self.sp500 = [(o['date'], o['value']) for o in fred_obs('SP500', observation_start=SINCE)]
        self.dtwexbgs = [(o['date'], o['value']) for o in fred_obs('DTWEXBGS', observation_start=SINCE)]
        with open(os.path.join(root, 'rules', 'fomc-decisions.json'), encoding='utf-8') as f:
            self.fomc = [r['date'] for r in json.load(f)['decisions'] if not r.get('cancelled')]

    @staticmethod
    def first(series):
        obs = fred_obs(series, output_type=4, realtime_start=SINCE, realtime_end='9999-12-31', observation_start='2025-06-01')
        return sorted((o['date'], o['value'], o['realtime_start']) for o in obs)

    def cpi_vintage(self, release):
        if release not in self._vin:
            start = (dt.date.fromisoformat(release) - dt.timedelta(days=120)).isoformat()
            obs = fred_obs('CPILFESL', realtime_start=release, realtime_end=release, observation_start=start)
            self._vin[release] = {o['date']: o['value'] for o in obs}
        return self._vin[release]


def load_data(root, now):
    return Data(root, now)

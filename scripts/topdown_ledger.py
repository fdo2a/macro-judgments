#!/usr/bin/env python3
"""탑다운 일지(topdown-v1) — Worker 가 남긴 기록에서 판단·확인을 다시 계산한다. 순수 함수(자료는 data 객체로 받는다).

규칙은 rules/topdown-v1.json 그대로다. 같은 기록·같은 자료면 언제 돌려도 같은 답이 나와야 한다
(그래서 「며칠 지나면 확인 불가」 같은 실행 시각에 기대는 규칙은 없다).

- 하루 t 는 그날 question.json 의 q_at 부터 다음 하루 q_at 직전까지. 끝난 하루만 판단을 바꾼다.
- 칸마다 그날 마지막 글의 값·조건(그날 안에 승인된 것)이 열린 판단과 다르면 옛 판단은 「바뀜」, 새 판단은 그 글 시각·기준으로.
  단 옛 판단의 확인 시점이 그 글보다 앞이면 그대로 확인한다.
- 확인으로 닫힌 판단은 같은 값으로 「이어짐」(조건 없음, 기준 = 닫힌 시각에 공개돼 있던 가장 최근 관측).
"""
import datetime as dt
from decimal import Decimal, ROUND_HALF_UP

CELLS = ['growth', 'inflation', 'fomc', 'bonds', 'equities', 'dollar']
OUTCOME_WORDS = {
    'growth': ('강해짐', '그대로', '약해짐'),
    'inflation': ('재가속', '그대로', '둔화'),
    'fomc': ('인상', '동결', '인하'),
    'bonds': ('우호', '중립', '불리'),
}


def ts(s):
    return dt.datetime.fromisoformat(s.replace('Z', '+00:00'))


def iso(t):
    return t.astimezone(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


# ── 기록 → 하루별 묶음 ────────────────────────────────────────────────────────

def group_days(records):
    """records = {days:[question.json], entries:[...], approvals:[...]} → 끝난 하루 목록과 열린 하루.
    하루 = {t, q_at, close_at(다음 q_at 또는 None), entries(시각순), approvals(시각순)}"""
    days = sorted(records['days'], key=lambda d: d['t'])
    out = []
    for i, d in enumerate(days):
        out.append({
            't': d['t'], 'q_at': ts(d['q_at']),
            'close_at': ts(days[i + 1]['q_at']) if i + 1 < len(days) else None,
            'entries': sorted([e for e in records['entries'] if e['t'] == d['t']], key=lambda e: ts(e['message_date'])),
            'approvals': sorted([a for a in records['approvals'] if a['t'] == d['t']], key=lambda a: ts(a['message_date'])),
        })
    return out


def h16(rec):
    return rec['submission_hmac'][:16]


def day_choice(day, cell):
    """그날 그 칸의 마지막 글 → {value, cond, at, entry, base} 또는 None. cond = 그날 끝 전에 승인된 그 글·그 조건의 해석."""
    last = None
    for e in day['entries']:
        if cell in e.get('cells', {}):
            last = e
    if not last:
        return None
    raw = last.get('conditions', {}).get(cell)
    cond = None
    if raw:
        for a in day['approvals']:
            if day['close_at'] and ts(a['message_date']) >= day['close_at']:
                continue
            for x in a.get('approved', []):
                if x['cell'] == cell and x['entry'] == h16(last) and x['raw'] == raw:
                    cond = {'series': x['series'], 'op': x['op'], 'value': x['value'], 'restated': x['restated'], 'raw': raw}
    return {'value': last['cells'][cell], 'cond': cond, 'cond_raw': raw, 'at': ts(last['message_date']),
            'entry': h16(last), 'base': last.get('base'), 'base_missing': last.get('base_missing', [])}


def same(j, c):
    a = j['cond']
    b = c['cond']
    key = lambda x: None if x is None else (x['series'], x['op'], float(x['value']))  # noqa: E731
    return j['value'] == c['value'] and key(a) == key(b)


# ── 판단의 수명 ──────────────────────────────────────────────────────────────

def lifecycle(records, cell, checker, now):
    """한 칸의 판단 목록. checker(cell, j) → {'state':'waiting',...} | {'state':'closed', 'verdict', 'check_at', ...}
    checker.base_at(cell, t) → 시각 t 에 공개돼 있던 가장 최근 관측(이어짐 기준)."""
    out = []
    open_j = None
    seq = [0]

    def new(value, cond, at, base, origin, entry=None, base_missing=None):
        seq[0] += 1
        return {'id': f'{cell}-{seq[0]}', 'cell': cell, 'value': value, 'cond': cond, 'opened_at': at,
                'base': base, 'base_missing': base_missing or [], 'origin': origin, 'entry': entry}

    def advance(j, until):
        # until 전에 확인이 끝나면 닫고 이어짐을 연다(이어짐도 until 전에 끝나면 또).
        while j is not None:
            r = checker(cell, j)
            if r['state'] != 'closed' or r['check_at'] > until:
                return j
            out.append({**j, **r})
            if r['verdict'] == '기준 없음':
                return None
            j = new(j['value'], None, r['check_at'], checker.base_at(cell, r['check_at']), '이어짐')
        return None

    for day in group_days(records):
        if day['close_at'] is None:
            break  # 아직 끝나지 않은 하루의 글은 판단을 바꾸지 않는다
        c = day_choice(day, cell)
        if c is None:
            open_j = advance(open_j, day['close_at'])
            continue
        open_j = advance(open_j, c['at'])
        if open_j is not None and same(open_j, c):
            open_j = advance(open_j, day['close_at'])
            continue
        if open_j is not None:
            out.append({**open_j, 'state': 'closed', 'verdict': '바뀜', 'check_at': c['at']})
        open_j = new(c['value'], c['cond'], c['at'], c['base'], '글', c['entry'], c['base_missing'])
        open_j = advance(open_j, day['close_at'])
    open_j = advance(open_j, now)
    if open_j is not None:
        out.append({**open_j, **checker(cell, open_j)})
    return out


# ── 판정 수 계산(규칙 표 그대로) ─────────────────────────────────────────────

def bp(s):
    return int((Decimal(str(s)) * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))


def mom_pct(cur, prev):
    """전월비 %, 소수 둘째 자리 반올림(Decimal)."""
    return ((Decimal(str(cur)) / Decimal(str(prev)) - 1) * 100).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)


def word_bonds(change_bp, neutral_bp):
    if change_bp < -neutral_bp:
        return '우호'
    if change_bp > neutral_bp:
        return '불리'
    return '중립'


def word_growth(diff):
    d = Decimal(str(diff))
    if d <= Decimal('-0.1'):
        return '강해짐'
    if d >= Decimal('0.1'):
        return '약해짐'
    return '그대로'


def word_inflation(diff):
    d = Decimal(str(diff))
    if d >= Decimal('0.1'):
        return '재가속'
    if d <= Decimal('-0.1'):
        return '둔화'
    return '그대로'


def word_fomc(diff):
    d = Decimal(str(diff))
    return '인상' if d > 0 else '인하' if d < 0 else '동결'


def next_month(m):
    y, mo = int(m[:4]), int(m[5:7])
    y, mo = (y + 1, 1) if mo == 12 else (y, mo + 1)
    return f'{y:04d}-{mo:02d}-01'


# ── 확인기 ───────────────────────────────────────────────────────────────────
from zoneinfo import ZoneInfo  # noqa: E402

NY = ZoneInfo('America/New_York')
BASE_KEY = {'bonds': 'treasury10', 'growth': 'unrate', 'inflation': 'cpilfesl', 'fomc': 'fomc_next'}
DAILY = {'treasury10', 'sp500', 'dtwexbgs', 'fed_upper'}


def et(date, h, m):
    y, mo, d = (int(x) for x in date[:10].split('-'))
    return dt.datetime(y, mo, d, h, m, tzinfo=NY).astimezone(dt.timezone.utc)


def avail_treasury(d):
    return et(d, 16, 0)      # 재무부는 15:30 ET 호가로 그날 오후에 게시(11/23 실측 15:45-15:50 ET)


def avail_release(r):
    return et(r, 8, 30)      # CPI·고용 08:30 ET


def avail_daily(d):
    return et(d, 18, 0)


def avail_fomc(d):
    return et(d, 14, 0)


class Checker:
    """data 꼴(실제 자료는 topdown_data.py 가 채운다):
      treasury10: [(date, '4.12')]  날짜순, 빈 값 없음
      unrate_first / cpi_first: [(month 'YYYY-MM-01', '4.5', release_date)]  첫 발표값, 달순
      cpi_vintage(release_date) → {month: '331.000'}  그날 공개된 판
      fed_upper / sp500 / dtwexbgs: [(date, '4.50')]
      fomc: ['YYYY-MM-DD']  정례 결정일(rules/fomc-decisions.json)
    """

    def __init__(self, data, rules, now):
        self.d = data
        self.rules = rules
        self.now = now

    __call__ = lambda self, cell, j: self.check(cell, j)  # noqa: E731

    # 시각 t 에 공개돼 있던 가장 최근 관측(이어짐의 기준)
    def base_at(self, cell, t):
        if cell == 'bonds':
            xs = [(d, v) for d, v in self.d.treasury10 if avail_treasury(d) <= t]
            return {'treasury10': {'date': xs[-1][0], 'value': xs[-1][1]} if xs else None}
        if cell == 'growth':
            xs = [x for x in self.d.unrate_first if avail_release(x[2]) <= t]
            last = max(xs, key=lambda x: x[2]) if xs else None
            return {'unrate': {'date': last[0], 'value': last[1]} if last else None}
        if cell == 'inflation':
            xs = [x for x in self.d.cpi_first if avail_release(x[2]) <= t]
            if not xs:
                return {'cpilfesl': None}
            last = max(xs, key=lambda x: x[2])
            vin = self.d.cpi_vintage(last[2])
            prev = vin.get(self.prev_month(last[0]))
            return {'cpilfesl': [{'date': last[0], 'value': vin.get(last[0], last[1])}, {'date': self.prev_month(last[0]), 'value': prev}] if prev else None}
        if cell == 'fomc':
            nxt = [d for d in sorted(self.d.fomc) if avail_fomc(d) > t]
            return {'fomc_next': nxt[0] if nxt else None}
        return {}

    @staticmethod
    def prev_month(m):
        y, mo = int(m[:4]), int(m[5:7])
        y, mo = (y - 1, 12) if mo == 1 else (y, mo - 1)
        return f'{y:04d}-{mo:02d}-01'

    # 조건 자료의 흐름: [(Decimal 값, 공개 시각, 관측 날짜)]
    def stream(self, series):
        if series == 'treasury10':
            return [(Decimal(v), avail_treasury(d), d) for d, v in self.d.treasury10]
        if series in ('sp500', 'dtwexbgs', 'fed_upper'):
            return [(Decimal(v), avail_daily(d), d) for d, v in getattr(self.d, series)]
        if series == 'unrate':
            return [(Decimal(v), avail_release(r), m) for m, v, r in self.d.unrate_first]
        if series == 'core_cpi_mom':
            out = []
            for m, _, r in self.d.cpi_first:
                vin = self.d.cpi_vintage(r)
                p = vin.get(self.prev_month(m))
                if p and vin.get(m):
                    out.append((mom_pct(vin[m], p), avail_release(r), m))
            return out
        raise ValueError(series)

    def cond_break(self, j, until):
        """(opened_at, until] 사이 첫 깨짐 → (시각, 관측) 또는 None. until=None 이면 지금까지."""
        c = j['cond']
        if not c:
            return None
        lim = Decimal(str(c['value']))
        for v, at, d in sorted(self.stream(c['series']), key=lambda x: x[1]):
            if at <= j['opened_at'] or (until is not None and at > until) or at > self.now:
                continue
            if (c['op'] == 'gt' and v > lim) or (c['op'] == 'lt' and v < lim):
                return at, {'series': c['series'], 'date': d, 'value': str(v)}
        return None

    def cond_covered(self, j, until):
        c = j['cond']
        if not c or c['series'] not in DAILY:
            return True
        s = self.stream(c['series'])
        return bool(s) and max(x[1] for x in s) >= until - dt.timedelta(hours=20)

    def check(self, cell, j):
        key = BASE_KEY.get(cell)
        base = (j.get('base') or {}).get(key) if key else None
        if key is None or base is None:
            return {'state': 'closed', 'verdict': '기준 없음', 'check_at': j['opened_at']}
        target = getattr(self, f'target_{cell}')(j, base)
        if target.get('state') == 'waiting':
            br = self.cond_break(j, None)
            if br:
                return {'state': 'closed', 'verdict': '조건 깨짐', 'check_at': br[0], 'broken_by': br[1]}
            return {**target, 'overdue': self.overdue(cell, j, base)}
        br = self.cond_break(j, target['check_at'])
        if br:
            return {'state': 'closed', 'verdict': '조건 깨짐', 'check_at': br[0], 'broken_by': br[1]}
        if target.get('verdict'):
            return target
        if not self.cond_covered(j, target['check_at']):
            return {'state': 'waiting', 'reason': '조건 자료', 'overdue': self.overdue(cell, j, base)}
        return {**target, 'state': 'closed', 'verdict': '맞음' if target['outcome'] == j['value'] else '틀림'}

    def overdue(self, cell, j, base):
        if cell == 'bonds':
            return self.now > et(base['date'], 0, 0) + dt.timedelta(days=28 + 14)
        return self.now > j['opened_at'] + dt.timedelta(days=45)

    def target_bonds(self, j, base):
        after = [(d, v) for d, v in self.d.treasury10 if d > base['date']]
        n = 20
        if len(after) < n:
            return {'state': 'waiting', 'reason': f'관측 {len(after)}/{n}'}
        end = after[n - 1]
        ch = bp(end[1]) - bp(base['value'])
        return {'check_at': avail_treasury(end[0]), 'outcome': word_bonds(ch, self.rules['cells']['bonds']['neutral_bp']),
                'observed': {'base': base, 'end': {'date': end[0], 'value': end[1]}, 'change_bp': ch}}

    def first_after(self, rows, month):
        xs = [x for x in rows if x[0] > month]
        return min(xs, key=lambda x: (x[2], x[0])) if xs else None

    def target_growth(self, j, base):
        t = self.first_after(self.d.unrate_first, base['date'])
        if not t:
            return {'state': 'waiting', 'reason': '다음 발표 전'}
        at = avail_release(t[2])
        if t[0] != next_month(base['date']):
            return {'check_at': at, 'verdict': '확인 불가(결측월)', 'state': 'closed', 'observed': {'base': base, 'target': {'date': t[0], 'release': t[2]}}}
        diff = Decimal(t[1]) - Decimal(base['value'])
        return {'check_at': at, 'outcome': word_growth(diff), 'observed': {'base': base, 'target': {'date': t[0], 'value': t[1], 'release': t[2]}, 'diff': str(diff)}}

    def target_inflation(self, j, base):
        cur, prev = base[0], base[1]
        if self.prev_month(cur['date']) != prev['date']:   # 2025-10 처럼 한 달이 빠진 두 관측은 전월비가 아니다
            return {'state': 'closed', 'verdict': '기준 없음', 'check_at': j['opened_at']}
        base_mom = mom_pct(cur['value'], prev['value'])
        t = self.first_after(self.d.cpi_first, cur['date'])
        if not t:
            return {'state': 'waiting', 'reason': '다음 발표 전'}
        at = avail_release(t[2])
        if t[0] != next_month(cur['date']):
            return {'check_at': at, 'verdict': '확인 불가(결측월)', 'state': 'closed', 'observed': {'base_month': cur['date'], 'target': {'date': t[0], 'release': t[2]}}}
        vin = self.d.cpi_vintage(t[2])
        if not vin.get(t[0]) or not vin.get(cur['date']):
            return {'state': 'waiting', 'reason': '발표 판 자료'}
        tm = mom_pct(vin[t[0]], vin[cur['date']])
        diff = tm - base_mom
        return {'check_at': at, 'outcome': word_inflation(diff),
                'observed': {'base_month': cur['date'], 'base_mom': str(base_mom), 'target': {'date': t[0], 'release': t[2], 'mom': str(tm)}, 'diff': str(diff)}}

    def target_fomc(self, j, base):
        d = base
        before = (dt.date.fromisoformat(d) - dt.timedelta(days=1)).isoformat()
        after = (dt.date.fromisoformat(d) + dt.timedelta(days=1)).isoformat()
        vals = dict(self.d.fed_upper)
        if before not in vals or after not in vals:
            return {'state': 'waiting', 'reason': '결정 전' if self.now < avail_fomc(d) else '정책금리 자료'}
        diff = Decimal(vals[after]) - Decimal(vals[before])
        return {'check_at': avail_fomc(d), 'outcome': word_fomc(diff), 'observed': {'decision': d, 'before': vals[before], 'after': vals[after]}}

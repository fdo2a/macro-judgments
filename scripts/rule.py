"""규칙 v1 계산 — worker/src/rule.js 와 같은 답을 내야 한다(rules/test-vectors.json).

금리는 재무부 CSV 의 % 글자를 먼저 정수 bp 로 바꾼 뒤 뺀다. 소수로 빼면 3.61-3.60 이
0.99999…bp 가 되어 「1bp 미만」으로 잘못 판정된다.
"""
import re
from decimal import ROUND_HALF_UP, Decimal

_NUM = re.compile(r'^-?\d+(\.\d+)?$')


def to_bp(s):
    if s is None:
        return None
    t = str(s).strip()
    if not _NUM.match(t):
        return None
    return int((Decimal(t) * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))


def series_from(rows):
    out = []
    for date, v in rows:
        bp = to_bp(v)
        if bp is not None:
            out.append({'date': date, 'bp': bp})
    out.sort(key=lambda r: r['date'])
    return out


def signal_at(series, t):
    idx = next((i for i, r in enumerate(series) if r['date'] == t), None)
    if idx is None:
        return {'status': 'series_missing', 'missing': ['t']}
    if idx == 0:
        return {'status': 'series_missing', 'missing': ['t-1']}
    prev = series[idx - 1]
    d0 = series[idx]['bp'] - prev['bp']
    return {'status': 'no_signal' if d0 == 0 else 'signal', 'tm1': prev['date'],
            'y_tm1': prev['bp'], 'y_t': series[idx]['bp'], 'd0': d0}


def outcome_after(series, t, d0):
    idx = next((i for i, r in enumerate(series) if r['date'] == t), None)
    after = [r for r in series if r['date'] > t] if idx is None else series[idx + 1:]
    if idx is None or len(after) < 5:
        return {'status': 'pending', 'have': len(after)}
    t5 = after[4]
    d5 = t5['bp'] - series[idx]['bp']
    if d5 == 0:
        return {'status': 'undecidable', 't5': t5['date'], 'y_t5': t5['bp'], 'd5': d5}
    same = (d5 > 0) == (d0 > 0)
    return {'status': 'scoreable', 't5': t5['date'], 'y_t5': t5['bp'], 'd5': d5, 'o': 1 if same else 0}


def overlaps(t, t5, dates):
    return any(t < d <= t5 for d in dates)


def brier(p, o):
    x = p / 100 - o
    return x * x

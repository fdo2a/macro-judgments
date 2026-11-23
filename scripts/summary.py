#!/usr/bin/env python3
"""채점 요약 → scores/summary.json. 레포 파일과 git 이력만 읽는다(네트워크 없음).

상태표·분모는 rules/v1.json·설계 v1.5 §7 그대로다. 결과를 보기 전에 정한 것이고 여기서 바꾸지 않는다.
- 모집단 = rules/schedule.json 의 줄 중 t 가 지난 것 전부.
- 결과 상태(사건마다 하나): 진행 중 | 취소 | 기록 없음 | 보류: 발표 미확인 | 시리즈 결측 | 신호 없음 |
  보류: 값 부족 | 판정 불가 | 채점 가능. 상태별 건수의 합이 모집단과 다르면 실패로 끝난다.
- 질문 전달 상태: 질문한 사건에만 {전달됨 | 질문 실패}.
- 제출 상태는 결과가 확정된(값 부족·판정 불가·채점 가능) 사건에만: {마감 전 제출 | 마감 후만 | 기권}.
  AI 는 그 사건 전부, 사람은 그 가운데 전달됨인 사건에만.
- 사람 마감 판정 = 텔레그램 message_date ≤ deadline_at. AI = commit.json 을 처음 더한 커밋의 시각 ≤ deadline_at.
- 공개(reveal)의 지문이 commit 과 맞지 않으면 실패로 끝난다(조용히 넘기지 않는다).

    python3 scripts/summary.py --root . --now 2026-12-20T00:00:00Z --out scores/summary.json
"""
import argparse
import datetime as dt
import glob
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rule import brier  # noqa: E402
from seal import seal_hash  # noqa: E402

KIND_CODE = {'cpi': 'CPI', 'employment': 'EMP'}
RESULT_STATES = ['진행 중', '취소', '기록 없음', '보류: 발표 미확인', '시리즈 결측', '신호 없음', '보류: 값 부족', '판정 불가', '채점 가능']
FINAL_OUTCOME = {'value_shortage': '보류: 값 부족', 'undecidable': '판정 불가', 'scoreable': '채점 가능'}
EVENT_FINAL = {'held_unconfirmed': '보류: 발표 미확인', 'series_missing': '시리즈 결측', 'no_signal': '신호 없음'}
EDGE_TEXT = '엣지 확인 안 됨 — 이 요약은 판단 기록의 채점일 뿐이고, 표본(사건 유형마다 1년 12건 안팎)으로 초과 수익을 주장하지 않는다.'


class SummaryError(Exception):
    pass


def ts(s):
    return dt.datetime.fromisoformat(s.replace('Z', '+00:00'))


def load(path):
    if not os.path.exists(path):
        return None
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def event_id(kind, t):
    return f'US-{KIND_CODE[kind]}-{t}'


def git_added_at(root, path):
    """그 파일을 처음 더한 커밋의 커미터 시각(GitHub 서버 시각). 없으면 None."""
    try:
        out = subprocess.run(['git', '-C', root, 'log', '--diff-filter=A', '--format=%cI', '--', path],
                             capture_output=True, text=True, check=True).stdout.strip().splitlines()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    return out[-1] if out else None


def ny_noon_after(t, days):
    """t + days 일 12:00 뉴욕 시각(UTC). 서머타임은 3월 둘째 일요일-11월 첫째 일요일."""
    d = dt.date.fromisoformat(t) + dt.timedelta(days=days)
    y = d.year
    mar1 = dt.date(y, 3, 1)
    dst_start = mar1 + dt.timedelta(days=(6 - mar1.weekday()) % 7 + 7)
    nov1 = dt.date(y, 11, 1)
    dst_end = nov1 + dt.timedelta(days=(6 - nov1.weekday()) % 7)
    off = 4 if dst_start <= d < dst_end else 5
    return dt.datetime(d.year, d.month, d.day, 12 + off, tzinfo=dt.timezone.utc)


def result_state(root, row, now):
    if row.get('cancelled'):
        return '취소', None, None
    eid = event_id(row['kind'], row['t'])
    ev = load(os.path.join(root, 'events', f'{eid}.json'))
    out = load(os.path.join(root, 'outcomes', f'{eid}.json'))
    if ev is None:
        # t+1 12:00 ET 확정 기한에서 하루 더 지났는데 사건 파일이 없으면 기록 없음
        return ('기록 없음' if now > ny_noon_after(row['t'], 2) else '진행 중'), None, None
    if ev['status'] in EVENT_FINAL:
        return EVENT_FINAL[ev['status']], ev, None
    if out is None:
        return '진행 중', ev, None
    if out['status'] not in FINAL_OUTCOME:
        raise SummaryError(f'{eid}: 알 수 없는 결과 상태 {out["status"]!r}')
    return FINAL_OUTCOME[out['status']], ev, out


def human_status(root, eid, deadline):
    subs = []
    for p in sorted(glob.glob(os.path.join(root, 'human', eid, '*.json'))):
        r = load(p)
        subs.append(r)
    on_time = [r for r in subs if ts(r['message_date']) <= deadline]
    if on_time:
        last = max(on_time, key=lambda r: (r['message_date'], r['received_at']))
        return '마감 전 제출', last['p'], len(subs)
    return ('마감 후만' if subs else '기권'), None, len(subs)


def ai_status(root, eid, deadline):
    base = os.path.join(root, 'ai', eid)
    if load(os.path.join(base, 'missing.json')) is not None:
        return '기권', None, None
    commit = load(os.path.join(base, 'commit.json'))
    if commit is None:
        return '기권', None, None
    reveal = load(os.path.join(base, 'reveal.json'))
    if reveal is None:
        raise SummaryError(f'{eid}: AI commit 은 있는데 결과 확정 뒤에도 reveal 이 없다')
    if seal_hash(reveal['plain'], reveal['nonce']) != commit['sha256'] or reveal['sha256'] != commit['sha256']:
        raise SummaryError(f'{eid}: AI 공개 지문이 봉인과 맞지 않는다')
    added = git_added_at(root, os.path.relpath(os.path.join(base, 'commit.json'), root))
    if added is None:
        raise SummaryError(f'{eid}: ai commit.json 의 커밋 시각을 git 에서 찾지 못했다(fetch-depth 확인)')
    served = reveal.get('served_model')
    if ts(added) <= deadline:
        return '마감 전 제출', reveal['plain']['p'], served
    return '마감 후만', None, served


def mean(xs):
    return round(sum(xs) / len(xs), 6) if xs else None


def score_block(items, base_rate):
    """items: [(p_or_None, o)] 한 예측자의 분모. 기준선 셋을 같은 사건 집합에서."""
    if not items:
        return {'n': 0}
    ps = [p for p, _ in items]
    os_ = [o for _, o in items]
    out = {
        'n': len(items),
        'brier': mean([brier(p, o) for p, o in items]),
        'baseline_always_persist': mean([brier(100, o) for o in os_]),
        'baseline_always_reverse': mean([brier(0, o) for o in os_]),
        'baseline_climatology': mean([brier(base_rate, o) for o in os_]) if base_rate is not None else None,
        'hit_rate_at_50': round(sum(1 for p, o in items if (p > 50 and o == 1) or (p < 50 and o == 0)) / len(items), 4),
        'mean_p': round(sum(ps) / len(ps), 2),
        'persist_share': round(sum(os_) / len(os_), 4),
    }
    return out


def summarize(root, now):
    rules = load(os.path.join(root, 'rules', 'v1.json'))
    schedule = load(os.path.join(root, 'rules', 'schedule.json'))
    if not schedule or not isinstance(schedule.get('rows'), list):
        raise SummaryError('rules/schedule.json 을 읽지 못했다')
    base = load(os.path.join(root, 'rules', 'v1-base-rate.json')) or {}
    rates = {k: (v.get('persist_pct') if isinstance(v, dict) else None) for k, v in (base.get('by_kind') or {}).items()}

    rows = [r for r in schedule['rows'] if dt.date.fromisoformat(r['t']) <= now.date()]
    events = []
    for row in rows:
        state, ev, out = result_state(root, row, now)
        eid = event_id(row['kind'], row['t'])
        rec = {'event': eid, 'kind': row['kind'], 't': row['t'], 'result': state}
        if ev and ev.get('status') == 'questioned':
            d = load(os.path.join(root, 'delivery', f'{eid}.json'))
            rec['delivery'] = None if d is None else ('전달됨' if d['status'] == 'delivered' else '질문 실패')
        if out and state in ('보류: 값 부족', '판정 불가', '채점 가능'):
            deadline = ts(ev['deadline_at'])
            rec['overlap'] = out.get('overlap')
            rec['o'] = out.get('o')
            a_state, a_p, served = ai_status(root, eid, deadline)
            rec['ai'] = {'state': a_state, 'p': a_p, 'served_model': served}
            if rec.get('delivery') == '전달됨':
                h_state, h_p, n = human_status(root, eid, deadline)
                rec['human'] = {'state': h_state, 'p': h_p, 'submissions': n}
        events.append(rec)

    counts = {k: {s: 0 for s in RESULT_STATES} for k in KIND_CODE}
    for e in events:
        counts[e['kind']][e['result']] += 1
    for k in KIND_CODE:
        if sum(counts[k].values()) != sum(1 for r in rows if r['kind'] == k):
            raise SummaryError(f'{k}: 상태별 건수 합이 모집단과 다르다')

    scores = {}
    for k in KIND_CODE:
        scores[k] = {}
        for label, keep in (('all', lambda e: True), ('excl_overlap', lambda e: e.get('overlap') is False)):
            sc = [e for e in events if e['kind'] == k and e['result'] == '채점 가능' and keep(e)]
            hum = [(e['human']['p'], e['o']) for e in sc if e.get('human', {}).get('state') == '마감 전 제출']
            ai = [(e['ai']['p'], e['o']) for e in sc if e['ai']['state'] == '마감 전 제출']
            both = [e for e in sc if e.get('human', {}).get('state') == '마감 전 제출' and e['ai']['state'] == '마감 전 제출']
            scores[k][label] = {
                'human': score_block(hum, rates.get(k)),
                'ai': score_block(ai, rates.get(k)),
                'head_to_head': {
                    'n': len(both),
                    'human_brier': mean([brier(e['human']['p'], e['o']) for e in both]),
                    'ai_brier': mean([brier(e['ai']['p'], e['o']) for e in both]),
                },
                'undecidable': sum(1 for e in events if e['kind'] == k and e['result'] == '판정 불가' and keep(e)),
            }

    def tally(who, state):
        return {k: sum(1 for e in events if e['kind'] == k and e.get(who, {}).get('state') == state) for k in KIND_CODE}

    disagreements = [
        {'event': e['event'], 'human_p': e['human']['p'], 'ai_p': e['ai']['p'], 'o': e.get('o')}
        for e in events
        if e.get('human', {}).get('p') is not None and e['ai'].get('p') is not None and abs(e['human']['p'] - e['ai']['p']) >= 20
    ]
    return {
        'rule': rules['rule'],
        'generated_at': now.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'statement': EDGE_TEXT,
        'limits': rules['limits'],
        'base_rate': base.get('by_kind'),
        'result_counts': counts,
        'question_failed': {k: sum(1 for e in events if e['kind'] == k and e.get('delivery') == '질문 실패') for k in KIND_CODE},
        'human_late_only': tally('human', '마감 후만'),
        'human_abstain': tally('human', '기권'),
        'ai_late_only': tally('ai', '마감 후만'),
        'ai_abstain': tally('ai', '기권'),
        'ai_served_by_other_model': [e['event'] for e in events if e.get('ai', {}).get('served_model') not in (None, rules['ai']['model'])],
        'scores': scores,
        'disagreements_20pp': disagreements,
        'events': events,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default='.')
    ap.add_argument('--now', default=None)
    ap.add_argument('--out', default='scores/summary.json')
    a = ap.parse_args()
    now = ts(a.now) if a.now else dt.datetime.now(dt.timezone.utc)
    try:
        doc = summarize(a.root, now)
    except SummaryError as e:
        sys.exit(f'요약 실패: {e}')
    os.makedirs(os.path.dirname(os.path.join(a.root, a.out)), exist_ok=True)
    with open(os.path.join(a.root, a.out), 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print(json.dumps({k: doc[k] for k in ('result_counts', 'question_failed')}, ensure_ascii=False))


if __name__ == '__main__':
    main()

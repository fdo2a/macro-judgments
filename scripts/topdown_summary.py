#!/usr/bin/env python3
"""탑다운 일지 요약 → scores/topdown.json (파생물, 덮어써도 된다).

레포의 topdown/ 기록(Worker 가 만들기만 한 파일)과 자료(topdown_data.py)로 판단·확인·하루 목록을 다시 계산한다.
같은 기록·같은 자료면 언제 돌려도 판정이 같다. 「자료 대기가 오래됨」 표시만 실행 시각에 따라 바뀐다.

    FRED_API_KEY=... python3 scripts/topdown_summary.py --root . --out scores/topdown.json
"""
import argparse
import datetime as dt
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from topdown_ledger import Checker, lifecycle, ts, iso  # noqa: E402

CLOSED_VERDICTS = ['맞음', '틀림', '조건 깨짐', '확인 불가(결측월)', '기준 없음', '바뀜']


def load_json(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def load_records(root):
    td = os.path.join(root, 'topdown')
    g = lambda pat: sorted(glob.glob(os.path.join(td, pat)))  # noqa: E731
    return {
        'days': [load_json(p) for p in g('days/*/question.json')],
        'entries': [load_json(p) for p in g('entries/*/*.json')],
        'approvals': [load_json(p) for p in g('approvals/*/*.json')],
        'critiques': [load_json(p) for p in g('critique/*/*.json')],
        'reports': {r['t']: r for r in (load_json(p) for p in g('reports/*.json'))},
    }


def open_cells(rules):
    return [k for k, c in rules['cells'].items() if 'band' not in c or c['band'] is not None]


def day_rows(rec):
    """하루마다: 작성 여부, 첨삭 성공/실패, 칸별 첫 값 → 마지막 값, 첨삭·보고서 뒤 바꿈, 보고서 전/후."""
    crit_by_entry = {c['entry']: c for c in rec['critiques']}
    rows = []
    for q in sorted(rec['days'], key=lambda d: d['t']):
        t = q['t']
        es = sorted([e for e in rec['entries'] if e['t'] == t], key=lambda e: ts(e['message_date']))
        rep = rec['reports'].get(t)
        rep_at = ts(rep['first_commit_at']) if rep else None
        crit_ok = [crit_by_entry[e['submission_hmac'][:16]] for e in es if e['submission_hmac'][:16] in crit_by_entry]
        first_crit_at = min((ts(c['at']) for c in crit_ok if c['status'] == 'ok'), default=None)
        cells = {}
        for e in es:
            at = ts(e['message_date'])
            for k, v in e.get('cells', {}).items():
                if k not in cells:
                    cells[k] = {'first': v, 'last': v, 'after_critique': False, 'after_report': False}
                elif v != cells[k]['last']:
                    cells[k]['last'] = v
                    if first_crit_at and at > first_crit_at:
                        cells[k]['after_critique'] = True
                    if rep_at and at > rep_at:
                        cells[k]['after_report'] = True
        first_at = ts(es[0]['message_date']) if es else None
        rows.append({
            't': t,
            'question': q.get('status'),
            'written': bool(es),
            'entries': len(es),
            'critique': {'ok': sum(c['status'] == 'ok' for c in crit_ok), 'failed': sum(c['status'] != 'ok' for c in crit_ok),
                         'missing': len(es) - len(crit_ok)},
            'report': None if not rep else {'status': rep['status'], 'first_commit_at': rep['first_commit_at']},
            'first_entry': None if not es else ('보고서 전' if rep_at is None or first_at < rep_at else '보고서 후'),
            'report_seen': rep is not None,
            'cells': cells,
        })
    return rows


def jsonable(j):
    out = {}
    for k, v in j.items():
        out[k] = iso(v) if isinstance(v, dt.datetime) else v
    return out


def summarize(root, rules, data, now):
    rec = load_records(root)
    checker = Checker(data, rules, now)
    judgments = []
    for cell in open_cells(rules):
        judgments += [jsonable(j) for j in lifecycle(rec, cell, checker, now)]
    counts = {}
    for cell in open_cells(rules):
        js = [j for j in judgments if j['cell'] == cell]
        c = {v: sum(1 for j in js if j.get('verdict') == v) for v in CLOSED_VERDICTS}
        c['자료 대기'] = sum(1 for j in js if j['state'] == 'waiting')
        counts[cell] = c
    days = day_rows(rec)
    return {
        'rule': rules['rule'],
        'generated_at': iso(now),
        'note': '판단 기록의 확인일 뿐이다. 칸마다 1년에 확인되는 판단이 많지 않아 실력이나 엣지를 주장하지 않는다.',
        'counts': counts,
        'overdue': [{'id': j['id'], 'cell': j['cell'], 'opened_at': j['opened_at'], 'reason': j.get('reason')} for j in judgments if j['state'] == 'waiting' and j.get('overdue')],
        'days': days,
        'days_total': len(days),
        'days_written': sum(d['written'] for d in days),
        'judgments': judgments,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default='.')
    ap.add_argument('--out', required=True)
    ap.add_argument('--now', default=None)
    a = ap.parse_args()
    from topdown_data import load_data  # 네트워크(재무부·FRED) — 시험에서는 쓰지 않는다
    rules = load_json(os.path.join(a.root, 'rules', 'topdown-v1.json'))
    now = ts(a.now) if a.now else dt.datetime.now(dt.timezone.utc)
    data = load_data(a.root, now)
    out = summarize(a.root, rules, data, now)
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
        f.write('\n')


if __name__ == '__main__':
    main()

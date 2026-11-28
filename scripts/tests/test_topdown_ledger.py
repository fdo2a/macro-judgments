"""탑다운 판단의 수명과 확인 — 기록 꼴은 Worker 가 남기는 그대로, 자료는 가짜."""
import datetime as dt
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from topdown_ledger import Checker, lifecycle, ts  # noqa: E402

RULES = json.load(open(os.path.join(ROOT, 'rules', 'topdown-v1.json'), encoding='utf-8'))


def bdays(start, n):
    d = dt.date.fromisoformat(start)
    out = []
    while len(out) < n:
        d += dt.timedelta(days=1)
        if d.weekday() < 5:
            out.append(d.isoformat())
    return out


class D:
    def __init__(self, **kw):
        self.treasury10 = []
        self.unrate_first = []
        self.cpi_first = []
        self.vin = {}
        self.fed_upper = []
        self.sp500 = []
        self.dtwexbgs = []
        self.fomc = ['2026-10-28', '2026-12-09', '2027-01-27']
        self.__dict__.update(kw)

    def cpi_vintage(self, r):
        return self.vin.get(r, {})


BASE = {
    'treasury10': {'date': '2026-11-30', 'value': '4.08'},
    'unrate': {'date': '2026-10-01', 'value': '4.5'},
    'cpilfesl': [{'date': '2026-10-01', 'value': '331.000'}, {'date': '2026-09-01', 'value': '330.100'}],
    'fomc_next': '2026-12-09',
}


def day(t, q_at):
    return {'t': t, 'q_at': q_at, 'status': 'sent'}


def entry(t, at, cells, conditions=None, base=BASE, hm='a' * 64):
    return {'t': t, 'message_date': at, 'cells': cells, 'conditions': conditions or {}, 'base': base, 'base_missing': [], 'submission_hmac': hm}


def appr(t, at, cell, ent_hm, raw, series, op, value):
    return {'t': t, 'message_date': at, 'approved': [{'cell': cell, 'entry': ent_hm[:16], 'raw': raw, 'series': series, 'op': op, 'value': value, 'restated': 'x'}]}


DAYS = [day('2026-11-30', '2026-11-30T21:15:00Z'), day('2026-12-01', '2026-12-01T21:15:00Z'), day('2026-12-02', '2026-12-02T21:15:00Z')]
OBS = bdays('2026-11-30', 25)


def treasury(values):
    return [('2026-11-30', '4.08')] + list(zip(OBS, values))


def run(records, cell, data, now='2027-03-01T00:00:00Z'):
    return lifecycle(records, cell, Checker(data, RULES, ts(now)), ts(now))


def test_bonds_right_then_continues():
    vals = ['4.05'] * 19 + ['3.95'] + ['3.90'] * 5
    rec = {'days': DAYS, 'entries': [entry('2026-11-30', '2026-11-30T21:40:00Z', {'bonds': '우호'})], 'approvals': []}
    js = run(rec, 'bonds', D(treasury10=treasury(vals)))
    assert js[0]['verdict'] == '맞음'
    assert js[0]['observed']['change_bp'] == -13
    assert js[0]['observed']['end']['date'] == OBS[19]
    assert js[0]['opened_at'] == ts('2026-11-30T21:40:00Z'), '연 시각 = 글 시각(하루 끝이 아니다)'
    assert js[1]['origin'] == '이어짐' and js[1]['cond'] is None
    assert js[1]['base']['treasury10'] == {'date': OBS[19], 'value': '3.95'}
    assert js[1]['state'] == 'waiting'


def test_neutral_boundary_is_inclusive():
    vals = ['4.05'] * 19 + ['3.98']           # −10bp → 중립
    rec = {'days': DAYS, 'entries': [entry('2026-11-30', '2026-11-30T21:40:00Z', {'bonds': '우호'})], 'approvals': []}
    js = run(rec, 'bonds', D(treasury10=treasury(vals)))
    assert (js[0]['outcome'], js[0]['verdict']) == ('중립', '틀림')


def test_change_closes_old_as_changed_and_same_value_does_nothing():
    rec = {'days': DAYS, 'entries': [
        entry('2026-11-30', '2026-11-30T21:40:00Z', {'bonds': '우호'}, hm='a' * 64),
        entry('2026-12-01', '2026-12-01T22:00:00Z', {'bonds': '우호'}, hm='b' * 64),      # 같은 값 — 아무 일 없음
        entry('2026-12-02', '2026-12-02T22:00:00Z', {'bonds': '중립'}, hm='c' * 64),      # 끝나지 않은 하루 — 아직 안 바뀜
    ], 'approvals': []}
    js = run(rec, 'bonds', D(treasury10=treasury(['4.05'] * 3)))
    assert [j['verdict'] if j['state'] == 'closed' else j['state'] for j in js] == ['waiting']
    assert js[0]['entry'] == 'a' * 16
    rec['days'] = DAYS + [day('2026-12-03', '2026-12-03T21:15:00Z')]
    js = run(rec, 'bonds', D(treasury10=treasury(['4.05'] * 3)))
    assert [(j['value'], j.get('verdict') or j['state']) for j in js] == [('우호', '바뀜'), ('중립', 'waiting')]
    assert js[0]['check_at'] == ts('2026-12-02T22:00:00Z')


def test_last_message_of_the_day_wins_and_first_is_not_scored():
    rec = {'days': DAYS, 'entries': [
        entry('2026-11-30', '2026-11-30T21:40:00Z', {'bonds': '불리'}, hm='a' * 64),
        entry('2026-11-30', '2026-11-30T23:40:00Z', {'bonds': '우호'}, hm='b' * 64),
    ], 'approvals': []}
    js = run(rec, 'bonds', D(treasury10=treasury(['4.05'] * 3)))
    assert len(js) == 1 and js[0]['value'] == '우호' and js[0]['entry'] == 'b' * 16


def test_condition_breaks_before_check_and_only_approved_counts():
    hm = 'a' * 64
    raw = '10년물 4.20% 넘으면'
    vals = ['4.10', '4.15', '4.25'] + ['3.90'] * 22
    rec = {'days': DAYS, 'entries': [entry('2026-11-30', '2026-11-30T21:40:00Z', {'bonds': '우호'}, {'bonds': raw}, hm=hm)],
           'approvals': [appr('2026-11-30', '2026-11-30T21:45:00Z', 'bonds', hm, raw, 'treasury10', 'gt', 4.2)]}
    js = run(rec, 'bonds', D(treasury10=treasury(vals)))
    assert js[0]['verdict'] == '조건 깨짐'
    assert js[0]['broken_by']['date'] == OBS[2]
    assert js[1]['origin'] == '이어짐' and js[1]['cond'] is None
    # 하루가 끝난 뒤의 승인, 다른 글을 가리키는 승인은 조건이 아니다
    rec['approvals'] = [appr('2026-11-30', '2026-12-01T21:30:00Z', 'bonds', hm, raw, 'treasury10', 'gt', 4.2),
                        appr('2026-11-30', '2026-11-30T21:45:00Z', 'bonds', 'z' * 64, raw, 'treasury10', 'gt', 4.2)]
    js = run(rec, 'bonds', D(treasury10=treasury(vals)))
    assert js[0]['cond'] is None and js[0]['verdict'] == '맞음'


def test_check_before_change_is_scored_not_changed():
    vals = ['4.05'] * 19 + ['3.95'] + ['3.90'] * 5
    days = DAYS + [day(d, f'{d}T21:15:00Z') for d in OBS[19:23]]
    late = OBS[20]
    rec = {'days': days, 'entries': [
        entry('2026-11-30', '2026-11-30T21:40:00Z', {'bonds': '우호'}, hm='a' * 64),
        entry(late, f'{late}T22:00:00Z', {'bonds': '불리'}, base=dict(BASE, treasury10={'date': late, 'value': '3.90'}), hm='b' * 64),
    ], 'approvals': []}
    js = run(rec, 'bonds', D(treasury10=treasury(vals)))
    assert [(j['origin'], j['value'], j.get('verdict') or j['state']) for j in js] == [
        ('글', '우호', '맞음'), ('이어짐', '우호', '바뀜'), ('글', '불리', 'waiting')]


def test_growth_next_month_and_missing_month():
    rec = {'days': DAYS, 'entries': [entry('2026-11-30', '2026-11-30T21:40:00Z', {'growth': '약해짐'})], 'approvals': []}
    js = run(rec, 'growth', D(unrate_first=[('2026-10-01', '4.5', '2026-11-06'), ('2026-11-01', '4.6', '2026-12-04')]))
    assert (js[0]['outcome'], js[0]['verdict']) == ('약해짐', '맞음')
    assert js[0]['check_at'] == ts('2026-12-04T13:30:00Z')
    assert js[1]['base']['unrate'] == {'date': '2026-11-01', 'value': '4.6'}
    base = dict(BASE, unrate={'date': '2026-09-01', 'value': '4.4'})
    rec['entries'] = [entry('2026-11-30', '2026-11-30T21:40:00Z', {'growth': '약해짐'}, base=base)]
    js = run(rec, 'growth', D(unrate_first=[('2026-09-01', '4.4', '2026-10-03'), ('2026-11-01', '4.6', '2026-12-04')]))
    assert js[0]['verdict'] == '확인 불가(결측월)'


def test_inflation_mom_from_release_vintage():
    rec = {'days': DAYS, 'entries': [entry('2026-11-30', '2026-11-30T21:40:00Z', {'inflation': '그대로'})], 'approvals': []}
    d = D(cpi_first=[('2026-10-01', '331.000', '2026-11-10'), ('2026-11-01', '331.900', '2026-12-10')],
          vin={'2026-12-10': {'2026-11-01': '331.900', '2026-10-01': '331.000'}})
    js = run(rec, 'inflation', d)
    assert js[0]['observed']['base_mom'] == '0.27'
    assert js[0]['observed']['target']['mom'] == '0.27'
    assert js[0]['verdict'] == '맞음'


def test_fomc_hike_and_waiting_before_decision():
    rec = {'days': DAYS, 'entries': [entry('2026-11-30', '2026-11-30T21:40:00Z', {'fomc': '동결'})], 'approvals': []}
    d = D(fed_upper=[('2026-12-08', '4.50'), ('2026-12-10', '4.75')])
    js = run(rec, 'fomc', d)
    assert (js[0]['outcome'], js[0]['verdict']) == ('인상', '틀림')
    assert js[1]['base'] == {'fomc_next': '2027-01-27'}
    js = run(rec, 'fomc', D(), now='2026-12-05T00:00:00Z')
    assert js[0]['state'] == 'waiting' and js[0]['reason'] == '결정 전'


def test_missing_base_is_not_scored_and_does_not_continue():
    base = dict(BASE, treasury10=None)
    rec = {'days': DAYS, 'entries': [entry('2026-11-30', '2026-11-30T21:40:00Z', {'bonds': '우호'}, base=base)], 'approvals': []}
    js = run(rec, 'bonds', D(treasury10=treasury(['4.0'] * 25)))
    assert [j['verdict'] for j in js] == ['기준 없음']


def test_waiting_turns_overdue_but_verdict_does_not_depend_on_now():
    rec = {'days': DAYS, 'entries': [entry('2026-11-30', '2026-11-30T21:40:00Z', {'growth': '약해짐'})], 'approvals': []}
    early = run(rec, 'growth', D(), now='2026-12-20T00:00:00Z')
    late = run(rec, 'growth', D(), now='2027-02-20T00:00:00Z')
    assert early[0]['state'] == late[0]['state'] == 'waiting'
    assert (early[0]['overdue'], late[0]['overdue']) == (False, True)


def test_summary_from_repo_files(tmp_path):
    from topdown_summary import summarize

    def put(path, obj):
        p = tmp_path / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(obj, ensure_ascii=False), encoding='utf-8')

    for d in DAYS:
        put(f"topdown/days/{d['t']}/question.json", d)
    e1 = entry('2026-11-30', '2026-11-30T21:40:00Z', {'bonds': '불리', 'growth': '약해짐'}, hm='a' * 64)
    e2 = entry('2026-11-30', '2026-11-30T23:30:00Z', {'bonds': '우호'}, hm='b' * 64)
    put('topdown/entries/2026-11-30/aaaaaaaaaaaaaaaa.json', e1)
    put('topdown/entries/2026-11-30/bbbbbbbbbbbbbbbb.json', e2)
    put('topdown/critique/2026-11-30/aaaaaaaaaaaaaaaa.json', {'entry': 'a' * 16, 'status': 'ok', 'at': '2026-11-30T21:41:00Z'})
    put('topdown/critique/2026-11-30/bbbbbbbbbbbbbbbb.json', {'entry': 'b' * 16, 'status': 'failed', 'at': '2026-11-30T23:31:00Z'})
    put('topdown/reports/2026-11-30.json', {'t': '2026-11-30', 'status': 'compared', 'first_commit_at': '2026-11-30T23:10:00Z'})
    vals = ['4.05'] * 19 + ['3.95'] + ['3.90'] * 5
    out = summarize(str(tmp_path), RULES, D(treasury10=treasury(vals)), ts('2027-03-01T00:00:00Z'))
    d0 = out['days'][0]
    assert d0['written'] and d0['entries'] == 2
    assert d0['critique'] == {'ok': 1, 'failed': 1, 'missing': 0}
    assert d0['first_entry'] == '보고서 전'
    assert d0['cells']['bonds'] == {'first': '불리', 'last': '우호', 'after_critique': True, 'after_report': True}
    assert out['counts']['bonds']['맞음'] == 1
    assert out['counts']['growth']['자료 대기'] == 1
    assert out['days_written'] == 1 and out['days_total'] == 3
    json.dumps(out, ensure_ascii=False)


def test_inflation_base_with_gap_month_is_not_scored():
    base = dict(BASE, cpilfesl=[{'date': '2025-11-01', 'value': '330.0'}, {'date': '2025-09-01', 'value': '329.0'}])
    rec = {'days': DAYS, 'entries': [entry('2026-11-30', '2026-11-30T21:40:00Z', {'inflation': '둔화'}, base=base)], 'approvals': []}
    js = run(rec, 'inflation', D())
    assert [j['verdict'] for j in js] == ['기준 없음']

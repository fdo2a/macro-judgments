import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from base_rate import compute, multi_date_months  # noqa: E402
from build_schedule import merge  # noqa: E402
from fred import parse_treasury  # noqa: E402
from rule import series_from  # noqa: E402


def test_compute_counts_same_definition():
    s = series_from([
        ('2021-01-11', '0.10'), ('2021-01-12', '0.12'), ('2021-01-13', '0.13'), ('2021-01-14', '0.14'),
        ('2021-01-15', '0.15'), ('2021-01-19', '0.16'), ('2021-01-20', '0.17'),  # 01-12 상승 → 지속
        ('2022-01-11', '0.90'), ('2022-01-12', '0.90'),                          # 신호 없음
        ('2022-02-09', '1.30'), ('2022-02-10', '1.40'), ('2022-02-11', '1.35'), ('2022-02-14', '1.33'),
        ('2022-02-15', '1.32'), ('2022-02-16', '1.31'), ('2022-02-17', '1.30'),  # 02-10 상승 → 반전
    ])
    c = compute(s, ['2021-01-12', '2022-01-12', '2022-02-10', '2030-01-01'], '2000-01-01', '2026-12-01')
    assert (c['events'], c['no_signal'], c['scoreable'], c['persist'], c['persist_pct']) == (3, 1, 2, 1, 50)
    assert (c['scoreable_before_method_change'], c['scoreable_after_method_change']) == (1, 1)


def test_multi_date_months():
    assert multi_date_months(['2020-02-11', '2020-02-13', '2020-03-11']) == {'2020-02': ['2020-02-11', '2020-02-13']}


def test_merge_appends_only():
    rows, added = merge([{'kind': 'cpi', 't': '2026-12-10', 'cancelled': 'x'}], {'cpi': ['2026-12-10', '2027-01-13'], 'employment': ['2027-01-08']})
    assert [r['t'] for r in rows] == ['2026-12-10', '2027-01-08', '2027-01-13']
    assert rows[0]['cancelled'] == 'x'
    assert len(added) == 2


def test_parse_treasury_real_head():
    txt = open(os.path.join(ROOT, 'worker', 'test', 'fixture-treasury-2026-head.csv'), encoding='utf-8').read()
    rows = parse_treasury(txt)
    assert rows[0] == ('2026-11-20', '4.63')

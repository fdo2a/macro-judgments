"""규칙 v1 계산 — rules/test-vectors.json 공통 예제(JS Worker 와 같은 답)."""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

from rule import brier, outcome_after, overlaps, series_from, signal_at, to_bp  # noqa: E402

V = json.load(open(os.path.join(ROOT, 'rules', 'test-vectors.json'), encoding='utf-8'))


def test_to_bp():
    assert to_bp('3.61') == 361
    assert to_bp('4.6') == 460
    assert to_bp(' 0.05 ') == 5
    assert to_bp('') is None
    assert to_bp('N/A') is None
    assert to_bp(None) is None


@pytest.mark.parametrize('v', V['signal'], ids=[v['name'] for v in V['signal']])
def test_signal(v):
    assert signal_at(series_from(v['series']), v['t']) == v['want']


@pytest.mark.parametrize('v', V['outcome'], ids=[v['name'] for v in V['outcome']])
def test_outcome(v):
    assert outcome_after(series_from(v['series']), v['t'], v['d0']) == v['want']


@pytest.mark.parametrize('v', V['overlap'], ids=[v['name'] for v in V['overlap']])
def test_overlap(v):
    assert overlaps(v['t'], v['t5'], v['dates']) is v['want']


def test_brier():
    for v in V['brier']:
        assert abs(brier(v['p'], v['o']) - v['want']) < 1e-12

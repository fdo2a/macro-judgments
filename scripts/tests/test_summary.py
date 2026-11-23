"""채점 요약 — 임시 git 레포에 실제 꼴의 파일을 만들고 상태·분모·Brier 를 확인한다."""
import json
import os
import shutil
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from seal import seal_hash  # noqa: E402
from summary import SummaryError, summarize, ts  # noqa: E402

NOW = ts('2027-02-01T00:00:00Z')
DEADLINE = '2026-12-11T01:00:00Z'


def put(repo, path, obj):
    p = os.path.join(repo, path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False)


def commit(repo, msg, when):
    env = dict(os.environ, GIT_AUTHOR_DATE=when, GIT_COMMITTER_DATE=when,
               GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@example.invalid', GIT_COMMITTER_NAME='t', GIT_COMMITTER_EMAIL='t@example.invalid')
    subprocess.run(['git', '-C', repo, 'add', '-A'], check=True, env=env)
    subprocess.run(['git', '-C', repo, 'commit', '-q', '-m', msg], check=True, env=env)


@pytest.fixture
def repo(tmp_path):
    r = str(tmp_path)
    subprocess.run(['git', 'init', '-q', r], check=True)
    os.makedirs(os.path.join(r, 'rules'))
    shutil.copy(os.path.join(ROOT, 'rules', 'v1.json'), os.path.join(r, 'rules', 'v1.json'))
    put(r, 'rules/schedule.json', {'rows': [
        {'kind': 'cpi', 't': '2026-12-10'},
        {'kind': 'employment', 't': '2027-01-08'},
        {'kind': 'cpi', 't': '2027-01-13'},
        {'kind': 'cpi', 't': '2027-01-14', 'cancelled': '2027-01-13 로 옮김(예시)'},
        {'kind': 'cpi', 't': '2027-03-10'},
    ]})
    put(r, 'rules/v1-base-rate.json', {'by_kind': {'cpi': {'persist_pct': 55}, 'employment': {'persist_pct': 50}}})
    commit(r, 'rules', '2026-11-30T00:00:00Z')
    return r


def seal(repo, eid, p, when, deadline_ok=True):
    plain = {'event': eid, 'model': 'claude-opus-5-5', 'p': p, 'prompt_sha256': 'a' * 64, 'reason': 'AI 근거', 'rule': 'v1'}
    nonce = '0f' * 32
    h = seal_hash(plain, nonce)
    put(repo, f'ai/{eid}/commit.json', {'event': eid, 'sha256': h})
    commit(repo, 'ai commit', when)
    return plain, nonce, h


def full_event(repo, ai_when='2026-12-10T23:01:00Z', tamper=False, reveal=True):
    eid = 'US-CPI-2026-12-10'
    put(repo, f'events/{eid}.json', {'event': eid, 'status': 'questioned', 'deadline_at': DEADLINE})
    put(repo, f'delivery/{eid}.json', {'event': eid, 'status': 'delivered'})
    put(repo, f'human/{eid}/aaaa.json', {'p': 65, 'message_date': '2026-12-10T23:30:00Z', 'received_at': '2026-12-10T23:30:01Z'})
    put(repo, f'human/{eid}/bbbb.json', {'p': 70, 'message_date': '2026-12-11T02:00:00Z', 'received_at': '2026-12-11T02:00:01Z'})
    commit(repo, 'event', '2026-12-10T23:00:00Z')
    plain, nonce, h = seal(repo, eid, 62, ai_when)
    if reveal:
        if tamper:
            plain = dict(plain, p=90)
        put(repo, f'ai/{eid}/reveal.json', {'sha256': h, 'plain': plain, 'nonce': nonce, 'served_model': 'claude-opus-5-5'})
    put(repo, f'outcomes/{eid}.json', {'status': 'scoreable', 'o': 1, 'overlap': False})
    put(repo, 'events/US-EMP-2027-01-08.json', {'event': 'US-EMP-2027-01-08', 'status': 'no_signal'})
    commit(repo, 'rest', '2026-12-18T00:00:00Z')


def test_states_and_scores(repo):
    full_event(repo)
    s = summarize(repo, NOW)
    c = s['result_counts']
    assert c['cpi']['채점 가능'] == 1 and c['cpi']['기록 없음'] == 1 and c['cpi']['취소'] == 1
    assert c['employment']['신호 없음'] == 1
    assert sum(c['cpi'].values()) == 3, '2027-03-10 은 아직 모집단이 아니다'
    sc = s['scores']['cpi']['all']
    assert sc['human']['n'] == 1 and sc['human']['brier'] == pytest.approx(0.1225)
    assert sc['ai']['n'] == 1 and sc['ai']['brier'] == pytest.approx(0.1444)
    assert sc['human']['baseline_climatology'] == pytest.approx(0.2025)
    assert sc['human']['baseline_always_persist'] == 0 and sc['human']['baseline_always_reverse'] == 1
    assert sc['head_to_head']['n'] == 1
    ev = next(e for e in s['events'] if e['event'] == 'US-CPI-2026-12-10')
    assert ev['human'] == {'state': '마감 전 제출', 'p': 65, 'submissions': 2}
    assert s['disagreements_20pp'] == []
    assert s['statement'].startswith('엣지 확인 안 됨')


def test_missing_base_rate_stops_once_scoreable(repo):
    os.remove(os.path.join(repo, 'rules', 'v1-base-rate.json'))
    s = summarize(repo, ts('2026-12-01T00:00:00Z'))
    assert s['base_rate_missing'] == ['cpi', 'employment']
    full_event(repo)
    with pytest.raises(SummaryError, match='기후값'):
        summarize(repo, NOW)


def test_ai_commit_after_deadline_is_late(repo):
    full_event(repo, ai_when='2026-12-11T01:30:00Z')
    s = summarize(repo, NOW)
    assert s['ai_late_only']['cpi'] == 1
    assert s['scores']['cpi']['all']['ai']['n'] == 0


def test_tampered_reveal_stops(repo):
    full_event(repo, tamper=True)
    with pytest.raises(SummaryError, match='지문'):
        summarize(repo, NOW)


def test_missing_reveal_after_outcome_stops(repo):
    full_event(repo, reveal=False)
    with pytest.raises(SummaryError, match='reveal'):
        summarize(repo, NOW)

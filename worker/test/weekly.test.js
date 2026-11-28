// 주말 돌아보기 글 — 이번 주 확인된 판단, 쓴 날, 바꾼 칸, 오래 기다리는 판단, 오래된 요약 경고.
import test from 'node:test';
import assert from 'node:assert/strict';
import RULES from '../../rules/topdown-v1.json' with { type: 'json' };
import { weeklyText, weeklyDue } from '../src/weekly.js';

test('토요일 07:00 KST 이후에만', () => {
  assert.equal(weeklyDue(Date.parse('2026-12-04T21:59:00Z')), null);          // 토 06:59 KST
  assert.equal(weeklyDue(Date.parse('2026-12-04T22:00:00Z')), '2026-12-05');  // 토 07:00 KST
  assert.equal(weeklyDue(Date.parse('2026-12-05T16:00:00Z')), null);          // 일 01:00 KST
});

test('주간 글', () => {
  const now = Date.parse('2026-12-04T22:15:00Z');
  const summary = {
    generated_at: '2026-12-04T12:20:00Z',
    days: [
      { t: '2026-11-30', written: true, critique: { ok: 2, failed: 1 }, first_entry: '보고서 전', cells: { bonds: { first: '불리', last: '우호', after_critique: true, after_report: false } } },
      { t: '2026-12-01', written: false, critique: { ok: 0, failed: 0 }, first_entry: null, cells: {} },
    ],
    judgments: [
      { cell: 'growth', value: '약해짐', state: 'closed', verdict: '틀림', outcome: '그대로', opened_at: '2026-11-03T21:40:00Z', check_at: '2026-12-04T13:30:00Z', observed: { base: { value: '4.5' }, target: { value: '4.5' } } },
      { cell: 'bonds', value: '불리', state: 'closed', verdict: '바뀜', opened_at: '2026-11-20T21:40:00Z', check_at: '2026-11-30T23:30:00Z' },
      { cell: 'fomc', value: '동결', state: 'closed', verdict: '맞음', opened_at: '2026-10-01T21:40:00Z', check_at: '2026-10-28T18:00:00Z' },
    ],
    overdue: [{ cell: 'inflation', opened_at: '2026-10-01T21:40:00Z', reason: '다음 발표 전' }],
    counts: { growth: { 맞음: 0, 틀림: 1, '조건 깨짐': 0 }, bonds: { 맞음: 2, 틀림: 0, '조건 깨짐': 1 } },
  };
  const t = weeklyText(summary, RULES, now);
  assert.match(t, /^\[탑다운\] 주간 돌아보기 \(11\/30-12\/1\)/);
  assert.match(t, /쓴 날 1\/2 · 첨삭 실패 1건/);
  assert.match(t, /바꾼 칸: 첨삭 뒤 1 · 보고서 뒤 0/);
  assert.match(t, /· 성장 약해짐 \(11\/3에 연 판단\) — 틀림: 실업률 4\.5→4\.5% → 실제 그대로/);
  assert.doesNotMatch(t, /바뀜/, '바뀜은 확인된 판단이 아니다');
  assert.doesNotMatch(t, /FOMC 동결/, '지난주 이전 확인은 이번 주 목록에 없다');
  assert.match(t, /자료를 오래 기다리는 판단:\n· 물가 \(10\/1에 연 판단\) — 다음 발표 전/);
  assert.match(t, /지금까지 맞음\/판정: 성장 0\/1 · 채권 2\/2 \(조건 깨짐 1\)/);
  assert.doesNotMatch(t, /요약이 오래됐어요/);
  assert.match(weeklyText({ ...summary, generated_at: '2026-12-02T00:00:00Z' }, RULES, now), /⚠️ 요약이 오래됐어요/);
});

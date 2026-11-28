// 칸 읽기 — 정해진 값 낱말일 때만 칸, 조건 원문, 받지 않는 칸, '네' 승인.
import test from 'node:test';
import assert from 'node:assert/strict';
import RULES from '../../rules/topdown-v1.json' with { type: 'json' };
import { parseEntry, parseApproval, cellLines } from '../src/cells.js';

const OPEN = structuredClone(RULES);
OPEN.cells.equities.band = { lo: -1.2, hi: 2.1 };
OPEN.cells.dollar.band = { lo: -0.8, hi: 0.7 };

test('칸 줄과 자유 글을 가른다', () => {
  const text = [
    '고용이 식는데 물가는 끈적하다.',
    '채권 시장이 약하다 — 이건 칸이 아니다',
    '성장 약해짐',
    '물가: 그대로',
    'FOMC 동결',
    '채권 우호 조건: 10년물 4.50% 넘으면 틀림',
  ].join('\n');
  const r = parseEntry(text, RULES);
  assert.deepEqual(r.cells, { growth: '약해짐', inflation: '그대로', fomc: '동결', bonds: '우호' });
  assert.deepEqual(r.conditions, { bonds: '10년물 4.50% 넘으면 틀림' });
  assert.deepEqual(r.closed, []);
});

test('값 낱말 뒤가 다른 글자로 이어지면 칸이 아니다', () => {
  assert.deepEqual(parseEntry('채권 우호적인 흐름', RULES).cells, {});
  assert.deepEqual(parseEntry('성장그대로', RULES).cells, { growth: '그대로' });
  assert.deepEqual(parseEntry('채권 중립, 이유는 위에', RULES).cells, { bonds: '중립' });
  assert.deepEqual(parseEntry('채권 우호: 금리 하락 예상', RULES).cells, { bonds: '우호' });
  assert.deepEqual(parseEntry('채권 우호 전망은 아직 이르다', RULES).cells, {});
  assert.deepEqual(parseEntry('채권 우호 조건: 4.5% 넘으면', RULES).conditions, { bonds: '4.5% 넘으면' });
  assert.deepEqual(parseEntry('fomc 인하', RULES).cells, { fomc: '인하' });
});

test('경계 전에는 주식·달러를 받지 않는다', () => {
  const r = parseEntry('주식 우호\n달러 약세\n채권 불리', RULES);
  assert.deepEqual(r.cells, { bonds: '불리' });
  assert.deepEqual(r.closed, ['equities', 'dollar']);
  const o = parseEntry('주식 우호\n달러 약세', OPEN);
  assert.deepEqual(o.cells, { equities: '우호', dollar: '약세' });
});

test('같은 칸이 두 번이면 뒤의 것, 조건 없는 뒤 줄은 조건도 지운다', () => {
  const r = parseEntry('채권 우호 조건: 4.5% 넘으면\n채권 중립', RULES);
  assert.deepEqual(r.cells, { bonds: '중립' });
  assert.deepEqual(r.conditions, {});
});

test("'네' 승인", () => {
  assert.deepEqual(parseApproval('네'), { all: true });
  assert.deepEqual(parseApproval(' 네. '), { all: true });
  assert.deepEqual(parseApproval('네 1 3'), { nums: [1, 3] });
  assert.deepEqual(parseApproval('네 3,1'), { nums: [1, 3] });
  assert.equal(parseApproval('네 그런데 하나만'), null);
  assert.equal(parseApproval('아니요'), null);
});

test('지금 칸 줄', () => {
  const lines = cellLines(RULES, { bonds: { value: '우호', cond: { raw: 'x', approved: { restated: '재무부 10년물이 4.50% 를 넘으면 틀림' } } }, growth: { value: '약해짐', cond: { raw: '실업률 4.6 넘으면', approved: null } } });
  assert.deepEqual(lines, [
    '성장 약해짐 · 조건 원문(승인 전): 실업률 4.6 넘으면',
    '물가 (비어 있음)',
    'FOMC (비어 있음)',
    '채권 우호 · 조건: 재무부 10년물이 4.50% 를 넘으면 틀림',
    '주식 — 아직 받지 않는 칸',
    '달러 — 아직 받지 않는 칸',
  ]);
});

test('칸 이름·값으로 시작하지만 칸 꼴이 아닌 줄은 칸으로 읽지 않고 따로 모은다(near)', () => {
  const prose = '채권 우호 조건부로만 보는 게 맞다.';
  const noColon = '채권 우호 조건 10년물 4.5% 넘으면';
  const r = parseEntry(['채권 시장이 약하다', prose, noColon, '채권 우호 전망은 아직 이르다', '성장 약해짐'].join('\n'), RULES);
  assert.deepEqual(r.cells, { growth: '약해짐' });
  assert.deepEqual(r.conditions, {});
  assert.deepEqual(r.near, [prose, noColon, '채권 우호 전망은 아직 이르다']);
});

test('조건은 값 바로 뒤(구분 기호 하나까지)의 「조건:」만이다', () => {
  const a = parseEntry('채권 중립, 이유는 조건이 안 맞아서', RULES);
  assert.deepEqual([a.cells, a.conditions, a.near], [{ bonds: '중립' }, {}, []]);
  assert.deepEqual(parseEntry('채권 우호, 조건: 4.5% 넘으면', RULES).conditions, { bonds: '4.5% 넘으면' });
  assert.deepEqual(parseEntry('채권 우호 조건：4.5% 넘으면', RULES).conditions, { bonds: '4.5% 넘으면' });
});

test('지금 칸 줄 — 긴 조건 원문은 잘라 보인다', () => {
  const lines = cellLines(RULES, { bonds: { value: '우호', cond: { raw: '가'.repeat(4000), approved: null } } });
  assert.ok(lines[3].length < 260 && lines[3].endsWith('…'));
});

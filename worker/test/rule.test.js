// 규칙 v1 계산 — rules/test-vectors.json 의 공통 예제를 Python 쪽과 함께 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toBp, seriesFrom, signalAt, outcomeAfter, overlaps, brier } from '../src/rule.js';

const V = JSON.parse(readFileSync(new URL('../../rules/test-vectors.json', import.meta.url), 'utf8'));

test('toBp — 재무부 글자를 정수 bp 로, 빈 칸·N/A 는 null', () => {
  assert.equal(toBp('3.61'), 361);
  assert.equal(toBp('4.6'), 460);
  assert.equal(toBp(' 0.05 '), 5);
  assert.equal(toBp(''), null);
  assert.equal(toBp('N/A'), null);
  assert.equal(toBp(undefined), null);
});

for (const v of V.signal) {
  test(`신호 — ${v.name}`, () => {
    assert.deepEqual(signalAt(seriesFrom(v.series), v.t), v.want);
  });
}
for (const v of V.outcome) {
  test(`결과 — ${v.name}`, () => {
    assert.deepEqual(outcomeAfter(seriesFrom(v.series), v.t, v.d0), v.want);
  });
}
for (const v of V.overlap) {
  test(`겹침 — ${v.name}`, () => {
    assert.equal(overlaps(v.t, v.t5, v.dates), v.want);
  });
}
test('Brier', () => {
  for (const v of V.brier) assert.ok(Math.abs(brier(v.p, v.o) - v.want) < 1e-12, JSON.stringify(v));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseReply, hmacHex, sha256Hex, canonical, sealHash, etInstant, etDate, addDays, eventId } from '../src/util.js';

test('답장 읽기 — 첫 줄 확률, 둘째 줄부터 근거(원문 그대로)', () => {
  assert.deepEqual(parseReply('65%\n근거'), { ok: true, p: 65, reason: '근거' });
  assert.deepEqual(parseReply(' 65 \n근거 한 줄\n  둘째 줄 '), { ok: true, p: 65, reason: '근거 한 줄\n  둘째 줄 ' });
  assert.deepEqual(parseReply('0\nx'), { ok: true, p: 0, reason: 'x' });
  assert.deepEqual(parseReply('100 %\nx'), { ok: true, p: 100, reason: 'x' });
  assert.equal(parseReply('65').ok, false);
  assert.equal(parseReply('65\n   \n').ok, false);
  assert.equal(parseReply('101\nx').ok, false);
  assert.equal(parseReply('65.5\nx').ok, false);
  assert.equal(parseReply('육십오\nx').ok, false);
  assert.equal(parseReply('').ok, false);
  assert.equal(parseReply(undefined).ok, false);
});

test('HMAC-SHA256 표준 예제', async () => {
  assert.equal(await hmacHex('key', 'The quick brown fox jumps over the lazy dog'),
    'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
});

test('봉인 지문 — Python 과 같은 값(rules/seal-vector.json)', async () => {
  const v = JSON.parse(readFileSync(new URL('../../rules/seal-vector.json', import.meta.url), 'utf8'));
  assert.equal(canonical(v.plain), v.canonical);
  assert.equal(await sealHash(v.plain, v.nonce), v.sha256);
  assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('미국 동부 시각 — 겨울·여름·서머타임 시작일', () => {
  assert.equal(new Date(etInstant('2026-11-24', 12, 0)).toISOString(), '2026-11-24T17:00:00.000Z');
  assert.equal(new Date(etInstant('2026-07-10', 8, 30)).toISOString(), '2026-07-10T12:30:00.000Z');
  assert.equal(new Date(etInstant('2026-03-08', 12, 0)).toISOString(), '2026-03-08T16:00:00.000Z');
  assert.equal(new Date(etInstant('2026-11-01', 12, 0)).toISOString(), '2026-11-01T17:00:00.000Z');
  assert.equal(etDate(Date.parse('2026-11-11T03:00:00Z')), '2026-11-10');
  assert.equal(etDate(Date.parse('2026-11-11T06:00:00Z')), '2026-11-11');
  assert.equal(addDays('2026-12-28', 14), '2027-01-11');
});

test('사건 ID', () => {
  assert.equal(eventId('cpi', '2026-12-10'), 'US-CPI-2026-12-10');
  assert.equal(eventId('employment', '2026-12-04'), 'US-EMP-2026-12-04');
});

// 상태 기계 — 질문·답장·봉인·공개·결과의 정상 경로와 멈추고 알리는 경로.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, aiOk, OWNER } from '../testlib/world.js';
import { sealHash } from '../src/util.js';
import { TICK_MS } from '../src/core.js';

const T = '2026-12-10'; // 목요일 CPI
const ID = 'US-CPI-2026-12-10';
const base = (over = {}) => world({
  schedule: { rows: [{ kind: 'cpi', t: T }, { kind: 'employment', t: '2027-01-08' }] },
  fomc: ['2026-12-09', '2027-01-27'],
  yields: { '2026-12-08': '4.58', '2026-12-09': '4.60' },
  ...over,
});
const after5 = { '2026-12-11': '4.66', '2026-12-14': '4.67', '2026-12-15': '4.70', '2026-12-16': '4.68', '2026-12-17': '4.69' };

async function toQ(w) {
  w.ai.body = aiOk(62, 'AI 근거');
  w.at('2026-12-10T13:00:00Z'); await w.tick();          // 08:00 ET — 아직 아무것도 안 한다
  assert.equal(w.paths('events/').length, 0);
  w.released[10] = [T];
  w.at('2026-12-10T14:00:00Z'); await w.tick();          // 09:00 ET — 발표 확인, 재무부 값 아직 없음
  assert.equal(w.paths('events/').length, 0);
  w.yields[T] = '4.65';
  w.at('2026-12-10T23:00:00Z'); await w.tick();          // 18:00 ET — Q
  return Date.parse('2026-12-10T23:00:00Z');
}

test('정상 경로 — Q 에 사건·질문·전달·AI 봉인, 답장 저장, 마감 뒤 공개, t+5 뒤 결과', async () => {
  const w = base();
  const q = await toQ(w);
  const ev = w.file(`events/${ID}.json`);
  assert.equal(ev.status, 'questioned');
  assert.deepEqual([ev.y_tm1, ev.y_t, ev.d0, ev.tm1], [460, 465, 5, '2026-12-09']);
  assert.equal(ev.q_at, '2026-12-10T23:00:00Z');
  assert.equal(ev.deadline_at, '2026-12-11T01:00:00Z');
  assert.equal(ev.confirm.source, 'fred');
  assert.equal(ev.ai_brief_published_at, null, 'Q(18:00 ET)에는 사이트 브리프가 아직 없다');
  assert.equal(ev.packet.recent.at(-1)[0], T);
  assert.match(w.sent[0], /사건: US-CPI-2026-12-10/);
  assert.match(w.sent[0], /4\.60% → 12-10 4\.65% \(\+5bp\)/);
  assert.equal(w.file(`delivery/${ID}.json`).status, 'delivered');
  const commit = w.file(`ai/${ID}/commit.json`);
  assert.match(commit.sha256, /^[0-9a-f]{64}$/);
  assert.equal(w.file(`ai/${ID}/reveal.json`), null, '마감 전에는 평문을 공개하지 않는다');

  // 사람 답장(마감 전) — 원문 그대로, 텔레그램 번호 없음
  await w.at('2026-12-10T23:30:00Z').reply(1001, ' 65%\n근거 한 줄\n둘째 줄');
  const hp = w.paths(`human/${ID}/`);
  assert.equal(hp.length, 1);
  const h = w.file(hp[0]);
  assert.equal(h.text, ' 65%\n근거 한 줄\n둘째 줄');
  assert.equal(h.p, 65);
  assert.equal(h.on_time, true);
  assert.equal(JSON.stringify(h).includes(String(OWNER)), false);
  assert.equal(JSON.stringify(h).includes('1001'), false);
  assert.match(w.sent.at(-1), /^기록 완료 · US-CPI-2026-12-10 · 지속 확률 65% · 마감 전/);

  // 같은 update 재전송 — 파일은 하나
  await w.reply(1001, ' 65%\n근거 한 줄\n둘째 줄');
  assert.equal(w.paths(`human/${ID}/`).length, 1);
  assert.match(w.sent.at(-1), /^이미 기록됨/);

  // 마감 뒤 알람 — 공개, 해시가 맞는다
  w.at('2026-12-11T01:15:00Z'); await w.tick();
  const rv = w.file(`ai/${ID}/reveal.json`);
  assert.equal(rv.plain.p, 62);
  assert.equal(await sealHash(rv.plain, rv.nonce), commit.sha256);
  assert.equal(rv.served_model, 'claude-opus-5-5');
  assert.equal(w.aiCalls, 1);

  // 마감 뒤 답장 — 저장하되 마감 후
  await w.at('2026-12-11T02:00:00Z').reply(1002, '70\n늦은 답');
  const late = w.paths(`human/${ID}/`).map(w.file).find((r) => r.p === 70);
  assert.equal(late.on_time, false);

  // t+5 값이 다 오면 결과
  Object.assign(w.yields, after5);
  w.at('2026-12-17T23:00:00Z'); await w.tick();
  const out = w.file(`outcomes/${ID}.json`);
  assert.deepEqual([out.status, out.t5, out.d5, out.o, out.overlap], ['scoreable', '2026-12-17', 4, 1, false]);
  assert.equal(out.ai_brief_published_at, '2026-12-11T00:10:00Z', '결과 확정 때 다시 조회한다');
  assert.equal((await w.storage.get(`ev:${ID}`)).final, 'done');
  // 끝난 뒤 답장은 열린 질문 없음
  await w.reply(1003, '50\nx');
  assert.match(w.sent.at(-1), /열린 질문이 없습니다/);
  assert.ok(q > 0);
});

test('겹침 — t+5 안의 FOMC 결정일', async () => {
  const w = base({ fomc: ['2026-12-16'] });
  await toQ(w);
  Object.assign(w.yields, after5);
  w.at('2026-12-17T23:00:00Z'); await w.tick();
  assert.equal(w.file(`outcomes/${ID}.json`).overlap, true);
});

test('webhook — 비밀값·보낸 사람·형식을 가린다', async () => {
  const w = base();
  await toQ(w);
  const n = w.sent.length;
  assert.equal((await w.reply(2001, '65\nx', { secret: 'nope' })).status, 401);
  assert.equal((await w.reply(2002, '65\nx', { from: 1 })).status, 200);
  assert.equal((await w.reply(2003, '65\nx', { type: 'group' })).status, 200);
  assert.equal(w.sent.length, n, '남의 메시지에는 답하지 않는다');
  await w.reply(2004, '육십오\n근거');
  assert.match(w.sent.at(-1), /형식이 맞지 않아/);
  await w.reply(2005, '65');
  assert.match(w.sent.at(-1), /no_reason/);
  assert.equal(w.paths('human/').length, 0);
});

test('열린 질문이 없을 때 답장', async () => {
  const w = base();
  w.at('2026-12-01T00:00:00Z');
  await w.reply(3001, '65\nx');
  assert.match(w.sent.at(-1), /열린 질문이 없습니다/);
  assert.equal(w.paths('human/').length, 0);
});

test('저장 응답이 애매하면 보관 중 → 다음 알람에서 저장하고 알린다', async () => {
  const w = base();
  await toQ(w);
  w.putFail.push({ match: 'human/', status: 502, store: false });
  await w.at('2026-12-10T23:20:00Z').reply(4001, '60\n근거');
  assert.match(w.sent.at(-1), /^보관 중/);
  assert.equal(w.paths('human/').length, 0);
  w.at('2026-12-10T23:30:00Z'); await w.tick();
  assert.equal(w.paths('human/').length, 1);
  assert.equal(w.file(w.paths('human/')[0]).on_time, true, '마감 판정은 텔레그램 시각');
  assert.match(w.sent.at(-1), /^기록 완료/);
});

test('502 인데 실제로는 저장됨 — 읽어서 확정, 한 번만', async () => {
  const w = base();
  await toQ(w);
  w.putFail.push({ match: 'human/', status: 502, store: true });
  await w.at('2026-12-10T23:20:00Z').reply(4101, '60\n근거');
  assert.match(w.sent.at(-1), /^이미 기록됨/);
  assert.equal(w.paths('human/').length, 1);
});

test('발표 미확인 — t+1 12:00 ET 에 보류로 확정하고 한 번만 알린다', async () => {
  const w = base();
  w.yields[T] = '4.65';
  w.at('2026-12-10T23:00:00Z'); await w.tick();
  assert.equal(w.paths('events/').length, 0);
  w.at('2026-12-11T17:00:00Z'); await w.tick();
  w.at('2026-12-11T17:15:00Z'); await w.tick();
  assert.equal(w.file(`events/${ID}.json`).status, 'held_unconfirmed');
  assert.equal(w.sent.filter((s) => s.includes('보류: 발표 미확인')).length, 1);
  assert.equal(w.paths('delivery/').length + w.paths('ai/').length, 0);
});

test('시리즈 결측 — 발표는 확인됐는데 t 값이 기한까지 없음', async () => {
  const w = base({ released: { 10: [T] } });
  w.at('2026-12-11T17:00:00Z'); await w.tick();
  const ev = w.file(`events/${ID}.json`);
  assert.equal(ev.status, 'series_missing');
  assert.deepEqual(ev.missing, ['t']);
});

test('신호 없음 — 질문·AI 없이 사건 파일만', async () => {
  const w = base({ released: { 10: [T] } });
  w.yields[T] = '4.60';
  w.at('2026-12-10T23:00:00Z'); await w.tick();
  assert.equal(w.file(`events/${ID}.json`).status, 'no_signal');
  assert.equal(w.sent.length, 0);
  assert.equal(w.aiCalls, 0);
  assert.equal((await w.storage.get(`ev:${ID}`)).final, 'done');
});

test('질문 실패 — 마감까지 전송 실패면 전달 실패로 기록, AI 는 그대로', async () => {
  const w = base();
  w.telegramFail = (text) => text.startsWith('[매크로 판단]');
  await toQ(w);
  assert.equal(w.file(`delivery/${ID}.json`), null);
  w.at('2026-12-11T01:15:00Z'); await w.tick();
  assert.equal(w.file(`delivery/${ID}.json`).status, 'failed');
  assert.ok(w.file(`ai/${ID}/reveal.json`));
  assert.ok(w.sent.some((s) => s.includes('질문 실패')));
});

test('AI 거절 — 기권 파일과 알림, 사람 흐름은 그대로', async () => {
  const w = base();
  w.released[10] = [T]; w.yields[T] = '4.65';
  w.ai.body = { ...aiOk(), stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'bio' }, content: [] };
  w.at('2026-12-10T23:00:00Z'); await w.tick();
  assert.equal(w.file(`ai/${ID}/missing.json`).reason, 'refusal:bio');
  assert.equal(w.file(`ai/${ID}/commit.json`), null);
  assert.ok(w.sent.some((s) => s.includes('AI 예측 기권')));
  assert.equal(w.file(`delivery/${ID}.json`).status, 'delivered');
});

test('값 부족 — t+14일 12:00 ET 까지 5개가 안 되면 보류', async () => {
  const w = base();
  await toQ(w);
  w.yields['2026-12-11'] = '4.66';
  w.at('2026-12-24T16:00:00Z'); await w.tick();
  assert.equal(w.file(`outcomes/${ID}.json`), null);
  w.at('2026-12-24T17:00:00Z'); await w.tick();
  const out = w.file(`outcomes/${ID}.json`);
  assert.deepEqual([out.status, out.have], ['value_shortage', 1]);
});

test('알람 사슬 — 처리 중 예외가 나도 다음 알람은 이미 걸려 있다', async () => {
  const w = base();
  w.at('2026-12-10T23:00:00Z');
  w.core.tick = async () => { throw new Error('boom'); };
  await w.tick();
  assert.equal(await w.storage.getAlarm(), w.t + TICK_MS);
  assert.ok(w.sent.some((s) => s.includes('boom')));
});

test('일정이 바닥나면(앞으로 45일 안에 줄 없음) 하루 한 번 알린다', async () => {
  const w = base();
  w.files.set('rules/schedule.json', JSON.stringify({ rows: [{ kind: 'cpi', t: '2026-11-10' }] }));
  w.at('2026-12-10T23:00:00Z'); await w.tick();
  w.at('2026-12-10T23:15:00Z'); await w.tick();
  assert.equal(w.sent.filter((s) => s.includes('앞으로 45일')).length, 1);
  const ok = base();
  ok.at('2026-12-01T23:00:00Z'); await ok.tick();
  assert.equal(ok.sent.filter((s) => s.includes('앞으로 45일')).length, 0);
});

test('캐시가 지난 뒤 다시 못 읽으면 옛 사본으로 진행하되 알린다', async () => {
  const w = base();
  w.at('2026-12-01T23:00:00Z'); await w.tick();
  w.files.delete('rules/schedule.json');
  w.at('2026-12-02T08:00:00Z'); await w.tick();
  assert.ok(w.sent.some((s) => s.includes('rules/schedule.json 를 새로 읽지 못해')));
});

test('일정 파일을 못 읽으면 알리고 아무것도 하지 않는다', async () => {
  const w = base();
  w.files.delete('rules/schedule.json');
  w.at('2026-12-10T23:00:00Z'); await w.tick();
  assert.ok(w.sent[0].includes('일정 파일'));
  assert.equal(w.paths('events/').length, 0);
});

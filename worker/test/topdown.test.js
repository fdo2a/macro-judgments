// 탑다운 일지 — 아침 질문, 글(칸·기준), 첨삭, 조건 승인, 보고서 대조, 다음 하루. 정상 경로와 멈추고 알리는 경로.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, OWNER } from '../testlib/world.js';

const TD = { V1_ENABLED: '0', TOPDOWN_ENABLED: '1' };
const FRED = {
  SP500: [['2026-11-25', '6800.10'], ['2026-11-26', '.'], ['2026-11-27', '6810.50']],
  DTWEXBGS: [['2026-11-20', '121.30']],
  UNRATE: [['2026-09-01', '4.4'], ['2026-10-01', '4.5']],
  CPILFESL: [['2026-09-01', '330.100'], ['2026-10-01', '331.000']],
  DFEDTARU: [['2026-11-29', '4.50']],
};
// 11/25 앞의 평일 20개 — 꾸러미의 「최근 20 관측」이 찬다
const HIST = (() => {
  const out = {};
  for (let d = Date.parse('2026-11-24T00:00:00Z'); Object.keys(out).length < 20; d -= 86400e3) {
    const day = new Date(d).getUTCDay();
    if (day !== 0 && day !== 6) out[new Date(d).toISOString().slice(0, 10)] = '3.60';
  }
  return out;
})();
const base = (over = {}) => world({
  env: TD,
  schedule: { rows: [{ kind: 'cpi', t: '2026-12-10' }, { kind: 'employment', t: '2026-12-04' }] },
  fomc: ['2026-10-28', '2026-12-09'],
  yields: { ...HIST, '2026-11-25': '3.50', '2026-11-27': '3.52' },
  yields10: { ...HIST, '2026-11-25': '4.10', '2026-11-27': '4.12' },
  fred: FRED,
  ...over,
});
const aiCrit = (questions, conditions = []) => ({
  id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
  content: [{ type: 'text', text: JSON.stringify({ questions, conditions }) }],
  stop_reason: 'end_turn', stop_details: null, usage: { input_tokens: 1, output_tokens: 1 },
});
const T = '2026-11-30';

// 11/30(월) 16:00 ET 에 재무부 값이 보인다 → 하루를 연다
async function openDay(w) {
  w.at('2026-11-30T19:00:00Z'); await w.tick();          // 14:00 ET — 첫 알람, 지난 값(11/27)으로 하루를 연다
  assert.equal(await w.storage.get('td:lastT'), '2026-11-27');
  w.yields[T] = '3.55'; w.yields10[T] = '4.08';
  w.at('2026-11-30T21:15:00Z'); await w.tick();          // 16:15 ET
  assert.equal(await w.storage.get('td:lastT'), T);
}

test('정상 경로 — 아침 질문, 글과 기준, 첨삭, 승인, 보고서 대조, 다음 하루', async () => {
  const w = base();
  await openDay(w);
  const q = w.file(`topdown/days/${T}/question.json`);
  assert.equal(q.status, 'sent');
  assert.deepEqual([q.treasury.y10, q.treasury.prev.y10], ['4.08', '4.12']);
  const qText = w.sent.find((s) => s.startsWith('[탑다운] 11/30'));
  assert.match(qText, /10년물 4\.08% \(−4bp\) · 2년물 3\.55% \(\+3bp\)/);
  assert.match(qText, /주식 — 아직 받지 않는 칸/);

  // 글 — 칸 둘, 조건 하나, 자유 글
  const text = '고용이 식는데 물가는 끈적하다.\n채권 시장은 아직 모른다\n성장 약해짐\n채권 우호 조건: 10년물 4.50% 넘으면 틀림';
  w.at('2026-11-30T21:40:00Z');
  await w.reply(5001, text);
  const ep = w.paths(`topdown/entries/${T}/`);
  assert.equal(ep.length, 1);
  const e = w.file(ep[0]);
  assert.equal(e.text, text);
  assert.deepEqual(e.cells, { growth: '약해짐', bonds: '우호' });
  assert.deepEqual(e.conditions, { bonds: '10년물 4.50% 넘으면 틀림' });
  assert.deepEqual(e.base.treasury10, { date: T, value: '4.08' });
  assert.equal(e.base.sp500.date, '2026-11-27', '결측 줄(.)은 관측이 아니다');
  assert.equal(e.base.cpilfesl.length, 2);
  assert.equal(e.base.unrate.value, '4.5');
  assert.equal(e.base.fomc_last, '2026-10-28');
  assert.equal(e.base.fomc_next, '2026-12-09');
  assert.deepEqual(e.base_missing, []);
  assert.equal(JSON.stringify(e).includes(String(OWNER)), false);
  assert.equal(JSON.stringify(e).includes('5001'), false);
  const done = w.sent.at(-1);
  assert.match(done, /^기록 완료 · 11\/30 글/);
  assert.match(done, /읽은 칸: 성장 약해짐\(조건 없음\) · 채권 우호\(조건 원문: 10년물 4\.50% 넘으면 틀림\)/);
  assert.equal(w.storage.alarmAt, Date.parse('2026-11-30T21:40:05Z'), '첨삭하려고 알람을 당긴다');

  // 첨삭 — 알람에서
  w.ai.body = aiCrit(['고용 둔화가 왜 채권 우호로 바로 가나요?', '물가가 끈적하면 반대 경로는?'],
    [{ cell: 'bonds', ok: true, series: 'treasury10', op: 'gt', value: 4.5, restated: '재무부 10년물이 4.50% 를 넘으면 틀림' }]);
  w.at('2026-11-30T21:40:05Z'); await w.tick();
  assert.equal(w.aiCalls, 1);
  const cp = w.paths(`topdown/critique/${T}/`);
  assert.equal(cp.length, 1);
  const c = w.file(cp[0]);
  assert.equal(c.status, 'ok');
  assert.equal(c.entry, ep[0].split('/').pop().replace('.json', ''));
  assert.equal(c.questions.length, 2);
  assert.equal(c.packet.next.fomc, '2026-12-09');
  assert.equal(c.packet.next.employment, '2026-12-04');
  assert.equal(c.cells.bonds.value, '우호');
  assert.match(c.input_sha256, /^[0-9a-f]{64}$/);
  const ct = w.sent.find((s) => s.startsWith('첨삭 ('));
  assert.match(ct, /1\. 고용 둔화가/);
  assert.match(ct, /\(1\) 채권 — 재무부 10년물 4\.5% 초과이면 틀림\n맞으면 '네'/);
  assert.equal(w.storage.alarmAt, Date.parse('2026-11-30T21:55:05Z'), '15분 사슬로 돌아간다');

  // 승인
  w.at('2026-11-30T21:45:00Z');
  await w.reply(5002, '네');
  const ap = w.paths(`topdown/approvals/${T}/`);
  assert.equal(ap.length, 1);
  const a = w.file(ap[0]);
  assert.deepEqual(a.approved.map((x) => [x.cell, x.series, x.op, x.value, x.raw]), [['bonds', 'treasury10', 'gt', 4.5, '10년물 4.50% 넘으면 틀림']]);
  assert.equal(a.approved[0].entry, c.entry);
  assert.equal(a.approved[0].entry_t, T, '승인 파일만으로 원글 경로(날짜/글)를 찾는다');
  assert.match(w.sent.at(-1), /^기록 완료 · 11\/30 조건 승인\n조건 승인: 채권 — 재무부 10년물 4\.5% 초과이면 틀림/);
  assert.equal(w.paths(`topdown/entries/${T}/`).length, 1, "'네'는 글로 남기지 않는다");

  // 보고서 — 다음 날 아침 KST(= 11/30 18:10 ET)
  w.site.posts[T] = { sha: 'abc123', at: '2026-11-30T23:10:00Z' };
  w.site.macro.abc123 = {
    report_date: T, horizon: '3-6개월',
    regime: { growth: 0, inflation: 1 },
    policy_path: { stance: '인상 리스크 우위' },
    transmission: { bonds: { direction: -1 }, equities: { direction: 0 }, fx: { direction: 0, channel: '달러 원문' } },
  };
  w.at('2026-11-30T23:15:00Z'); await w.tick();
  const rp = w.file(`topdown/reports/${T}.json`);
  assert.equal(rp.status, 'compared');
  assert.equal(rp.first_commit_sha, 'abc123', '가장 오래된 커밋');
  assert.deepEqual(rp.cells, { growth: '그대로', inflation: '재가속', bonds: '불리', equities: '중립' });
  assert.equal(rp.mine_at_compare.bonds.condition.approved.series, 'treasury10');
  const rt = w.sent.find((s) => s.startsWith('[탑다운] 11/30 보고서가'));
  assert.match(rt, /· 성장 — 나 약해짐 · 보고서 그대로/);
  assert.match(rt, /· 채권 — 나 우호 · 보고서 불리/);
  assert.match(rt, /내 칸이 비어 있음: 물가\(보고서 재가속\), 주식\(보고서 중립\)/);
  assert.match(rt, /정책 경로\(보고서 원문\): 인상 리스크 우위/);
  const nSent = w.sent.length;
  w.at('2026-11-30T23:30:00Z'); await w.tick();
  assert.equal(w.sent.filter((s) => s.startsWith('[탑다운] 11/30 보고서가')).length, 1, '보고서 대조는 한 번');

  // 다음 하루 — 12/1 값
  w.yields['2026-12-01'] = '3.56'; w.yields10['2026-12-01'] = '4.05';
  w.at('2026-12-01T21:15:00Z'); await w.tick();
  assert.equal(await w.storage.get('td:lastT'), '2026-12-01');
  const q2 = w.sent.slice(nSent).find((s) => s.startsWith('[탑다운] 12/1'));
  assert.match(q2, /성장 약해짐/);
  assert.match(q2, /채권 우호 · 조건: 재무부 10년물 4\.5% 초과이면 틀림/);
  assert.equal(w.file('topdown/days/2026-12-01/question.json').open_cells.bonds.condition.approved.value, 4.5);
});

test('같은 글을 텔레그램이 다시 보내도 기록·첨삭은 한 번', async () => {
  const w = base();
  await openDay(w);
  w.at('2026-11-30T21:40:00Z');
  await w.reply(6001, '채권 중립');
  await w.reply(6001, '채권 중립');
  assert.equal(w.paths(`topdown/entries/${T}/`).length, 1);
  assert.equal(w.sent.at(-1), '이미 받은 글이에요.');
  assert.equal((await w.storage.list({ prefix: 'td:crit:' })).size, 1);
});

test('칸이 아닌 글·받지 않는 칸은 칸으로 읽지 않고 그렇다고 답한다', async () => {
  const w = base();
  await openDay(w);
  w.at('2026-11-30T21:40:00Z');
  await w.reply(6101, '채권 우호적인 흐름이 이어진다\n주식 우호');
  const e = w.file(w.paths(`topdown/entries/${T}/`)[0]);
  assert.deepEqual(e.cells, {});
  assert.deepEqual(e.closed, ['equities']);
  assert.equal(e.base, null, '칸이 없으면 기준을 적지 않는다');
  assert.match(w.sent.at(-1), /칸 없음 — 글만 기록\n주식는 아직 받지 않는 칸이라 뺐어요/);
});

test('AI 가 문장과 다른 수치를 내도 사람에게는 저장할 수치로 보인다, 꾸러미 결측은 첨삭 답에 보인다', async () => {
  const w = base();
  await openDay(w);
  w.at('2026-11-30T21:40:00Z');
  await w.reply(6011, '채권 우호 조건: 10년물 4.50% 넘으면 틀림');
  w.fredFail.add('SP500');
  w.ai.body = aiCrit(['질문'], [{ cell: 'bonds', ok: true, series: 'treasury10', op: 'gt', value: 4.05, restated: '재무부 10년물이 4.50% 를 넘으면 틀림' }]);
  w.at('2026-11-30T21:40:05Z'); await w.tick();
  const ct = w.sent.find((s) => s.startsWith('첨삭 ('));
  assert.match(ct, /\(1\) 채권 — 재무부 10년물 4\.05% 초과이면 틀림/);
  assert.match(ct, /빠진 자료: sp500/);
  const c = w.file(w.paths(`topdown/critique/${T}/`)[0]);
  assert.deepEqual(c.packet.missing, ['sp500']);
  assert.equal(c.conditions[0].ai_restated, '재무부 10년물이 4.50% 를 넘으면 틀림');
});

test('기준 자료를 못 읽으면 비워 두고 알린다', async () => {
  const w = base();
  await openDay(w);
  w.fredFail.add('UNRATE');
  w.at('2026-11-30T21:40:00Z');
  await w.reply(6201, '성장 그대로');
  const e = w.file(w.paths(`topdown/entries/${T}/`)[0]);
  assert.equal(e.base.unrate, null);
  assert.deepEqual(e.base_missing, ['unrate']);
  assert.ok(w.sent.some((s) => s.startsWith('⚠️ 탑다운: 글을 받은 순간 기준 자료 unrate')));
});

test('첨삭 실패는 실패로 남기고 알린다', async () => {
  const w = base();
  await openDay(w);
  w.at('2026-11-30T21:40:00Z');
  await w.reply(6301, '물가 둔화');
  w.ai = { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'x' } } };
  w.at('2026-11-30T21:40:05Z'); await w.tick();
  const c = w.file(w.paths(`topdown/critique/${T}/`)[0]);
  assert.equal(c.status, 'failed');
  assert.match(c.reason, /^api:500/);
  assert.ok(w.sent.some((s) => /^첨삭 실패\(api:500\)/.test(s)));
  assert.equal((await w.storage.list({ prefix: 'td:crit:' })).size, 0);
});

test('해석을 못 한 조건은 승인 대상이 아니고, 칸을 바꾼 뒤의 승인은 받지 않는다', async () => {
  const w = base();
  await openDay(w);
  w.at('2026-11-30T21:40:00Z');
  await w.reply(6401, '채권 우호 조건: 분위기가 바뀌면\n성장 약해짐 조건: 실업률 4.7% 넘으면');
  w.ai.body = aiCrit(['질문'], [
    { cell: 'bonds', ok: false, series: 'treasury10', op: 'gt', value: 0, restated: '숫자 기준이 없어요.' },
    { cell: 'growth', ok: true, series: 'unrate', op: 'gt', value: 4.7, restated: '실업률이 4.7% 를 넘으면 틀림' },
  ]);
  w.at('2026-11-30T21:40:05Z'); await w.tick();
  const ct = w.sent.find((s) => s.startsWith('첨삭 ('));
  assert.match(ct, /\(1\) 성장 — 실업률\(첫 발표\) 4\.7% 초과이면 틀림/);
  assert.match(ct, /\(해석 못 함\) 채권 — 숫자 기준이 없어요\. 조건 없이 둡니다/);
  // 성장을 바꾼 뒤 '네'
  w.at('2026-11-30T21:50:00Z');
  await w.reply(6402, '성장 그대로');
  await w.reply(6403, '네');
  assert.equal(w.paths(`topdown/approvals/${T}/`).length, 0);
  assert.equal(w.sent.at(-1), '승인할 조건 해석이 없어요. 기록하지 않았습니다.');
});

test('보고서 판단 날짜가 다르면 대조하지 않는다', async () => {
  const w = base();
  await openDay(w);
  w.site.posts[T] = { sha: 'old1', at: '2026-11-30T23:10:00Z' };
  w.site.macro.old1 = { report_date: '2026-12-01', regime: { growth: 0, inflation: 0 }, transmission: {} };
  w.at('2026-11-30T23:15:00Z'); await w.tick();
  const rp = w.file(`topdown/reports/${T}.json`);
  assert.equal(rp.status, 'date_mismatch');
  assert.equal(rp.cells, null);
  assert.ok(w.sent.some((s) => /보고서 판단 대조 불가 — 그 커밋의 판단 날짜가 2026-12-01/.test(s)));
});

test('저장 실패 — 보관했다가 다음 알람에 저장하고 그때 「기록 완료」', async () => {
  const w = base();
  await openDay(w);
  w.putFail.push({ match: 'topdown/entries/', status: 502 });
  w.at('2026-11-30T21:40:00Z');
  await w.reply(6501, '채권 불리');
  assert.match(w.sent.at(-1), /^보관 중 — 자동으로 다시 저장합니다/);
  assert.equal(w.paths(`topdown/entries/${T}/`).length, 0);
  w.at('2026-11-30T21:41:00Z'); await w.tick();
  assert.equal(w.paths(`topdown/entries/${T}/`).length, 1);
  assert.ok(w.sent.some((s) => s.startsWith('기록 완료 · 11/30 글')));
});

test('글 저장이 확인되기 전에는 첨삭하지 않는다, 다음 CPI·고용 날짜가 없으면 빠진 자료로 보인다', async () => {
  const w = base({ schedule: { rows: [] } });
  await openDay(w);
  w.putFail.push({ match: 'topdown/entries/', status: 502 }, { match: 'topdown/entries/', status: 502 });
  w.at('2026-11-30T21:40:00Z');
  await w.reply(6511, '채권 불리');
  w.ai.body = aiCrit(['질문']);
  w.at('2026-11-30T21:40:05Z'); await w.tick();            // 저장 다시 실패 — 첨삭도 안 한다
  assert.equal(w.aiCalls, 0);
  assert.equal(w.paths(`topdown/critique/${T}/`).length, 0);
  w.at('2026-11-30T21:55:05Z'); await w.tick();            // 저장 성공 — 다음 알람에서 첨삭
  assert.equal(w.paths(`topdown/entries/${T}/`).length, 1);
  w.at('2026-11-30T22:10:05Z'); await w.tick();
  assert.equal(w.aiCalls, 1);
  const c = w.file(w.paths(`topdown/critique/${T}/`)[0]);
  assert.deepEqual(c.packet.missing, ['next_cpi', 'next_employment']);
});

test('첫 질문 전의 글은 기록하지 않는다', async () => {
  const w = base({ yields: {}, yields10: {} });
  w.at('2026-11-30T19:00:00Z'); await w.tick();
  await w.reply(6601, '채권 우호');
  assert.equal(w.sent.at(-1), '아직 첫 아침 질문 전이에요. 기록하지 않았습니다.');
  assert.equal(w.paths('topdown/entries/').length, 0);
});

test('v1 을 끄면 열린 v1 사건이 없어도 글은 탑다운으로 간다, 재무부는 하루 값이 있으면 다시 안 읽는다', async () => {
  const w = base();
  await openDay(w);
  let treasuryCalls = 0;
  const f = w.fetch;
  w.core.fetch = async (u, i) => { if (String(u).includes('home.treasury.gov')) treasuryCalls++; return f(u, i); };
  w.at('2026-11-30T22:00:00Z'); await w.tick();         // 17:00 ET, 오늘 값을 이미 봤다
  assert.equal(treasuryCalls, 0);
});

// ── 3회차(codex 6.2-sol) 지적 재현 ─────────────────────────────────────────
test('근원 CPI 최근 두 관측이 이어진 달이 아니면(2025-10 결측) 물가 기준을 비우고 알린다', async () => {
  const w = base({ fred: { ...FRED, CPILFESL: [['2025-09-01', '330.100'], ['2025-10-01', '.'], ['2025-11-01', '331.000']] } });
  await openDay(w);
  w.at('2026-11-30T21:40:00Z');
  await w.reply(7001, '물가 둔화');
  const e = w.file(w.paths(`topdown/entries/${T}/`)[0]);
  assert.equal(e.base.cpilfesl, null);
  assert.deepEqual(e.base_missing, ['cpilfesl']);
  assert.ok(w.sent.some((s) => s.startsWith('⚠️ 탑다운: 글을 받은 순간 기준 자료 cpilfesl')));
});

test("다른 메시지를 인용한 '네' 는 승인하지 않는다 — 가장 최근 첨삭을 인용했거나 인용 없는 '네' 만", async () => {
  const w = base();
  await openDay(w);
  w.at('2026-11-30T21:40:00Z');
  await w.reply(7101, '채권 우호 조건: 10년물 4.50% 넘으면 틀림');
  w.ai.body = aiCrit(['질문'], [{ cell: 'bonds', ok: true, series: 'treasury10', op: 'gt', value: 4.5, restated: 'x' }]);
  w.at('2026-11-30T21:40:05Z'); await w.tick();
  const idA = w.sent.findIndex((s) => s.startsWith('첨삭 (')) + 1;
  w.at('2026-11-30T21:50:00Z');
  await w.reply(7102, '성장 약해짐 조건: 실업률 4.7% 넘으면');
  w.ai.body = aiCrit(['질문'], [{ cell: 'growth', ok: true, series: 'unrate', op: 'gt', value: 4.7, restated: 'y' }]);
  w.at('2026-11-30T21:50:05Z'); await w.tick();
  const idB = w.sent.findLastIndex((s) => s.startsWith('첨삭 (')) + 1;
  assert.notEqual(idA, idB);
  w.at('2026-11-30T21:55:00Z');
  await w.reply(7103, '네', { replyTo: idA });
  assert.equal(w.paths(`topdown/approvals/${T}/`).length, 0, '옛 첨삭을 인용한 네 는 새 첨삭의 조건을 승인하지 않는다');
  assert.match(w.sent.at(-1), /기록하지 않았습니다/);
  await w.reply(7104, '네', { replyTo: idB });
  const ap = w.paths(`topdown/approvals/${T}/`);
  assert.equal(ap.length, 1);
  assert.deepEqual(w.file(ap[0]).approved.map((x) => x.cell), ['growth']);
  assert.equal(JSON.stringify(w.file(ap[0])).includes('reply'), false, '메시지 번호는 공개 파일에 넣지 않는다');
});

test('첨삭이 실패해도 꾸러미에서 빠진 자료를 보이고, 다음 FOMC 가 없으면 빠진 자료다', async () => {
  const w = base({ schedule: { rows: [] }, fomc: ['2026-10-28'] });
  await openDay(w);
  w.at('2026-11-30T21:40:00Z');
  await w.reply(7201, '채권 불리');
  w.ai = { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'x' } } };
  w.at('2026-11-30T21:40:05Z'); await w.tick();
  const c = w.file(w.paths(`topdown/critique/${T}/`)[0]);
  assert.deepEqual(c.packet.missing, ['next_cpi', 'next_employment', 'next_fomc']);
  const ft = w.sent.find((s) => s.startsWith('첨삭 실패('));
  assert.match(ft, /빠진 자료: next_cpi, next_employment, next_fomc/);
});

test('질문 파일 저장이 늦어져도 질문을 보낸 순간의 칸을 적는다', async () => {
  const w = base();
  w.putFail.push({ match: `topdown/days/${T}/`, status: 502 });
  await openDay(w);
  assert.equal(w.file(`topdown/days/${T}/question.json`), null);
  w.at('2026-11-30T21:20:00Z');
  await w.reply(7301, '채권 불리');
  w.at('2026-11-30T21:30:00Z'); await w.tick();
  assert.deepEqual(w.file(`topdown/days/${T}/question.json`).open_cells, {});
});

test('칸 꼴이 아닌 줄은 답에 보이고, 긴 조건 원문은 답·아침 질문에서 잘라 보인다(기록은 원문 그대로)', async () => {
  const w = base();
  await openDay(w);
  w.at('2026-11-30T21:40:00Z');
  await w.reply(7401, '채권 우호 조건 10년물 4.5% 넘으면');
  assert.match(w.sent.at(-1), /칸으로 읽지 않은 줄: 「채권 우호 조건 10년물 4\.5% 넘으면」/);
  assert.deepEqual(w.file(w.paths(`topdown/entries/${T}/`)[0]).cells, {});
  const long = '10년물 4.50% 넘으면 틀림 ' + '가'.repeat(3900);
  w.at('2026-11-30T21:41:00Z');
  await w.reply(7402, `채권 우호 조건: ${long}`);
  const done = w.sent.at(-1);
  assert.match(done, /^기록 완료/);
  assert.ok(done.length < 1000);
  assert.equal(w.file(w.paths(`topdown/entries/${T}/`).find((p) => w.file(p).cells.bonds)).conditions.bonds, long);
  w.yields['2026-12-01'] = '3.56'; w.yields10['2026-12-01'] = '4.05';
  w.at('2026-12-01T21:15:00Z'); await w.tick();
  const q2 = w.sent.find((s) => s.startsWith('[탑다운] 12/1'));
  assert.ok(q2 && q2.length < 1500);
});

// ── 4회차(codex 6.2-sol) 지적 재현 ─────────────────────────────────────────
test('읽은 칸 답은 조건이 없다는 것과 앞 조건이 지워진 것도 말한다', async () => {
  const w = base();
  await openDay(w);
  w.at('2026-11-30T21:40:00Z');
  await w.reply(8001, '채권 우호 조건: 10년물 4.50% 넘으면 틀림');
  w.at('2026-11-30T21:41:00Z');
  await w.reply(8002, '채권 우호, 조건 4.50% 넘으면 틀림\n성장 그대로');
  assert.match(w.sent.at(-1), /읽은 칸: 채권 우호\(조건 없음 — 앞 조건은 지워졌어요\) · 성장 그대로\(조건 없음\)/);
});

test('늦게 올라온 보고서는 그 하루가 끝날 때의 내 칸과 대조한다(다음 날 바꾼 칸이 아니다)', async () => {
  const w = base();
  await openDay(w);
  w.at('2026-11-30T21:40:00Z');
  await w.reply(8101, '채권 우호');
  w.yields['2026-12-01'] = '3.56'; w.yields10['2026-12-01'] = '4.05';
  w.at('2026-12-01T21:15:00Z'); await w.tick();
  w.at('2026-12-01T21:20:00Z');
  await w.reply(8102, '채권 불리');
  w.site.posts[T] = { sha: 'late1', at: '2026-12-01T21:25:00Z' };
  w.site.macro.late1 = { report_date: T, regime: { growth: 0, inflation: 0 }, transmission: { bonds: { direction: -1 }, equities: { direction: 0 } } };
  w.at('2026-12-01T21:30:00Z'); await w.tick();
  const rp = w.file(`topdown/reports/${T}.json`);
  assert.equal(rp.mine_at_compare.bonds.value, '우호');
  assert.match(w.sent.find((s) => s.startsWith('[탑다운] 11/30 보고서가')), /채권 — 나 우호 · 보고서 불리/);
});

test('주말 돌아보기 — 토요일 아침 한 번, 요약 파일이 없으면 알린다', async () => {
  const w = base();
  await openDay(w);
  w.at('2026-12-04T22:15:00Z'); await w.tick();              // 토 07:15 KST — 요약 파일 없음
  assert.ok(w.sent.some((s) => s.startsWith('⚠️ 탑다운 주간 돌아보기: scores/topdown.json 을 읽지 못했습니다')));
  w.files.set('scores/topdown.json', JSON.stringify({ generated_at: '2026-12-04T12:20:00Z', days: [], judgments: [], overdue: [], counts: {} }));
  w.at('2026-12-04T22:30:00Z'); await w.tick();
  w.at('2026-12-04T22:45:00Z'); await w.tick();
  assert.equal(w.sent.filter((s) => s.startsWith('[탑다운] 주간 돌아보기')).length, 1);
});

test('꾸러미 — 08:30 ET 발표가 지난 당일은 「다음 발표」가 아니다, 2월 초에도 전년도 금리로 20 관측이 찬다', async () => {
  const w = base({ schedule: { rows: [{ kind: 'cpi', t: '2026-12-10' }, { kind: 'cpi', t: '2027-01-13' }, { kind: 'employment', t: '2027-01-08' }] } });
  const pk = (isoStr) => w.core.td.packet({ now: Date.parse(isoStr), treasury: undefined, fred: {} });
  assert.equal((await pk('2026-12-10T13:00:00Z')).next.cpi, '2026-12-10', '08:00 ET — 아직 발표 전');
  assert.equal((await pk('2026-12-10T14:00:00Z')).next.cpi, '2027-01-13', '09:00 ET — 발표 뒤');

  // 2027-02-02: 그해 관측은 1월 + 2월 이틀(평일 21개 미만이 되게 1월은 10개만)
  for (let i = 0; i < 25; i++) { const d = `2026-12-${String(i + 1).padStart(2, '0')}`; w.yields[d] = '3.70'; w.yields10[d] = '4.20'; }
  for (let i = 0; i < 10; i++) { const d = `2027-01-${String(i + 5).padStart(2, '0')}`; w.yields[d] = '3.70'; w.yields10[d] = '4.20'; }
  w.yields['2027-02-01'] = '3.71'; w.yields10['2027-02-01'] = '4.21';
  const feb = await pk('2027-02-02T15:00:00Z');
  assert.equal(feb.treasury.length, 20);
  assert.equal(feb.treasury[0].date.slice(0, 4), '2026', '전년도 관측이 앞을 채운다');
  assert.equal(feb.missing.includes('treasury_20'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { aiForecast, AI_SCHEMA } from '../src/ai.js';
import RULES from '../../rules/v1.json' with { type: 'json' };

const PACKET = { event: 'US-CPI-2026-12-10', kind: 'cpi', t: '2026-12-10', y_tm1: 460, y_t: 465, d0: 5, recent: [] };
const msg = (over = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
  content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: '{"p":62,"reason":"근거"}' }],
  stop_reason: 'end_turn', stop_details: null, stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 20 }, ...over,
});
function fake(status, body) {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'r' } });
  };
  return { fetch, seen };
}

test('AI 예측 — 고정 모델·노력·구조화 출력·거절 대체 요청, 꾸러미는 정렬 JSON', async () => {
  const f = fake(200, msg());
  const r = await aiForecast({ fetch: f.fetch, apiKey: 'A', rules: RULES, packet: PACKET });
  assert.deepEqual(r, { ok: true, p: 62, reason: '근거', served_model: 'claude-opus-5-5', stop_reason: 'end_turn' });
  const req = f.seen[0];
  assert.match(req.url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
  assert.equal(req.headers.authorization, 'Bearer A'); // SDK 1.x 는 키를 Bearer 로 보낸다
  assert.match(req.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.equal(req.body.fallbacks, 'default');
  assert.deepEqual(req.body.output_config, { effort: 'high', format: { type: 'json_schema', schema: AI_SCHEMA } });
  assert.equal(req.body.system, RULES.ai.system);
  assert.equal(req.body.messages[0].content, JSON.stringify(Object.fromEntries(Object.entries(PACKET).sort())));
  assert.equal(req.body.thinking, undefined);
});

test('AI 예측 — 거절·잘림·형식·범위·API 오류는 기권 사유로', async () => {
  const cases = [
    [200, msg({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' }, content: [] }), /^refusal:cyber$/],
    [200, msg({ stop_reason: 'max_tokens' }), /^stop:max_tokens$/],
    [200, msg({ content: [{ type: 'text', text: 'not json' }] }), /^format/],
    [200, msg({ content: [{ type: 'text', text: '{"p":150,"reason":"x"}' }] }), /^format/],
    [200, msg({ content: [{ type: 'text', text: '{"p":62.5,"reason":"x"}' }] }), /^format/],
    [200, msg({ content: [{ type: 'text', text: '{"p":62,"reason":"  "}' }] }), /^format/],
    [400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }, /^api:400$/],
    [401, { type: 'error', error: { type: 'authentication_error', message: 'bad key' } }, /^api:401$/],
  ];
  for (const [status, body, re] of cases) {
    const r = await aiForecast({ fetch: fake(status, body).fetch, apiKey: 'A', rules: RULES, packet: PACKET });
    assert.equal(r.ok, false, JSON.stringify(body).slice(0, 80));
    assert.match(r.why, re);
  }
  const net = await aiForecast({ fetch: async () => { throw new TypeError('fetch failed'); }, apiKey: 'A', rules: RULES, packet: PACKET });
  assert.equal(net.ok, false);
  assert.match(net.why, /^api:/);
});

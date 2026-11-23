// AI 예측 — 고정 모델·고정 프롬프트(rules/v1.json)·질문 꾸러미로 한 번 부른다.
// 실패·거절은 예외로 올리지 않고 기권 사유(why)로 돌려준다(호출자가 ai/<사건>/missing.json 을 만든다).
import Anthropic from '@anthropic-ai/sdk';
import { canonical } from './util.js';

export const AI_SCHEMA = {
  type: 'object',
  properties: { p: { type: 'integer' }, reason: { type: 'string' } },
  required: ['p', 'reason'],
  additionalProperties: false,
};

export async function aiForecast({ fetch, apiKey, rules, packet }) {
  const client = new Anthropic({ apiKey, fetch, maxRetries: 1, timeout: 180_000 });
  let res;
  try {
    res = await client.beta.messages.create({
      model: rules.ai.model,
      max_tokens: rules.ai.max_tokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: rules.ai.fallbacks,
      output_config: { effort: rules.ai.effort, format: { type: 'json_schema', schema: AI_SCHEMA } },
      system: rules.ai.system,
      messages: [{ role: 'user', content: canonical(packet) }],
    });
  } catch (e) {
    return { ok: false, why: `api:${e && e.status ? e.status : 'network'}` };
  }
  if (res.stop_reason === 'refusal') {
    return { ok: false, why: `refusal:${(res.stop_details && res.stop_details.category) || 'unknown'}` };
  }
  if (res.stop_reason !== 'end_turn') return { ok: false, why: `stop:${res.stop_reason}` };
  const block = (res.content || []).find((b) => b.type === 'text');
  let out;
  try { out = JSON.parse(block ? block.text : ''); } catch { return { ok: false, why: 'format:json' }; }
  if (!out || !Number.isInteger(out.p) || out.p < 0 || out.p > 100) return { ok: false, why: 'format:p' };
  if (typeof out.reason !== 'string' || out.reason.trim() === '') return { ok: false, why: 'format:reason' };
  return { ok: true, p: out.p, reason: out.reason, served_model: res.model, stop_reason: res.stop_reason };
}

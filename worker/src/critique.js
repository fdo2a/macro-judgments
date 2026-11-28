// AI 첨삭 — 고정 모델·고정 프롬프트(rules/topdown-v1.json critique)로 글 하나에 한 번 부른다.
// 정답을 주지 않고 질문으로 짚는다. 조건 원문은 코드가 읽을 꼴(자료, gt|lt, 수치)로 해석한다.
// 실패·거절은 예외로 올리지 않고 why 로 돌려준다(호출자가 실패 기록을 남기고 알린다).
import Anthropic from '@anthropic-ai/sdk';
import { canonical } from './util.js';

export const SERIES = ['treasury10', 'sp500', 'dtwexbgs', 'unrate', 'core_cpi_mom', 'fed_upper'];
const LABEL = {
  treasury10: ['재무부 10년물', '%'], sp500: ['S&P 500', ''], dtwexbgs: ['연준 광의 달러지수', ''],
  unrate: ['실업률(첫 발표)', '%'], core_cpi_mom: ['근원 CPI 전월비(첫 발표)', '%'], fed_upper: ['연방기금 목표 상단', '%'],
};

// 사람이 승인하는 문장 = 저장하는 (자료, 비교, 수치) 그대로. AI 의 자유 문장을 쓰지 않는다.
export function conditionText(series, op, value) {
  const [label, unit] = LABEL[series];
  return `${label} ${value}${unit} ${op === 'gt' ? '초과' : '미만'}이면 틀림`;
}

export function critiqueSchema(cellKeys) {
  return {
    type: 'object',
    properties: {
      questions: { type: 'array', items: { type: 'string' } },
      conditions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            cell: { type: 'string', enum: cellKeys },
            ok: { type: 'boolean' },
            series: { type: 'string', enum: SERIES },
            op: { type: 'string', enum: ['gt', 'lt'] },
            value: { type: 'number' },
            restated: { type: 'string' },
          },
          required: ['cell', 'ok', 'series', 'op', 'value', 'restated'],
          additionalProperties: false,
        },
      },
    },
    required: ['questions', 'conditions'],
    additionalProperties: false,
  };
}

// input = {entry:{text, conditions}, cells, packet}
export async function aiCritique({ fetch, apiKey, rules, input }) {
  const cfg = rules.critique;
  const client = new Anthropic({ apiKey, fetch, maxRetries: 1, timeout: 180_000 });
  let res;
  try {
    res = await client.beta.messages.create({
      model: cfg.model,
      max_tokens: cfg.max_tokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: cfg.fallbacks,
      output_config: { effort: cfg.effort, format: { type: 'json_schema', schema: critiqueSchema(Object.keys(rules.cells)) } },
      system: cfg.system,
      messages: [{ role: 'user', content: canonical(input) }],
    });
  } catch (e) {
    return { ok: false, why: `api:${e && e.status ? e.status : 'network'}` };
  }
  if (!res) return { ok: false, why: 'api:empty' };
  if (res.stop_reason === 'refusal') {
    return { ok: false, why: `refusal:${(res.stop_details && res.stop_details.category) || 'unknown'}` };
  }
  if (res.stop_reason !== 'end_turn') return { ok: false, why: `stop:${res.stop_reason}` };
  const block = (res.content || []).find((b) => b.type === 'text');
  let out;
  try { out = JSON.parse(block ? block.text : ''); } catch { return { ok: false, why: 'format:json' }; }
  if (!out || !Array.isArray(out.questions) || !Array.isArray(out.conditions)) return { ok: false, why: 'format:shape' };
  const questions = out.questions.filter((q) => typeof q === 'string' && q.trim() !== '').map((q) => q.trim());
  if (questions.length === 0) return { ok: false, why: 'format:questions' };
  // 글에 조건 원문이 있는 칸만, 칸마다 하나. 꼴이 어긋난 해석은 ok=false 로 바꾼다(조건으로 쓰지 않는다).
  const wanted = input.entry.conditions || {};
  const seen = new Set();
  const conditions = [];
  for (const c of out.conditions) {
    if (!c || !(c.cell in wanted) || seen.has(c.cell)) continue;
    seen.add(c.cell);
    const shapeOk = SERIES.includes(c.series) && (c.op === 'gt' || c.op === 'lt') && Number.isFinite(c.value)
      && typeof c.restated === 'string' && c.restated.trim() !== '';
    const ok = Boolean(c.ok) && shapeOk;
    conditions.push({
      cell: c.cell, raw: wanted[c.cell], ok,
      series: c.series, op: c.op, value: c.value,
      restated: ok ? conditionText(c.series, c.op, c.value) : String(c.restated || '').trim() || '해석 없음',
      ai_restated: String(c.restated || '').trim() || null,
    });
  }
  for (const cell of Object.keys(wanted)) {
    if (!seen.has(cell)) conditions.push({ cell, raw: wanted[cell], ok: false, series: null, op: null, value: null, restated: '해석이 오지 않았어요' });
  }
  return { ok: true, questions, conditions, served_model: res.model };
}

// 시험용 가짜 세계 — DO 저장소, 시계, 재무부·FRED·GitHub·텔레그램·Anthropic.
import { Core } from '../src/core.js';
import RULES from '../../rules/v1.json' with { type: 'json' };

export const OWNER = 777;
export const ENV = {
  GITHUB_TOKEN: 'G', GITHUB_REPO: 'fdo2a/macro-judgments', OWNER_ID: String(OWNER), TELEGRAM_BOT_TOKEN: 'TB',
  WEBHOOK_SECRET: 'W', SALT: 'S', FRED_API_KEY: 'F', ANTHROPIC_API_KEY: 'A', KICK_SECRET: 'K',
};

export class FakeStorage {
  constructor() { this.data = new Map(); this.alarmAt = null; }
  async get(k) { return this.data.has(k) ? structuredClone(this.data.get(k)) : undefined; }
  async put(k, v) { this.data.set(k, structuredClone(v)); }
  async delete(k) { return this.data.delete(k); }
  async list({ prefix = '' } = {}) {
    const out = new Map();
    for (const k of [...this.data.keys()].sort()) if (k.startsWith(prefix)) out.set(k, structuredClone(this.data.get(k)));
    return out;
  }
  async setAlarm(t) { this.alarmAt = t; }
  async getAlarm() { return this.alarmAt; }
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');
const resp = (status, body, type = 'application/json') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });

export function world({ schedule, fomc = [], yields = {}, released = {} } = {}) {
  const w = {
    t: 0,
    yields: { ...yields },          // 'YYYY-MM-DD' → '4.65'
    released: { ...released },      // release_id → ['YYYY-MM-DD']
    files: new Map(),               // path → JSON 문자열
    commits: [],
    sent: [],                       // 텔레그램으로 보낸 글
    putFail: [],                    // [{match, status, store}] 한 번씩
    telegramFail: null,             // (text) => bool
    ai: { status: 200, body: null },
    aiCalls: 0,
  };
  w.files.set('rules/schedule.json', JSON.stringify(schedule || { rows: [] }));
  w.files.set('rules/fomc-decisions.json', JSON.stringify({ decisions: fomc.map((date) => ({ date })) }));

  w.fetch = async (u, init = {}) => {
    const url = new URL(String(u));
    const method = init.method || 'GET';
    if (url.host === 'home.treasury.gov') {
      const year = url.pathname.match(/\/(\d{4})\/all$/)[1];
      const rows = Object.entries(w.yields).filter(([d]) => d.startsWith(year)).sort((a, b) => (a[0] < b[0] ? 1 : -1));
      const csv = ['Date,"1 Mo","2 Yr","10 Yr"', ...rows.map(([d, v]) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)},4.00,${v},4.50`)].join('\n');
      return resp(200, csv, 'text/csv');
    }
    if (url.host === 'api.stlouisfed.org') {
      const id = url.searchParams.get('release_id');
      return resp(200, { release_dates: (w.released[id] || []).map((date) => ({ release_id: Number(id), date })) });
    }
    if (url.host === 'api.telegram.org') {
      const body = JSON.parse(init.body);
      if (w.telegramFail && w.telegramFail(body.text)) return resp(502, { ok: false, description: 'Bad Gateway' });
      w.sent.push(body.text);
      return resp(200, { ok: true, result: { message_id: w.sent.length } });
    }
    if (url.host === 'api.anthropic.com') {
      w.aiCalls++;
      return resp(w.ai.status, w.ai.body);
    }
    if (url.host === 'api.github.com') {
      if (url.pathname === '/repos/fdo2a/fdo2a.github.io/commits') return resp(200, [{ commit: { committer: { date: '2026-12-11T00:10:00Z' } } }]);
      const m = url.pathname.match(/^\/repos\/fdo2a\/macro-judgments\/contents\/(.+)$/);
      if (!m) return resp(404, {});
      const path = decodeURIComponent(m[1]);
      if (method === 'PUT') {
        const body = JSON.parse(init.body);
        const fi = w.putFail.findIndex((f) => path.includes(f.match));
        if (fi >= 0) {
          const f = w.putFail.splice(fi, 1)[0];
          if (f.store) w.files.set(path, unb64(body.content));
          return resp(f.status, { message: 'x' });
        }
        if (w.files.has(path)) return resp(422, { message: '"sha" wasn\'t supplied.' });
        w.files.set(path, unb64(body.content));
        const sha = `c${w.commits.length + 1}`;
        w.commits.push({ path, at: new Date(w.t).toISOString() });
        return resp(201, { commit: { sha, html_url: `https://github.com/fdo2a/macro-judgments/commit/${sha}`, committer: { date: new Date(w.t).toISOString() } } });
      }
      if (!w.files.has(path)) return resp(404, { message: 'Not Found' });
      return resp(200, { content: b64(w.files.get(path)), encoding: 'base64' });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  w.storage = new FakeStorage();
  w.core = new Core({ storage: w.storage, fetch: w.fetch, now: () => w.t, env: ENV, rules: RULES });
  w.file = (p) => (w.files.has(p) ? JSON.parse(w.files.get(p)) : null);
  w.paths = (prefix) => [...w.files.keys()].filter((k) => k.startsWith(prefix)).sort();
  w.at = (isoStr) => { w.t = Date.parse(isoStr); return w; };
  w.tick = async () => w.core.alarm();
  w.reply = (update_id, text, { from = OWNER, chat = OWNER, type = 'private', date = w.t, secret = 'W' } = {}) =>
    w.core.webhook({ secret, update: { update_id, message: { message_id: update_id, date: Math.floor(date / 1000), chat: { id: chat, type }, from: { id: from }, text } } });
  return w;
}

export const aiOk = (p = 62, reason = '근거') => ({
  id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
  content: [{ type: 'text', text: JSON.stringify({ p, reason }) }],
  stop_reason: 'end_turn', stop_details: null, usage: { input_tokens: 1, output_tokens: 1 },
});

// 시험용 가짜 세계 — DO 저장소, 시계, 재무부·FRED·GitHub·텔레그램·Anthropic.
import { Core } from '../src/core.js';
import RULES from '../../rules/v1.json' with { type: 'json' };
import TD_RULES from '../../rules/topdown-v1.json' with { type: 'json' };

export const OWNER = 777;
export const ENV = {
  GITHUB_TOKEN: 'G', GITHUB_REPO: 'fdo2a/macro-judgments', OWNER_ID: String(OWNER), TELEGRAM_BOT_TOKEN: 'TB',
  WEBHOOK_SECRET: 'W', SALT: 'S', FRED_API_KEY: 'F', ANTHROPIC_API_KEY: 'A', KICK_SECRET: 'K',
  V1_ENABLED: '1', TOPDOWN_ENABLED: '0', // v1 시험의 기본값. 탑다운 시험은 env 로 바꾼다.
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

export function world({ schedule, fomc = [], yields = {}, released = {}, env = {}, tdRules = TD_RULES, yields10 = null, fred = {}, site = {} } = {}) {
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
    briefAt: '2026-12-11T00:10:00Z',
    yields10,                       // 'YYYY-MM-DD' → '4.12' (없으면 10 Yr 칸은 4.50 고정)
    fred: { ...fred },              // 시리즈 → [[date, value], ...] 날짜순
    fredFail: new Set(),            // 실패시킬 시리즈
    site: { posts: {}, macro: {}, ...site }, // posts: t → {sha, at}, macro: sha → JSON
  };
  w.files.set('rules/schedule.json', JSON.stringify(schedule || { rows: [] }));
  w.files.set('rules/fomc-decisions.json', JSON.stringify({ decisions: fomc.map((date) => ({ date })) }));

  w.fetch = async (u, init = {}) => {
    const url = new URL(String(u));
    const method = init.method || 'GET';
    if (url.host === 'home.treasury.gov') {
      const year = url.pathname.match(/\/(\d{4})\/all$/)[1];
      const rows = Object.entries(w.yields).filter(([d]) => d.startsWith(year)).sort((a, b) => (a[0] < b[0] ? 1 : -1));
      const ten = (d) => (w.yields10 ? (w.yields10[d] ?? '') : '4.50');
      const csv = ['Date,"1 Mo","2 Yr","10 Yr"', ...rows.map(([d, v]) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)},4.00,${v},${ten(d)}`)].join('\n');
      return resp(200, csv, 'text/csv');
    }
    if (url.host === 'api.stlouisfed.org' && url.pathname === '/fred/series/observations') {
      const id = url.searchParams.get('series_id');
      if (w.fredFail.has(id)) return resp(500, { error_message: 'x' });
      const obs = (w.fred[id] || []).map(([date, value]) => ({ realtime_start: '2026-01-01', realtime_end: '9999-12-31', date, value }));
      if (url.searchParams.get('sort_order') === 'desc') obs.reverse();
      return resp(200, { observations: obs.slice(0, Number(url.searchParams.get('limit') || 100000)) });
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
      if (url.pathname === '/repos/fdo2a/fdo2a.github.io/commits' && /^posts\/\d{4}-\d{2}-\d{2}\.html$/.test(url.searchParams.get('path')) && w.tdSite) {
        const t = url.searchParams.get('path').slice(6, 16);
        const p = w.site.posts[t];
        return resp(200, p && w.t >= Date.parse(p.at) ? [{ sha: 'newer', commit: { committer: { date: '2099-01-01T00:00:00Z' } } }, { sha: p.sha, commit: { committer: { date: p.at } } }] : []);
      }
      const sm = url.pathname.match(/^\/repos\/fdo2a\/fdo2a\.github\.io\/contents\/data\/macro\.json$/);
      if (sm) {
        const ref = url.searchParams.get('ref');
        return ref in w.site.macro ? resp(200, { content: b64(JSON.stringify(w.site.macro[ref])), encoding: 'base64' }) : resp(404, {});
      }
      if (url.pathname === '/repos/fdo2a/fdo2a.github.io/commits') {
        // 사이트 브리프는 w.briefAt 이후에만 존재한다(Q 에는 보통 아직 없다).
        return resp(200, w.t >= Date.parse(w.briefAt) ? [{ commit: { committer: { date: w.briefAt } } }] : []);
      }
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
  w.tdSite = env.TOPDOWN_ENABLED === '1';
  w.core = new Core({ storage: w.storage, fetch: w.fetch, now: () => w.t, env: { ...ENV, ...env }, rules: RULES, tdRules });
  w.file = (p) => (w.files.has(p) ? JSON.parse(w.files.get(p)) : null);
  w.paths = (prefix) => [...w.files.keys()].filter((k) => k.startsWith(prefix)).sort();
  w.at = (isoStr) => { w.t = Date.parse(isoStr); return w; };
  w.tick = async () => w.core.alarm();
  // replyTo = 인용한 메시지 번호(가짜 텔레그램의 message_id = w.sent 에서의 순번, 1부터)
  w.reply = (update_id, text, { from = OWNER, chat = OWNER, type = 'private', date = w.t, secret = 'W', replyTo = null } = {}) =>
    w.core.webhook({ secret, update: { update_id, message: { message_id: update_id, date: Math.floor(date / 1000), chat: { id: chat, type }, from: { id: from }, text, ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) } } });
  return w;
}

export const aiOk = (p = 62, reason = '근거') => ({
  id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
  content: [{ type: 'text', text: JSON.stringify({ p, reason }) }],
  stop_reason: 'end_turn', stop_details: null, usage: { input_tokens: 1, output_tokens: 1 },
});

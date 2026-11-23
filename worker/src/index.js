// 얇은 접합부 — Cloudflare API 를 core.js 에 꽂는다. 판단은 전부 core.js 에 있다.
import { DurableObject } from 'cloudflare:workers';
import { Core } from './core.js';
import RULES from '../../rules/v1.json' with { type: 'json' };

const MAX_UPDATE_BYTES = 64 * 1024;

// 로그에는 결과 코드·길이만 남긴다. 머리글·본문·URL(키가 들어갈 수 있다)은 남기지 않는다.
function log(o) {
  try { console.log(JSON.stringify(o)); } catch { /* 무시 */ }
}

export class Judgments extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new Core({ storage: ctx.storage, fetch: (u, i) => fetch(u, i), now: () => Date.now(), env, rules: RULES, log });
  }
  async alarm() { await this.core.alarm(); }
  async kick() { await this.core.armIfMissing(); return this.core.health(); }
  async health() { return this.core.health(); }
  async webhook(req) { return this.core.webhook(req); }
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const stub = (env) => env.JUDGMENTS.get(env.JUDGMENTS.idFromName('main'));

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/telegram') {
        if (request.method !== 'POST') return json(405, { error: 'method' });
        if (Number(request.headers.get('content-length') || 0) > MAX_UPDATE_BYTES) return json(413, { error: 'size' });
        let update = null;
        try { update = await request.json(); } catch { return json(200, { ok: true }); }
        const r = await stub(env).webhook({ secret: request.headers.get('x-telegram-bot-api-secret-token'), update });
        return json(r.status, { ok: r.status === 200 });
      }
      if (pathname === '/kick') {
        if (request.method !== 'POST') return json(405, { error: 'method' });
        if (!env.KICK_SECRET || request.headers.get('x-kick-secret') !== env.KICK_SECRET) return json(401, { error: 'auth' });
        return json(200, await stub(env).kick());
      }
      if (pathname === '/health') {
        if (request.method !== 'GET') return json(405, { error: 'method' });
        return json(200, await stub(env).health());
      }
      return json(404, { error: 'not found' });
    } catch (e) {
      log({ op: 'fetch', path: pathname, error: (e && e.name) || 'Error' });
      return json(500, { error: 'internal' });
    }
  },
};

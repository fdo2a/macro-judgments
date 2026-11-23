// 외부 연결 — 재무부·FRED·GitHub·텔레그램. fetch 는 가짜로 바꿔 끼운다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTreasuryCsv, treasuryUrl, fetchTreasury, releaseHappened, SourceError } from '../src/sources.js';
import { GitHub } from '../src/github.js';
import { sendMessage } from '../src/telegram.js';

const CSV = readFileSync(new URL('./fixture-treasury-2026-head.csv', import.meta.url), 'utf8');
const resp = (status, body, type = 'application/json') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });

test('재무부 CSV — 2 Yr 칸을 ISO 날짜로', () => {
  const rows = parseTreasuryCsv(CSV);
  assert.deepEqual(rows[0], ['2026-11-16', '4.83']);
  assert.deepEqual(rows.at(-1), ['2026-11-20', '4.63']);
  assert.equal(rows.length, 5);
});

test('재무부 CSV — 2 Yr 칸이 없으면 형식 오류로 멈춘다', () => {
  assert.throws(() => parseTreasuryCsv('Date,"1 Mo"\n11/20/2026,4.19\n'), (e) => e instanceof SourceError && e.kind === 'format');
  assert.throws(() => parseTreasuryCsv('<html>error</html>'), (e) => e instanceof SourceError && e.kind === 'format');
});

test('재무부 — 연도 둘을 합치고 HTTP 오류는 멈춘다', async () => {
  const seen = [];
  const fetch = async (url) => {
    seen.push(url);
    return url.includes('/2025/') ? resp(200, 'Date,"2 Yr"\n12/31/2025,3.50\n', 'text/csv') : resp(200, CSV, 'text/csv');
  };
  const rows = await fetchTreasury(fetch, [2025, 2026]);
  assert.equal(rows[0][0], '2025-12-31');
  assert.equal(rows.length, 6);
  assert.ok(seen[0].startsWith('https://home.treasury.gov/'));
  assert.equal(treasuryUrl(2026), seen[1]);
  await assert.rejects(fetchTreasury(async () => resp(503, 'x', 'text/plain'), [2026]), (e) => e.kind === 'http' && e.status === 503);
});

test('FRED — 데이터가 나온 발표일 목록에 t 가 있으면 발표 확인', async () => {
  let url;
  const fetch = async (u) => { url = new URL(u); return resp(200, { release_dates: [{ release_id: 10, date: '2026-11-10' }, { release_id: 10, date: '2026-10-14' }] }); };
  assert.equal(await releaseHappened(fetch, 'K', 10, '2026-11-10'), true);
  assert.equal(url.searchParams.get('include_release_dates_with_no_data'), 'false');
  assert.equal(url.searchParams.get('release_id'), '10');
  assert.equal(await releaseHappened(fetch, 'K', 10, '2026-11-12'), false);
  await assert.rejects(releaseHappened(async () => resp(400, { error_message: 'Bad Request.  The value for variable api_key is not registered.' }), 'K', 10, '2026-11-10'), (e) => e.kind === 'http' && e.status === 400);
  await assert.rejects(releaseHappened(async () => resp(200, { nope: 1 }), 'K', 10, '2026-11-10'), (e) => e.kind === 'format');
});

function fakeGitHub() {
  const files = new Map();
  const calls = [];
  let failNextPut = null;
  const fetch = async (u, init = {}) => {
    const url = new URL(u);
    calls.push({ method: init.method || 'GET', path: url.pathname, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const m = url.pathname.match(/^\/repos\/fdo2a\/macro-judgments\/contents\/(.+)$/);
    if (m) {
      const path = decodeURIComponent(m[1]);
      if ((init.method || 'GET') === 'PUT') {
        if (failNextPut) { const f = failNextPut; failNextPut = null; if (f.store) files.set(path, JSON.parse(init.body).content); return resp(f.status, { message: 'x' }); }
        if (files.has(path)) return resp(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
        files.set(path, JSON.parse(init.body).content);
        return resp(201, { content: { path }, commit: { sha: 'c1', html_url: `https://github.com/fdo2a/macro-judgments/commit/c1`, committer: { date: '2026-11-10T22:00:00Z' } } });
      }
      if (!files.has(path)) return resp(404, { message: 'Not Found' });
      return resp(200, { content: files.get(path), encoding: 'base64', html_url: `https://github.com/fdo2a/macro-judgments/blob/main/${path}` });
    }
    if (url.pathname === '/repos/fdo2a/fdo2a.github.io/commits') {
      return resp(200, [{ commit: { committer: { date: '2026-11-23T06:31:17Z' } } }, { commit: { committer: { date: '2026-11-21T16:46:26Z' } } }]);
    }
    return resp(404, {});
  };
  return { files, calls, fetch, failPut: (status, store) => { failNextPut = { status, store }; } };
}

test('GitHub — 만들기 전용: sha·작성자·날짜를 보내지 않는다, 한글 내용 왕복', async () => {
  const f = fakeGitHub();
  const gh = new GitHub({ fetch: f.fetch, token: 'T', repo: 'fdo2a/macro-judgments' });
  const r = await gh.create('human/US-CPI-2026-11-10/abc.json', { text: '65\n근거', submission_hmac: 'h1' }, 'msg');
  assert.equal(r.state, 'created');
  assert.equal(r.commitDate, '2026-11-10T22:00:00Z');
  const put = f.calls.find((c) => c.method === 'PUT');
  assert.deepEqual(Object.keys(put.body).sort(), ['content', 'message']);
  assert.equal(put.headers.authorization, 'Bearer T');
  assert.deepEqual(await gh.get('human/US-CPI-2026-11-10/abc.json'), { text: '65\n근거', submission_hmac: 'h1' });
  assert.equal(await gh.get('nope.json'), null);
});

test('GitHub — 응답이 애매하면 같은 경로를 읽어 확정한다', async () => {
  const f = fakeGitHub();
  const gh = new GitHub({ fetch: f.fetch, token: 'T', repo: 'fdo2a/macro-judgments' });
  const obj = { a: 1, submission_hmac: 'h1' };
  // 이미 있고 같은 표식 → 이미 기록됨
  await gh.create('x.json', obj, 'm');
  assert.equal((await gh.ensure('x.json', obj, 'submission_hmac', 'm')).state, 'exists');
  // 다른 표식 → 충돌(멈추고 알림)
  assert.equal((await gh.ensure('x.json', { a: 2, submission_hmac: 'h2' }, 'submission_hmac', 'm')).state, 'conflict');
  // 502 인데 실제로는 저장됨 → 읽어서 성공으로
  f.failPut(502, true);
  assert.equal((await gh.ensure('y.json', obj, 'submission_hmac', 'm')).state, 'exists');
  // 502 이고 저장 안 됨 → 대기
  f.failPut(502, false);
  assert.equal((await gh.ensure('z.json', obj, 'submission_hmac', 'm')).state, 'pending');
  // 시간 초과(예외)
  const gh2 = new GitHub({ fetch: async () => { throw new Error('timeout'); }, token: 'T', repo: 'fdo2a/macro-judgments' });
  assert.equal((await gh2.ensure('w.json', obj, 'submission_hmac', 'm')).state, 'pending');
});

test('GitHub — 사이트 브리프 첫 커밋 시각(가장 오래된 것)', async () => {
  const f = fakeGitHub();
  const gh = new GitHub({ fetch: f.fetch, token: 'T', repo: 'fdo2a/macro-judgments' });
  assert.equal(await gh.firstCommitDate('fdo2a/fdo2a.github.io', 'posts/2026-11-20.html'), '2026-11-21T16:46:26Z');
});

test('텔레그램 — 보내기 성공·실패', async () => {
  let body, url;
  const ok = async (u, init) => { url = u; body = JSON.parse(init.body); return resp(200, { ok: true, result: { message_id: 7 } }); };
  assert.deepEqual(await sendMessage(ok, 'TOK', 42, '안녕'), { ok: true, message_id: 7 });
  assert.equal(url, 'https://api.telegram.org/botTOK/sendMessage');
  assert.deepEqual(body, { chat_id: 42, text: '안녕', disable_web_page_preview: true });
  assert.deepEqual(await sendMessage(async () => resp(403, { ok: false, description: 'Forbidden: bot was blocked by the user' }), 'TOK', 42, 'x'), { ok: false, status: 403, description: 'Forbidden: bot was blocked by the user' });
  assert.deepEqual(await sendMessage(async () => { throw new Error('net'); }, 'TOK', 42, 'x'), { ok: false, status: 0, description: 'network' });
});

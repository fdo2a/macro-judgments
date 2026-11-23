// GitHub Contents API — 만들기 전용. 기존 파일을 고치는 코드는 없다(sha 를 보내지 않는다).
// 작성자·날짜를 보내지 않으므로 커밋 시각은 GitHub 서버 시각이다.

const API = 'https://api.github.com';

function b64encode(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decode(s) {
  const bin = atob(String(s).replace(/\n/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export class GitHub {
  constructor({ fetch, token, repo }) {
    this.fetch = fetch;
    this.token = token;
    this.repo = repo;
  }
  headers() {
    return {
      authorization: `Bearer ${this.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'macro-judgments-worker',
      'content-type': 'application/json',
    };
  }
  url(path) {
    return `${API}/repos/${this.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  // → {state:'created', htmlUrl, commitUrl, commitDate} | {state:'failed', status}
  async create(path, obj, message) {
    const body = JSON.stringify({ message, content: b64encode(JSON.stringify(obj, null, 2) + '\n') });
    const r = await this.fetch(this.url(path), { method: 'PUT', headers: this.headers(), body });
    if (r.status !== 201) return { state: 'failed', status: r.status };
    const j = await r.json();
    return {
      state: 'created',
      htmlUrl: `https://github.com/${this.repo}/blob/main/${path}`,
      commitUrl: j.commit && j.commit.html_url,
      commitDate: j.commit && j.commit.committer && j.commit.committer.date,
    };
  }

  // 파일 내용(JSON) 또는 없으면 null. 그 밖의 응답은 예외.
  async get(path) {
    const r = await this.fetch(this.url(path), { headers: this.headers() });
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error(`github get ${r.status}`);
    const j = await r.json();
    return JSON.parse(b64decode(j.content));
  }

  // 만들고, 응답이 201 이 아니거나 예외면 같은 경로를 읽어 확정한다.
  // → created | exists(같은 표식) | conflict(다른 표식) | pending(없거나 못 읽음)
  async ensure(path, obj, markKey, message) {
    try {
      const c = await this.create(path, obj, message);
      if (c.state === 'created') return c;
    } catch { /* 아래에서 읽어 확정 */ }
    let cur;
    try {
      cur = await this.get(path);
    } catch {
      return { state: 'pending' };
    }
    if (cur === null) return { state: 'pending' };
    const htmlUrl = `https://github.com/${this.repo}/blob/main/${path}`;
    return cur[markKey] === obj[markKey] ? { state: 'exists', htmlUrl } : { state: 'conflict', htmlUrl };
  }

  // 다른 레포 파일의 가장 오래된 커밋 시각(사이트 브리프가 처음 올라간 시각). 없으면 null.
  async firstCommitDate(repo, path) {
    const u = `${API}/repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=100`;
    const r = await this.fetch(u, { headers: this.headers() });
    if (r.status !== 200) throw new Error(`github commits ${r.status}`);
    const list = await r.json();
    if (!Array.isArray(list) || list.length === 0) return null;
    const c = list[list.length - 1];
    return (c.commit && c.commit.committer && c.commit.committer.date) || null;
  }
}

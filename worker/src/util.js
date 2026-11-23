// 도우미 — 답장 읽기, HMAC·SHA-256, 봉인 지문, 미국 동부 시각. 순수 함수(crypto.subtle 만 쓴다).

// 첫 줄 = 0-100 정수(뒤에 % 허용), 둘째 줄부터 = 근거(원문 그대로, 비면 안 됨)
export function parseReply(text) {
  if (typeof text !== 'string' || text === '') return { ok: false, why: 'empty' };
  const nl = text.indexOf('\n');
  const first = nl < 0 ? text : text.slice(0, nl);
  const m = /^\s*(\d{1,3})\s*%?\s*$/.exec(first);
  if (!m) return { ok: false, why: 'format' };
  const p = Number(m[1]);
  if (p > 100) return { ok: false, why: 'range' };
  const reason = nl < 0 ? '' : text.slice(nl + 1);
  if (reason.trim() === '') return { ok: false, why: 'no_reason' };
  return { ok: true, p, reason };
}

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(s) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

export async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

export function randomHex(nBytes = 32) {
  return hex(crypto.getRandomValues(new Uint8Array(nBytes)));
}

// 키 정렬·공백 없는 JSON(UTF-8 그대로). Python json.dumps(sort_keys=True, separators=(',',':'), ensure_ascii=False) 와 같다.
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

export async function sealHash(plain, nonceHex) {
  return sha256Hex(canonical(plain) + '\n' + nonceHex);
}

const NY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
function nyParts(ms) {
  const o = {};
  for (const p of NY.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}

// 뉴욕 벽시계 (date, h:m) 의 UTC 시각(ms). 동부는 UTC-4 또는 -5 뿐이다.
export function etInstant(date, h, m) {
  const [y, mo, d] = date.split('-').map(Number);
  for (const off of [5, 4]) {
    const ms = Date.UTC(y, mo - 1, d, h + off, m);
    const p = nyParts(ms);
    if (`${p.year}-${p.month}-${p.day}` === date && Number(p.hour) === h && Number(p.minute) === m) return ms;
  }
  throw new Error(`etInstant: ${date} ${h}:${m}`);
}

export function etDate(ms) {
  const p = nyParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}

export function addDays(date, n) {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

const KIND_CODE = { cpi: 'CPI', employment: 'EMP' };
export function eventId(kind, t) {
  return `US-${KIND_CODE[kind]}-${t}`;
}

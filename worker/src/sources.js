// 재무부 금리 CSV 와 FRED 발표일. 형식이 예상과 다르면 조용히 넘기지 않고 SourceError 로 멈춘다(호출자가 알린다).

export class SourceError extends Error {
  constructor(kind, detail, status) {
    super(`${kind}: ${detail}`);
    this.kind = kind; // 'http' | 'format' | 'network'
    this.status = status || 0;
  }
}

export function treasuryUrl(year) {
  return `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
}

function splitCsvLine(line) {
  return line.split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
}

// → 날짜순 [[YYYY-MM-DD, '4.63'], ...] (2Y 칸 글자 그대로, 빈 칸 포함)
export function parseTreasuryCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new SourceError('format', 'empty');
  const head = splitCsvLine(lines[0]);
  const iDate = head.indexOf('Date');
  const i2 = head.indexOf('2 Yr');
  if (iDate !== 0 || i2 < 0) throw new SourceError('format', 'no 2 Yr column');
  const rows = [];
  for (const line of lines.slice(1)) {
    const c = splitCsvLine(line);
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(c[iDate] || '');
    if (!m) throw new SourceError('format', 'bad date');
    rows.push([`${m[3]}-${m[1]}-${m[2]}`, c[i2] ?? '']);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return rows;
}

export async function fetchTreasury(fetch, years) {
  const all = [];
  for (const y of years) {
    let r;
    try {
      r = await fetch(treasuryUrl(y), { headers: { accept: 'text/csv' } });
    } catch {
      throw new SourceError('network', `treasury ${y}`);
    }
    if (r.status !== 200) throw new SourceError('http', `treasury ${y}`, r.status);
    all.push(...parseTreasuryCsv(await r.text()));
  }
  all.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return all;
}

// 그 발표(release_id)에 t 날짜로 데이터가 실제로 나왔는가. 예정일(데이터 없음)은 빼고 묻는다.
export async function releaseHappened(fetch, apiKey, releaseId, t) {
  const u = new URL('https://api.stlouisfed.org/fred/release/dates');
  u.searchParams.set('release_id', String(releaseId));
  u.searchParams.set('include_release_dates_with_no_data', 'false');
  u.searchParams.set('sort_order', 'desc');
  u.searchParams.set('limit', '20');
  u.searchParams.set('file_type', 'json');
  u.searchParams.set('api_key', apiKey);
  let r;
  try {
    r = await fetch(u.toString());
  } catch {
    throw new SourceError('network', 'fred');
  }
  if (r.status !== 200) throw new SourceError('http', 'fred', r.status);
  let body;
  try { body = await r.json(); } catch { throw new SourceError('format', 'fred json'); }
  if (!body || !Array.isArray(body.release_dates)) throw new SourceError('format', 'fred release_dates');
  return body.release_dates.some((d) => d && d.date === t);
}

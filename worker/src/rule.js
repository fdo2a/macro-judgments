// 규칙 v1 계산 — 순수 함수. scripts/rule.py 와 같은 답을 내야 한다(rules/test-vectors.json).
// 금리는 재무부 CSV 의 % 글자를 먼저 정수 bp 로 바꾼 뒤 뺀다. 소수로 빼면 3.61−3.60 이
// 0.99999…bp 가 되어 「1bp 미만」으로 잘못 판정된다.

export function toBp(s) {
  if (s === undefined || s === null) return null;
  const t = String(s).trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

// [[date, '4.65'], ...] → 날짜순 [{date, bp}] (값 없는 날 제외)
export function seriesFrom(rows) {
  const out = [];
  for (const [date, v] of rows) {
    const bp = toBp(v);
    if (bp !== null) out.push({ date, bp });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

export function signalAt(series, t) {
  const i = series.findIndex((r) => r.date === t);
  if (i < 0) return { status: 'series_missing', missing: ['t'] };
  if (i === 0) return { status: 'series_missing', missing: ['t-1'] };
  const prev = series[i - 1];
  const d0 = series[i].bp - prev.bp;
  return { status: d0 === 0 ? 'no_signal' : 'signal', tm1: prev.date, y_tm1: prev.bp, y_t: series[i].bp, d0 };
}

// t 뒤 5번째 값으로 결과. 5개가 안 되면 pending(have = t 뒤 값 수). 기한 판단은 호출자가 한다.
export function outcomeAfter(series, t, d0) {
  const i = series.findIndex((r) => r.date === t);
  const after = i < 0 ? series.filter((r) => r.date > t) : series.slice(i + 1);
  if (i < 0 || after.length < 5) return { status: 'pending', have: after.length };
  const t5 = after[4];
  const d5 = t5.bp - series[i].bp;
  if (d5 === 0) return { status: 'undecidable', t5: t5.date, y_t5: t5.bp, d5 };
  return { status: 'scoreable', t5: t5.date, y_t5: t5.bp, d5, o: Math.sign(d5) === Math.sign(d0) ? 1 : 0 };
}

// (t, t5] 안에 다른 사건 날짜가 있으면 겹침
export function overlaps(t, t5, dates) {
  return dates.some((d) => d > t && d <= t5);
}

export function brier(p, o) {
  const x = p / 100 - o;
  return x * x;
}

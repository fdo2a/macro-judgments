// 사이트 보고서 판단(macro.json) → 칸 값. 순수 함수. 보고서 판단은 채점하지 않고 대조만 한다.

const SIGN = {
  growth: { 1: '강해짐', 0: '그대로', '-1': '약해짐' },
  inflation: { 1: '재가속', 0: '그대로', '-1': '둔화' },
  bonds: { 1: '우호', 0: '중립', '-1': '불리' },
  equities: { 1: '우호', 0: '중립', '-1': '불리' },
};

const sign = (v) => (v === 1 || v === 0 || v === -1 ? SIGN.growth[v] !== undefined : false);

// → {status:'compared', cells, text} | {status:'date_mismatch', report_date} | {status:'format', why}
export function reportCells(macro, t) {
  if (!macro || typeof macro !== 'object') return { status: 'format', why: 'not_object' };
  if (macro.report_date !== t) return { status: 'date_mismatch', report_date: macro.report_date ?? null };
  const r = macro.regime || {};
  const tr = macro.transmission || {};
  const raw = {
    growth: r.growth,
    inflation: r.inflation,
    bonds: tr.bonds && tr.bonds.direction,
    equities: tr.equities && tr.equities.direction,
  };
  for (const [k, v] of Object.entries(raw)) if (!sign(v)) return { status: 'format', why: k };
  const cells = {};
  for (const [k, v] of Object.entries(raw)) cells[k] = SIGN[k][v];
  const pp = macro.policy_path;
  const text = {
    policy: pp && typeof pp === 'object' ? (pp.stance ?? null) : (typeof pp === 'string' ? pp : null),
    fx: tr.fx && typeof tr.fx.channel === 'string' ? tr.fx.channel : null,
  };
  return { status: 'compared', cells, text, horizon: macro.horizon ?? null };
}

// 내 칸과 보고서 칸 → {diff:[{key, mine, report}], same:[key], missing:[key]}
export function compare(mine, reportCellsMap) {
  const out = { diff: [], same: [], missing: [] };
  for (const [k, rv] of Object.entries(reportCellsMap)) {
    const m = mine[k] && mine[k].value;
    if (!m) out.missing.push(k);
    else if (m === rv) out.same.push(k);
    else out.diff.push({ key: k, mine: m, report: rv });
  }
  return out;
}

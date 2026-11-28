// 탑다운 글에서 판단 칸 읽기 — 순수 함수.
// 칸 줄의 꼴은 닫혀 있다: 줄 첫머리가 칸 이름, 바로 뒤가 정해진 값 낱말, 그 뒤는
//   (1) 줄 끝  (2) 구분 기호(, . ; : ·) + 아무 글(조건 아님)  (3) (구분 기호 하나)? + 「조건:」 + 조건 원문
// 칸 이름·값으로 시작하지만 이 꼴이 아닌 줄은 칸으로 읽지 않고 near 로 모아 답에 보인다(추측해서 읽지 않는다).

const NAME_ALIASES = { fomc: 'FOMC' };

// 사람에게 보이는 글에서만 쓴다(저장하는 원문은 자르지 않는다).
export const clip = (s, n = 200) => (s.length > n ? s.slice(0, n) + '…' : s);

// rules.cells → [{key, name, values, open}] (open = 지금 받는 칸; 경계가 비어 있는 주식·달러는 false)
export function cellList(rules) {
  return Object.entries(rules.cells).map(([key, c]) => ({
    key, name: c.name, values: c.values, open: !('band' in c) || c.band != null,
  }));
}

function lineMatch(line, cells) {
  const s = line.trim();
  for (const c of cells) {
    const head = s.slice(0, c.name.length);
    if (head !== c.name && NAME_ALIASES[head.toLowerCase()] !== c.name) continue;
    const rest0 = s.slice(c.name.length).replace(/^\s*[:：]?\s*/, '');
    for (const v of c.values) {
      if (!rest0.startsWith(v)) continue;
      const after = rest0.slice(v.length).trim();
      if (after === '') return { cell: c, value: v, condition: null };
      const m = /^[,.;:：·]?\s*조건\s*[:：]\s*(.+)$/.exec(after);
      if (m) return { cell: c, value: v, condition: m[1].trim() };
      if (/^[,.;:：·]/.test(after)) return { cell: c, value: v, condition: null };
      return { near: true }; // 「채권 우호 전망은…」「채권 우호 조건부로…」「채권 우호 조건 4.5 넘으면」(쌍점 없음)
    }
  }
  return null;
}

// → { cells: {key: value}, conditions: {key: 원문}, closed: [key], near: [줄] }
// closed = 아직 받지 않는 칸(주식·달러 경계 전)에 쓴 줄. 같은 칸이 두 번 나오면 뒤의 것.
export function parseEntry(text, rules) {
  const list = cellList(rules);
  const out = { cells: {}, conditions: {}, closed: [], near: [] };
  for (const line of String(text).split(/\r?\n/)) {
    const m = lineMatch(line, list);
    if (!m) continue;
    if (m.near) { out.near.push(line.trim()); continue; }
    if (!m.cell.open) {
      if (!out.closed.includes(m.cell.key)) out.closed.push(m.cell.key);
      continue;
    }
    out.cells[m.cell.key] = m.value;
    if (m.condition) out.conditions[m.cell.key] = m.condition;
    else delete out.conditions[m.cell.key];
  }
  return out;
}

// '네' → {all:true}, '네 1 3' → {nums:[1,3]}, 그 밖 → null
export function parseApproval(text) {
  const m = /^\s*네\s*([0-9][0-9\s,]*)?\s*[.!]?\s*$/.exec(String(text));
  if (!m) return null;
  if (!m[1]) return { all: true };
  const nums = [...new Set(m[1].split(/[\s,]+/).filter(Boolean).map(Number))].sort((a, b) => a - b);
  return { nums };
}

// 지금 칸을 사람이 읽을 줄들로. cur = {key: {value, cond: {raw, approved}|null}}
export function cellLines(rules, cur) {
  return cellList(rules).map((c) => {
    if (!c.open) return `${c.name} — 아직 받지 않는 칸`;
    const x = cur && cur[c.key];
    if (!x) return `${c.name} (비어 있음)`;
    let cond = '';
    if (x.cond && x.cond.approved) cond = ` · 조건: ${x.cond.approved.restated}`;
    else if (x.cond) cond = ` · 조건 원문(승인 전): ${clip(x.cond.raw)}`;
    return `${c.name} ${x.value}${cond}`;
  });
}

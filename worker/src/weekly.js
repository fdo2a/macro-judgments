// 주말 돌아보기 — Actions 가 만든 scores/topdown.json 을 사람이 읽을 글로. 순수 함수.
// 판정은 Python 이 기록에서 다시 계산한 것을 그대로 옮긴다(여기서 판정하지 않는다).

const KST_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
const KST_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
const md = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
const STALE_MS = 36 * 3600e3;

// 토요일 07:00 KST 이후 첫 알람이면 그 토요일 날짜(KST), 아니면 null
export function weeklyDue(now) {
  const p = Object.fromEntries(KST_PARTS.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  if (p.weekday !== 'Sat' || Number(p.hour) < 7) return null;
  return KST_DATE.format(new Date(now));
}

function obsText(j) {
  const o = j.observed || {};
  if (j.cell === 'bonds' && o.change_bp != null) return `10년물 ${o.change_bp > 0 ? '+' : ''}${o.change_bp}bp`;
  if (j.cell === 'growth' && o.target) return `실업률 ${o.base.value}→${o.target.value}%`;
  if (j.cell === 'inflation' && o.target) return `근원 전월비 ${o.base_mom}→${o.target.mom}%`;
  if (j.cell === 'fomc' && o.decision) return `${md(o.decision)} 상단 ${o.before}→${o.after}%`;
  if (j.broken_by) return `조건 자료 ${j.broken_by.series} ${j.broken_by.value} (${md(j.broken_by.date)})`;
  return '';
}

export function weeklyText(summary, rules, now) {
  const names = Object.fromEntries(Object.entries(rules.cells).map(([k, c]) => [k, c.name]));
  const since = now - 7 * 86400e3;
  const lines = [];
  const gen = Date.parse(summary.generated_at);
  const days = (summary.days || []).filter((d) => Date.parse(`${d.t}T23:59:59Z`) >= since - 86400e3 && Date.parse(`${d.t}T00:00:00Z`) <= now);
  const span = days.length ? `${md(days[0].t)}-${md(days[days.length - 1].t)}` : '이번 주';
  lines.push(`[탑다운] 주간 돌아보기 (${span})`);
  if (!(gen > now - STALE_MS)) lines.push(`⚠️ 요약이 오래됐어요(만든 시각 ${summary.generated_at || '없음'}). 아래 숫자는 그때 기준이에요.`);
  const crit = days.reduce((a, d) => ({ ok: a.ok + d.critique.ok, failed: a.failed + d.critique.failed }), { ok: 0, failed: 0 });
  lines.push(`쓴 날 ${days.filter((d) => d.written).length}/${days.length}` + (crit.failed ? ` · 첨삭 실패 ${crit.failed}건` : ''));
  const before = days.filter((d) => d.first_entry === '보고서 전').length;
  if (days.some((d) => d.written)) lines.push(`첫 글이 보고서 전: ${before}일`);
  let ac = 0;
  let ar = 0;
  for (const d of days) for (const c of Object.values(d.cells || {})) { if (c.after_critique) ac++; if (c.after_report) ar++; }
  lines.push(`바꾼 칸: 첨삭 뒤 ${ac} · 보고서 뒤 ${ar}`);

  const checked = (summary.judgments || []).filter((j) => j.state === 'closed' && j.verdict !== '바뀜' && j.check_at && Date.parse(j.check_at) > since && Date.parse(j.check_at) <= now);
  lines.push('', checked.length ? '이번 주 확인된 판단:' : '이번 주 확인된 판단 없음');
  for (const j of checked) {
    const o = obsText(j);
    lines.push(`· ${names[j.cell]} ${j.value} (${md(j.opened_at)}에 연 판단) — ${j.verdict}${o ? ': ' + o : ''}${j.outcome && j.verdict === '틀림' ? ` → 실제 ${j.outcome}` : ''}`);
  }
  if ((summary.overdue || []).length) {
    lines.push('', '⚠️ 자료를 오래 기다리는 판단:');
    for (const o of summary.overdue) lines.push(`· ${names[o.cell]} (${md(o.opened_at)}에 연 판단) — ${o.reason || '자료 대기'}`);
  }
  const tot = Object.entries(summary.counts || {}).map(([k, c]) => `${names[k]} ${c['맞음']}/${c['맞음'] + c['틀림']}` + (c['조건 깨짐'] ? ` (조건 깨짐 ${c['조건 깨짐']})` : ''));
  if (tot.length) lines.push('', `지금까지 맞음/판정: ${tot.join(' · ')}`);
  lines.push('실력 주장은 하지 않아요 — 칸마다 1년에 확인되는 판단이 많지 않아요.');
  return lines.join('\n');
}

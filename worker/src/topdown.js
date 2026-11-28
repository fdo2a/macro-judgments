// 탑다운 일지(규칙 topdown-v1) — Worker 는 일어난 일만 남긴다. 판단·확인·요약은 Actions 의 Python 이 이 기록에서 다시 계산한다.
// 하루 = 재무부 10 Yr 새 날짜 값이 보인 첫 알람(아침 질문)부터 다음 아침 질문 직전까지.
// 원칙: 공개 레포에는 만들기만 한다. 글은 받은 그대로 저장한다. 예상 밖 상태는 조용히 넘기지 않고 알린다.
import { parseEntry, parseApproval, cellLines, cellList, clip } from './cells.js';
import { reportCells, compare } from './report.js';
import { aiCritique } from './critique.js';
import { weeklyText, weeklyDue } from './weekly.js';
import { fetchTreasuryBoth, fredLatest, SourceError } from './sources.js';
import { sendMessage } from './telegram.js';
import { hmacHex, sha256Hex, canonical, etInstant, etDate, addDays } from './util.js';

const SITE_REPO = 'fdo2a/fdo2a.github.io';
const REPORT_DAYS = 4;          // 하루를 연 뒤 이 날수 동안 보고서 첫 커밋을 찾는다
const CRITIQUE_DELAY_MS = 5e3;  // 글을 받으면 알람을 이만큼 뒤로 당겨 첨삭한다

const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const KST = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const KST_HM = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ET_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' });
const toBp = (s) => Math.round(Number(s) * 100);
const signed = (bp) => (bp > 0 ? '+' : bp < 0 ? '−' : '±') + Math.abs(bp) + 'bp';
const monthsApart = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
const md = (t) => `${Number(t.slice(5, 7))}/${Number(t.slice(8, 10))}`;

// 글을 받은 순간 적는 기준 자료(FRED 최신판) — [저장 이름, 시리즈, 관측 수]
const FRED_BASE = [['sp500', 'SP500', 1], ['dtwexbgs', 'DTWEXBGS', 1], ['unrate', 'UNRATE', 1], ['cpilfesl', 'CPILFESL', 2], ['fed_upper', 'DFEDTARU', 1]];
// 첨삭 꾸러미
const FRED_PACKET = [['sp500', 'SP500', 5], ['dtwexbgs', 'DTWEXBGS', 5], ['unrate', 'UNRATE', 2], ['cpilfesl', 'CPILFESL', 3]];

function treasuryYears(now) {
  const t = etDate(now);
  const ys = [Number(t.slice(0, 4))];
  // 1-2월에는 전년도 파일도 읽는다 — 2월 초에는 그해 관측만으로 최근 20개가 안 찬다.
  if (['01', '02'].includes(t.slice(5, 7))) ys.unshift(ys[0] - 1);
  return ys;
}

export class TopDown {
  // core = Core(저장소·fetch·시계·env·gh·알림을 같이 쓴다)
  constructor(core, rules) {
    this.core = core;
    this.rules = rules;
  }
  get storage() { return this.core.storage; }
  get env() { return this.core.env; }
  get gh() { return this.core.gh; }
  now() { return this.core.now(); }

  // ── 알람 ───────────────────────────────────────────────────────────────
  async tick(now) {
    const ctx = { now, treasury: undefined, fred: {} };
    // 한 단계의 예상 밖 오류가 뒤 단계(특히 보관 중인 글 저장)를 막지 않게 단계마다 따로 잡는다.
    for (const [name, fn] of [['day', () => this.stepDay(ctx)], ['critique', () => this.stepCritiques(ctx)], ['report', () => this.stepReports(ctx)], ['pending', () => this.retryPending(now)], ['weekly', () => this.stepWeekly(now)]]) {
      try {
        await fn();
      } catch (e) {
        this.core.log({ op: `td.${name}`, error: (e && e.message) || String(e) });
        await this.core.alert(`td:${name}:${etDate(now)}`, `탑다운 알람(${name}) 처리 중 예상 밖 오류: ${(e && e.message) || e}`);
      }
    }
  }

  // 토요일 07:00 KST 뒤 첫 알람 — Actions 가 만든 scores/topdown.json 으로 한 번
  async stepWeekly(now) {
    const due = weeklyDue(now);
    if (!due || (await this.storage.get(`td:weekly:${due}`))) return;
    let summary = null;
    try { summary = await this.gh.get('scores/topdown.json'); } catch { summary = null; }
    if (!summary) {
      await this.core.alert(`td:weekly:${due}`, '탑다운 주간 돌아보기: scores/topdown.json 을 읽지 못했습니다(Actions 의 summary 실행·FRED_API_KEY 비밀값 확인). 다음 알람에서 다시 봅니다.');
      return;
    }
    if (await this.core.reply(weeklyText(summary, this.rules, now))) await this.storage.put(`td:weekly:${due}`, now);
  }

  async treasury(ctx) {
    if (ctx.treasury !== undefined) return ctx.treasury;
    try {
      ctx.treasury = await fetchTreasuryBoth(this.core.fetch, treasuryYears(ctx.now));
    } catch (e) {
      ctx.treasury = null;
      const kind = e instanceof SourceError ? e.kind : 'error';
      await this.core.alert(`td:treasury:${kind}:${etDate(ctx.now)}`, `탑다운: 재무부 금리 파일을 읽지 못했습니다(${kind}${e.status ? ' ' + e.status : ''}). 다음 알람에서 다시 봅니다.`);
    }
    return ctx.treasury;
  }

  async fred(ctx, id, n) {
    const k = `${id}:${n}`;
    if (!(k in ctx.fred)) {
      try { ctx.fred[k] = await fredLatest(this.core.fetch, this.env.FRED_API_KEY, id, n); } catch { ctx.fred[k] = null; }
    }
    return ctx.fred[k];
  }

  // 재무부 10 Yr 새 날짜 → 하루를 열고 아침 질문
  async stepDay(ctx) {
    const { now } = ctx;
    const lastT = await this.storage.get('td:lastT');
    const today = etDate(now);
    const etHour = Number(ET_HOUR.format(new Date(now)));
    if (!lastT || (lastT < today && etHour >= 15)) {
      const rows = await this.treasury(ctx);
      const with10 = rows ? rows.filter((r) => r[2] !== '' && r[0] <= today) : [];
      const L = with10.length ? with10[with10.length - 1][0] : null;
      if (L && (!lastT || L > lastT)) {
        if (lastT) {
          await this.closeQuestion(lastT);
          // 그 하루가 끝날 때의 내 칸 — 보고서가 늦게 올라와도 그날 칸으로 대조한다
          const prev = await this.storage.get(`td:day:${lastT}`);
          if (prev && !prev.report) { prev.cells_end = await this.cellsSnapshot(); await this.storage.put(`td:day:${lastT}`, prev); }
        }
        const i = with10.length - 1;
        const y = { t: L, y10: with10[i][2], y2: with10[i][1], prev: i > 0 ? { t: with10[i - 1][0], y10: with10[i - 1][2], y2: with10[i - 1][1] } : null };
        await this.storage.put(`td:day:${L}`, { t: L, q_at: now, sentAt: null, lastErr: null, written: false, reportDone: false, y });
        await this.storage.put('td:lastT', L);
      }
    }
    const t = await this.storage.get('td:lastT');
    if (!t) return;
    const day = await this.storage.get(`td:day:${t}`);
    if (!day || day.written) return;
    if (!day.sentAt) {
      const r = await sendMessage(this.core.fetch, this.env.TELEGRAM_BOT_TOKEN, this.core.owner, await this.questionText(day));
      if (r.ok) { day.sentAt = now; day.open_cells = await this.cellsSnapshot(); } // 질문을 보낸 순간의 칸
      else {
        day.lastErr = `${r.status} ${r.description}`.trim();
        await this.core.alert(`td:qfail:${t}`, `탑다운 ${t} 아침 질문 전송 실패(${day.lastErr}). 알람마다 다시 보냅니다.`);
      }
    }
    if (day.sentAt) {
      const file = { rule: this.rules.rule, t, status: 'sent', q_at: iso(day.q_at), sent_at: iso(day.sentAt), treasury: day.y, open_cells: day.open_cells };
      const w = await this.gh.ensure(`topdown/days/${t}/question.json`, file, 't', `topdown question ${t}`);
      if (w.state === 'created' || w.state === 'exists') day.written = true;
      else await this.core.writeFailed(`topdown/days/${t}/question.json`, w);
    }
    await this.storage.put(`td:day:${t}`, day);
  }

  // 새 하루가 열리는데 지난 질문이 끝내 안 나갔으면 실패로 남긴다
  async closeQuestion(t) {
    const day = await this.storage.get(`td:day:${t}`);
    if (!day || day.written) return;
    const file = { rule: this.rules.rule, t, status: day.sentAt ? 'sent' : 'failed', q_at: iso(day.q_at), sent_at: day.sentAt ? iso(day.sentAt) : null, reason: day.sentAt ? null : (day.lastErr || 'unknown'), treasury: day.y, open_cells: day.open_cells || null };
    const w = await this.gh.ensure(`topdown/days/${t}/question.json`, file, 't', `topdown question ${t} ${file.status}`);
    if (w.state === 'created' || w.state === 'exists') { day.written = true; await this.storage.put(`td:day:${t}`, day); }
    else await this.core.writeFailed(`topdown/days/${t}/question.json`, w);
  }

  async cellsSnapshot() {
    const cur = (await this.storage.get('td:cells')) || {};
    const out = {};
    for (const [k, x] of Object.entries(cur)) {
      out[k] = { value: x.value, set_at: x.set_at, entry: x.entry, condition: x.cond ? (x.cond.approved ? { approved: x.cond.approved } : { raw: x.cond.raw }) : null };
    }
    return out;
  }

  async questionText(day) {
    const cur = (await this.storage.get('td:cells')) || {};
    const y = day.y;
    const fmt = (label, now, prev) => `${label} ${Number(now).toFixed(2)}%` + (prev ? ` (${signed(toBp(now) - toBp(prev))})` : '');
    const vals = cellList(this.rules).filter((c) => c.open).map((c) => `${c.name} ${c.values.join('/')}`).join(' · ');
    return [
      `[탑다운] ${md(day.t)} 미국 마감 — 오늘의 탑다운을 적어 주세요`,
      `재무부 ${fmt('10년물', y.y10, y.prev && y.prev.y10)} · ${fmt('2년물', y.y2, y.prev && y.prev.y2)}`,
      '',
      '지금 내 칸:',
      ...cellLines(this.rules, cur),
      '',
      '쓰는 법: 자유 글 + 바꾸는 칸만 한 줄씩. 예) 채권 우호 조건: 10년물 4.50% 넘으면 틀림',
      `값: ${vals}`,
      '사이트 보고서가 올라오기 전에 쓰면 「보고서 전」으로 남아요.',
    ].join('\n');
  }

  // ── 첨삭 ───────────────────────────────────────────────────────────────
  async stepCritiques(ctx) {
    const all = await this.storage.list({ prefix: 'td:crit:' });
    for (const [key, c] of all) {
      // 글 저장이 확인되기 전에는 첨삭하지 않는다(첨삭 답이 「글은 기록돼 있어요」라고 말하므로).
      if (await this.storage.get(`td:pending:${key.slice('td:crit:'.length)}`)) continue;
      if (!c.result) {
        const packet = await this.packet(ctx);
        const input = { entry: { text: c.text, conditions: c.conditions }, cells: c.cells, packet };
        const r = await aiCritique({ fetch: this.core.fetch, apiKey: this.env.ANTHROPIC_API_KEY, rules: this.rules, input });
        c.result = r;
        c.input = input;
        c.input_sha256 = await sha256Hex(canonical(input));
        c.done_at = ctx.now;
        await this.storage.put(key, c);
      }
      if (!c.written) {
        const r = c.result;
        const file = {
          rule: this.rules.rule, t: c.t, entry: c.entry, status: r.ok ? 'ok' : 'failed',
          model: this.rules.critique.model, served_model: r.ok ? r.served_model : null,
          prompt_sha256: await sha256Hex(this.rules.critique.system), input_sha256: c.input_sha256,
          cells: c.input.cells, packet: c.input.packet,
          questions: r.ok ? r.questions : null, conditions: r.ok ? r.conditions : null, reason: r.ok ? null : r.why,
          at: iso(c.done_at),
        };
        const w = await this.gh.ensure(`topdown/critique/${c.t}/${c.entry}.json`, file, 'entry', `topdown critique ${c.t}`);
        if (w.state === 'created' || w.state === 'exists') { c.written = true; c.url = w.htmlUrl; }
        else await this.core.writeFailed(`topdown/critique/${c.t}/${c.entry}.json`, w);
        await this.storage.put(key, c);
      }
      if (c.written && !c.sent) {
        const { text, items } = this.critiqueText(c);
        const s = await sendMessage(this.core.fetch, this.env.TELEGRAM_BOT_TOKEN, this.core.owner, text);
        if (s.ok) {
          c.sent = true;
          // msg = 이 첨삭 메시지 번호(비공개 저장소에만) — 다른 메시지를 인용한 '네' 를 가린다
          if (items.length) await this.storage.put('td:await', { t: c.t, crit: c.entry, items, msg: s.message_id ?? null });
        } else this.core.log({ op: 'td.critique.send', status: s.status });
        await this.storage.put(key, c);
      }
      if (c.written && c.sent) await this.storage.delete(key);
    }
  }

  critiqueText(c) {
    const r = c.result;
    const at = KST_HM.format(new Date(c.message_ms));
    const miss = c.input && c.input.packet && c.input.packet.missing;
    const missLine = miss && miss.length ? `⚠️ 정보 꾸러미에서 빠진 자료: ${miss.join(', ')}` : null;
    if (!r.ok) return { text: [`첨삭 실패(${r.why}) — ${at} 글은 기록돼 있어요.`, ...(missLine ? ['', missLine] : [])].join('\n'), items: [] };
    const names = Object.fromEntries(cellList(this.rules).map((x) => [x.key, x.name]));
    const lines = [`첨삭 (${at} 글)`, ...r.questions.map((q, i) => `${i + 1}. ${q}`)];
    const items = [];
    const bad = [];
    for (const k of r.conditions) {
      if (k.ok) items.push({ n: items.length + 1, cell: k.cell, raw: k.raw, entry: c.entry, interp: { series: k.series, op: k.op, value: k.value, restated: k.restated } });
      else bad.push(k);
    }
    if (items.length) {
      lines.push('', '조건을 이렇게 이해했어요:');
      for (const it of items) lines.push(`(${it.n}) ${names[it.cell]} — ${it.interp.restated}`);
      lines.push(items.length === 1 ? "맞으면 '네'" : "맞으면 '네', 일부만이면 '네 1'");
    }
    for (const k of bad) lines.push('', `(해석 못 함) ${names[k.cell]} — ${k.restated} 조건 없이 둡니다. 숫자 기준으로 다시 써 주세요.`);
    if (missLine) lines.push('', `${missLine} — 이 자료 없이 첨삭했어요.`);
    return { text: lines.join('\n'), items };
  }

  async packet(ctx) {
    const rows = await this.treasury(ctx);
    const out = {
      treasury: rows ? rows.filter((r) => r[1] !== '' || r[2] !== '').slice(-20).map(([d, y2, y10]) => ({ date: d, y2, y10 })) : null,
    };
    for (const [name, id, n] of FRED_PACKET) out[name] = await this.fred(ctx, id, n);
    const schedule = await this.core.cached('schedule', 'rules/schedule.json');
    const rowsS = schedule && Array.isArray(schedule.rows) ? schedule.rows.filter((r) => !r.cancelled && etInstant(r.t, 8, 30) > ctx.now) : []; // 08:30 ET 발표가 지난 당일은 「다음」이 아니다
    const next = (kind) => { const r = rowsS.filter((x) => x.kind === kind).map((x) => x.t).sort()[0]; return r || null; };
    const fomc = await this.core.cached('fomc', 'rules/fomc-decisions.json');
    const dec = fomc && Array.isArray(fomc.decisions) ? fomc.decisions.filter((r) => !r.cancelled).map((r) => r.date).sort() : [];
    out.next = { cpi: next('cpi'), employment: next('employment'), fomc: dec.find((d) => etInstant(d, 14, 0) > ctx.now) || null };
    out.as_of = iso(ctx.now);
    // 빠진 자료 = 꾸러미에서 비어 있는 칸 전부(칸마다 따로 적지 않고 한 번에 훑는다 — 왜 비었든 비었으면 빠진 것이다).
    out.missing = [
      ...['treasury', ...FRED_PACKET.map(([name]) => name)].filter((k) => !out[k]),
      ...(out.treasury && out.treasury.length < 20 ? ['treasury_20'] : []),
      ...Object.keys(out.next).filter((k) => !out.next[k]).map((k) => `next_${k}`),
    ];
    return out;
  }

  // ── 보고서 대조 ─────────────────────────────────────────────────────────
  async stepReports(ctx) {
    const today = etDate(ctx.now);
    const all = await this.storage.list({ prefix: 'td:day:' });
    for (const [key, day] of all) {
      if (day.reportDone || day.t < addDays(today, -REPORT_DAYS)) continue;
      let first;
      try { first = await this.gh.firstCommit(SITE_REPO, `posts/${day.t}.html`); } catch (e) {
        await this.core.alert(`td:rep:${day.t}`, `탑다운 ${day.t} 보고서 첫 커밋 조회 실패(${e.message}). 알람마다 다시 봅니다.`);
        continue;
      }
      if (!first) continue;
      if (!day.report) {
        let macro;
        try { macro = await this.gh.getAt(SITE_REPO, 'data/macro.json', first.sha); } catch (e) {
          await this.core.alert(`td:repm:${day.t}`, `탑다운 ${day.t} 보고서 판단 파일 조회 실패(${e.message}). 알람마다 다시 봅니다.`);
          continue;
        }
        day.report = { first, rc: reportCells(macro, day.t), mine: day.cells_end || await this.cellsSnapshot() };
        await this.storage.put(key, day);
      }
      if (!day.reportWritten) {
        const { first, rc, mine } = day.report;
        const file = {
          rule: this.rules.rule, t: day.t, post: `posts/${day.t}.html`, first_commit_sha: first.sha, first_commit_at: first.date,
          status: rc.status, report_date: rc.status === 'date_mismatch' ? rc.report_date : day.t,
          cells: rc.status === 'compared' ? rc.cells : null, text: rc.status === 'compared' ? rc.text : null,
          why: rc.status === 'format' ? rc.why : null, mine_at_compare: mine,
        };
        const w = await this.gh.ensure(`topdown/reports/${day.t}.json`, file, 'first_commit_sha', `topdown report ${day.t} ${rc.status}`);
        if (w.state === 'created' || w.state === 'exists') day.reportWritten = true;
        else if (w.state === 'conflict') {
          day.reportWritten = true;
          await this.core.alert(`td:repc:${day.t}`, `탑다운 ${day.t} 보고서 대조 파일이 다른 커밋으로 이미 있습니다. 새로 쓰지 않았습니다.`);
        } else await this.core.writeFailed(`topdown/reports/${day.t}.json`, w);
        await this.storage.put(key, day);
      }
      if (day.reportWritten && !day.reportSent) {
        if (await this.core.reply(this.reportText(day))) { day.reportSent = true; day.reportDone = true; }
        await this.storage.put(key, day);
      }
    }
  }

  reportText(day) {
    const { first, rc, mine } = day.report;
    const names = Object.fromEntries(cellList(this.rules).map((x) => [x.key, x.name]));
    const head = `[탑다운] ${md(day.t)} 보고서가 올라왔어요 (${KST.format(new Date(Date.parse(first.date)))} KST)`;
    if (rc.status === 'date_mismatch') return `${head}\n보고서 판단 대조 불가 — 그 커밋의 판단 날짜가 ${rc.report_date} 예요.`;
    if (rc.status === 'format') return `${head}\n보고서 판단 대조 불가 — 판단 파일 형식이 달라요(${rc.why}).`;
    const c = compare(mine, rc.cells);
    const lines = [head];
    lines.push(c.diff.length ? '다른 칸:' : '다른 칸 없음');
    for (const d of c.diff) lines.push(`· ${names[d.key]} — 나 ${d.mine} · 보고서 ${d.report}`);
    if (c.same.length) lines.push(`같은 칸: ${c.same.map((k) => names[k]).join(', ')}`);
    if (c.missing.length) lines.push(`내 칸이 비어 있음: ${c.missing.map((k) => `${names[k]}(보고서 ${rc.cells[k]})`).join(', ')}`);
    if (rc.text.policy) lines.push(`정책 경로(보고서 원문): ${rc.text.policy}`);
    if (rc.text.fx) lines.push(`달러(보고서 원문): ${rc.text.fx.length > 160 ? rc.text.fx.slice(0, 160) + '…' : rc.text.fx}`);
    lines.push('보고서 판단은 채점하지 않아요(기간 3-6개월).');
    return lines.join('\n');
  }

  // ── 텔레그램 글 ────────────────────────────────────────────────────────
  async webhook(m, update) {
    const now = this.now();
    const t = await this.storage.get('td:lastT');
    if (!t) {
      await this.core.reply('아직 첫 아침 질문 전이에요. 기록하지 않았습니다.');
      return;
    }
    const hmac = await hmacHex(this.env.SALT, String(update.update_id));
    const h16 = hmac.slice(0, 16);
    if (await this.storage.get(`td:seen:${hmac}`)) {
      const p = await this.storage.get(`td:pending:${hmac}`);
      if (p) await this.save(hmac, p, true);
      else await this.core.reply('이미 받은 글이에요.');
      return;
    }
    await this.storage.put(`td:seen:${hmac}`, now);
    const msgMs = m.date * 1000;
    const approval = parseApproval(m.text);
    if (approval) return this.approve(approval, { t, hmac, h16, msgMs, now, text: m.text, replyTo: (m.reply_to_message && m.reply_to_message.message_id) ?? null });

    const parsed = parseEntry(m.text, this.rules);
    const hasCells = Object.keys(parsed.cells).length > 0;
    const base = hasCells ? await this.snapshot(now) : null;
    const record = {
      rule: this.rules.rule, t, text: m.text, message_date: iso(msgMs), received_at: iso(now),
      cells: parsed.cells, conditions: parsed.conditions, closed: parsed.closed,
      base: base ? base.values : null, base_missing: base ? base.missing : [],
      submission_hmac: hmac,
    };
    // 지금 칸 — 칸 줄은 값과 조건을 함께 정한다(조건 없는 줄이면 조건도 없다)
    const cur = (await this.storage.get('td:cells')) || {};
    const hadCond = Object.fromEntries(Object.keys(parsed.cells).map((k) => [k, Boolean(cur[k] && cur[k].cond)]));
    for (const [k, v] of Object.entries(parsed.cells)) {
      cur[k] = { value: v, cond: parsed.conditions[k] ? { raw: parsed.conditions[k], approved: null } : null, set_at: iso(msgMs), entry: h16 };
    }
    await this.storage.put('td:cells', cur);
    // 칸을 바꾸면 그 칸의 승인 대기 해석은 무효
    const aw = await this.storage.get('td:await');
    if (aw && aw.items.some((i) => i.cell in parsed.cells)) {
      aw.items = aw.items.filter((i) => !(i.cell in parsed.cells));
      await this.storage.put('td:await', aw);
    }
    await this.storage.put(`td:crit:${hmac}`, { t, entry: h16, text: m.text, conditions: parsed.conditions, cells: await this.cellsSnapshot(), message_ms: msgMs });
    const cur2 = await this.storage.getAlarm();
    if (cur2 == null || cur2 > now + CRITIQUE_DELAY_MS || cur2 < now) await this.storage.setAlarm(now + CRITIQUE_DELAY_MS);

    const names = Object.fromEntries(cellList(this.rules).map((x) => [x.key, x.name]));
    const read = Object.entries(parsed.cells).map(([k, v]) => `${names[k]} ${v}` + (parsed.conditions[k] ? `(조건 원문: ${clip(parsed.conditions[k])})` : `(조건 없음${hadCond[k] ? ' — 앞 조건은 지워졌어요' : ''})`));
    const lines = [read.length ? `읽은 칸: ${read.join(' · ')}` : '칸 없음 — 글만 기록'];
    if (parsed.closed.length) lines.push(`${parsed.closed.map((k) => names[k]).join('·')}는 아직 받지 않는 칸이라 뺐어요.`);
    if (parsed.near.length) {
      lines.push(`칸으로 읽지 않은 줄: ${parsed.near.slice(0, 3).map((l) => `「${clip(l, 80)}」`).join(' ')}${parsed.near.length > 3 ? ` 외 ${parsed.near.length - 3}줄` : ''}`,
        '칸 줄은 「채권 우호」 또는 「채권 우호 조건: 10년물 4.50% 넘으면 틀림」 꼴만 읽어요. 칸으로 쓴 줄이면 고쳐서 다시 보내 주세요.');
    }
    lines.push('첨삭은 1-2분 뒤에 와요.');
    const pend = { kind: 'entry', path: `topdown/entries/${t}/${h16}.json`, record, mark: 'submission_hmac', label: `${md(t)} 글`, body: lines.join('\n'), since: now };
    await this.storage.put(`td:pending:${hmac}`, pend);
    await this.save(hmac, pend, false);
    if (base && base.missing.length) {
      await this.core.alert(`td:base:${etDate(now)}:${base.missing.join(',')}`, `탑다운: 글을 받은 순간 기준 자료 ${base.missing.join(', ')} 를 읽지 못했습니다. 그 자료를 쓰는 칸은 이 글 기준으로 「기준 없음」(채점 안 함)이 됩니다.`);
    }
  }

  async approve(approval, { t, hmac, h16, msgMs, now, text, replyTo }) {
    const aw = await this.storage.get('td:await');
    if (!aw || aw.items.length === 0) {
      await this.core.reply('승인할 조건 해석이 없어요. 기록하지 않았습니다.');
      return;
    }
    // 다른 메시지를 인용한 '네' 는 지금 대기 중인 해석에 대한 답이 아니다.
    if (replyTo != null && aw.msg != null && replyTo !== aw.msg) {
      await this.core.reply("인용한 메시지는 지금 승인 대기 중인 첨삭이 아니에요. 기록하지 않았습니다. 가장 최근 첨삭의 해석을 승인하려면 그 첨삭에 답장하거나 인용 없이 '네' 라고 보내 주세요.");
      return;
    }
    const nums = approval.all ? aw.items.map((i) => i.n) : approval.nums;
    const unknown = nums.filter((n) => !aw.items.some((i) => i.n === n));
    if (unknown.length) {
      await this.core.reply(`${unknown.join(', ')}번 해석은 없어요. 기록하지 않았습니다. 지금 있는 번호: ${aw.items.map((i) => i.n).join(', ')}`);
      return;
    }
    const names = Object.fromEntries(cellList(this.rules).map((x) => [x.key, x.name]));
    const cur = (await this.storage.get('td:cells')) || {};
    const approved = [];
    for (const it of aw.items.filter((i) => nums.includes(i.n))) {
      const x = cur[it.cell];
      if (!x || !x.cond || x.entry !== it.entry || x.cond.raw !== it.raw) continue; // 그 뒤 칸을 바꿨다
      x.cond.approved = { ...it.interp, approved_at: iso(msgMs), approval: h16 };
      approved.push({ cell: it.cell, entry: it.entry, entry_t: aw.t, critique: aw.crit, raw: it.raw, ...it.interp });
    }
    if (approved.length === 0) {
      await this.core.reply('그 사이 칸을 바꿔서 승인할 해석이 없어요. 기록하지 않았습니다.');
      return;
    }
    await this.storage.put('td:cells', cur);
    aw.items = aw.items.filter((i) => !approved.some((a) => a.cell === i.cell));
    await this.storage.put('td:await', aw);
    const record = { rule: this.rules.rule, t, text, message_date: iso(msgMs), received_at: iso(now), approved, submission_hmac: hmac };
    const body = `조건 승인: ${approved.map((a) => `${names[a.cell]} — ${a.restated}`).join(' · ')}`;
    const pend = { kind: 'approval', path: `topdown/approvals/${t}/${h16}.json`, record, mark: 'submission_hmac', label: `${md(t)} 조건 승인`, body, since: now };
    await this.storage.put(`td:pending:${hmac}`, pend);
    await this.save(hmac, pend, false);
  }

  // 글을 받은 순간의 기준 자료. 못 읽은 것은 null 로 두고 missing 에 적는다.
  async snapshot(now) {
    const values = { at: iso(now) };
    const missing = [];
    const ctx = { now, treasury: undefined, fred: {} };
    const today = etDate(now);
    let rows = null;
    try { rows = await fetchTreasuryBoth(this.core.fetch, treasuryYears(now)); } catch { rows = null; }
    const with10 = rows ? rows.filter((r) => r[2] !== '' && r[0] <= today) : [];
    values.treasury10 = with10.length ? { date: with10[with10.length - 1][0], value: with10[with10.length - 1][2] } : null;
    if (!values.treasury10) missing.push('treasury10');
    for (const [name, id, n] of FRED_BASE) {
      const obs = await this.fred(ctx, id, n);
      values[name] = obs ? (n === 1 ? obs[0] : obs) : null;
      // 근원 CPI 는 전월비의 기준이라 두 관측이 이어진 달이어야 한다(2025-10 처럼 한 달이 통째로 빠지면 기준 없음).
      const gap = name === 'cpilfesl' && obs && obs.length === 2 && monthsApart(obs[1].date, obs[0].date) !== 1;
      if (!obs || obs.length < n || gap) { values[name] = null; missing.push(name); }
    }
    const fomc = await this.core.cached('fomc', 'rules/fomc-decisions.json');
    if (fomc && Array.isArray(fomc.decisions)) {
      const dec = fomc.decisions.filter((r) => !r.cancelled).map((r) => r.date).sort();
      values.fomc_last = [...dec].reverse().find((d) => etInstant(d, 14, 0) <= now) || null;
      values.fomc_next = dec.find((d) => etInstant(d, 14, 0) > now) || null;
      if (!values.fomc_next) missing.push('fomc_next');
    } else {
      values.fomc_last = null;
      values.fomc_next = null;
      missing.push('fomc');
    }
    return { values, missing };
  }

  // 만들고, 안 되면 보관했다가 알람마다 다시. 「기록 완료」는 저장 확인 뒤에만.
  async save(hmac, p, retry) {
    const r = await this.gh.ensure(p.path, p.record, p.mark, `topdown ${p.kind} ${p.record.t}`);
    if (r.state === 'created' || r.state === 'exists') {
      await this.storage.delete(`td:pending:${hmac}`);
      const head = r.state === 'created' ? '기록 완료' : '이미 기록됨';
      await this.core.reply(`${head} · ${p.label}\n${p.body}\n${r.commitUrl || r.htmlUrl}`);
    } else if (r.state === 'conflict') {
      await this.storage.delete(`td:pending:${hmac}`);
      await this.core.alert(`conflict:${p.path}`, `저장 충돌: ${p.path} 에 다른 기록이 있습니다. 기록하지 않았습니다.`);
    } else if (!retry) {
      await this.core.reply(`보관 중 — 자동으로 다시 저장합니다. 새로 보내지 마세요.\n${p.label}\n${p.body}`);
    }
  }

  async retryPending(now) {
    const all = await this.storage.list({ prefix: 'td:pending:' });
    for (const [key, p] of all) {
      await this.save(key.slice('td:pending:'.length), p, true);
      if ((await this.storage.get(key)) && now - p.since > 3600e3) {
        await this.core.alert(`td:pendlate:${p.path}`, `탑다운 기록이 1시간 넘게 저장 대기 중입니다(${p.path}).`);
      }
    }
  }
}

// 판단 원장의 상태 기계 — 15분 알람과 텔레그램 webhook. Cloudflare 와 떨어져 있어 가짜 저장소·fetch·시계로 시험한다.
// 원칙: 공개 레포에는 만들기만 한다. 사람 원문은 받은 그대로 저장한다. 예상 밖 상태는 조용히 넘기지 않고 알린다.
import { signalAt, outcomeAfter, overlaps, seriesFrom } from './rule.js';
import { fetchTreasury, releaseHappened, SourceError } from './sources.js';
import { GitHub } from './github.js';
import { sendMessage } from './telegram.js';
import { aiForecast } from './ai.js';
import { parseReply, hmacHex, sha256Hex, sealHash, randomHex, etInstant, etDate, addDays, eventId } from './util.js';

export const TICK_MS = 15 * 60e3;
const CACHE_MS = 6 * 3600e3;
const ACTIVE_DAYS = 30; // t 가 이보다 오래된 일정 줄은 보지 않는다(결과 기한 t+14일보다 넉넉히)
const SITE_REPO = 'fdo2a/fdo2a.github.io';
const LOOKAHEAD_DAYS = 45; // 앞으로 이 안에 CPI·고용 줄이 하나도 없으면 일정이 바닥난 것이다(둘 다 매달 있다)

const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const KST = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const pct = (bp) => (bp / 100).toFixed(2) + '%';
const signed = (bp) => (bp > 0 ? '+' : '') + bp + 'bp';

export class Core {
  constructor({ storage, fetch, now, env, rules, log }) {
    this.storage = storage;
    this.fetch = fetch;
    this.now = now;
    this.env = env;
    this.rules = rules;
    this.log = log || (() => {});
    this.gh = new GitHub({ fetch, token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO, branch: env.GITHUB_BRANCH || 'main' });
    this.owner = Number(env.OWNER_ID);
  }

  // ── 알람 ───────────────────────────────────────────────────────────────
  async armIfMissing() {
    if ((await this.storage.getAlarm()) == null) await this.storage.setAlarm(this.now() + TICK_MS);
  }

  async alarm() {
    // 사슬이 끊기지 않게 다음 알람을 맨 먼저 건다.
    await this.storage.setAlarm(this.now() + TICK_MS);
    await this.storage.put('last_tick', this.now());
    try {
      await this.tick();
    } catch (e) {
      this.log({ op: 'tick', error: (e && e.message) || String(e) });
      await this.alert(`tick:${etDate(this.now())}`, `알람 처리 중 예상 밖 오류: ${(e && e.message) || e}`);
    }
  }

  async tick() {
    const now = this.now();
    const schedule = await this.cached('schedule', 'rules/schedule.json');
    if (!schedule || !Array.isArray(schedule.rows)) {
      await this.alert(`schedule:${etDate(now)}`, '일정 파일(rules/schedule.json)을 읽지 못했거나 형식이 다릅니다. 질문을 보낼 수 없습니다.');
      return;
    }
    const today = etDate(now);
    const horizon = addDays(today, LOOKAHEAD_DAYS);
    if (!schedule.rows.some((r) => !r.cancelled && r.t >= today && r.t <= horizon)) {
      await this.alert(`schedule-empty:${today}`, `일정 파일에 앞으로 ${LOOKAHEAD_DAYS}일 안의 CPI·고용 줄이 없습니다. 일정을 채우기 전에는 질문을 보내지 않습니다(rules-from-fred 의 schedule 실행).`);
    }
    const minT = addDays(today, -ACTIVE_DAYS);
    const rows = schedule.rows.filter((r) => !r.cancelled && r.t >= minT && now >= etInstant(r.t, 8, 30));
    const ctx = { now, schedule, series: null, seriesErr: null };
    for (const row of rows) {
      const id = eventId(row.kind, row.t);
      const ev = (await this.storage.get(`ev:${id}`)) || { id, kind: row.kind, t: row.t, final: null };
      if (ev.final === 'done') continue;
      await this.step(ev, ctx);
      await this.storage.put(`ev:${id}`, ev);
    }
    await this.retryPending(now);
  }

  async cached(key, path) {
    const now = this.now();
    const c = await this.storage.get(`cache:${key}`);
    if (c && now - c.at < CACHE_MS) return c.value;
    let value = null;
    try { value = await this.gh.get(path); } catch { value = null; }
    if (value) {
      await this.storage.put(`cache:${key}`, { at: now, value });
      return value;
    }
    if (c) await this.alert(`stale:${key}:${etDate(now)}`, `${path} 를 새로 읽지 못해 ${Math.round((now - c.at) / 3600e3)}시간 전 사본으로 진행합니다.`);
    return (c && c.value) || null;
  }

  async getSeries(ctx, t) {
    if (ctx.series || ctx.seriesErr) return ctx.series;
    const years = new Set([Number(t.slice(0, 4)), Number(etDate(ctx.now).slice(0, 4))]);
    if (t.slice(5, 7) === '01') years.add(Number(t.slice(0, 4)) - 1);
    try {
      ctx.series = seriesFrom(await fetchTreasury(this.fetch, [...years].sort()));
    } catch (e) {
      ctx.seriesErr = e;
      const kind = e instanceof SourceError ? e.kind : 'error';
      await this.alert(`treasury:${kind}:${etDate(ctx.now)}`, `재무부 금리 파일을 읽지 못했습니다(${kind}${e.status ? ' ' + e.status : ''}). 다음 알람에서 다시 봅니다.`);
    }
    return ctx.series;
  }

  // ── 사건 하나 ───────────────────────────────────────────────────────────
  async step(ev, ctx) {
    const { now } = ctx;
    const cfg = this.rules.events[ev.kind];
    const confirmDeadline = etInstant(addDays(ev.t, 1), 12, 0);

    // 질문 전: 발표 확인 → y_t 확인 → Q
    if (!ev.q && !ev.final) {
      if (!ev.confirmed) {
        try {
          if (await releaseHappened(this.fetch, this.env.FRED_API_KEY, cfg.fred_release_id, ev.t)) {
            ev.confirmed = { source: 'fred', release_id: cfg.fred_release_id, confirmed_at: iso(now) };
          }
        } catch (e) {
          await this.alert(`fred:${ev.id}:${e.kind || 'error'}`, `${ev.id} FRED 발표 확인 조회 실패(${e.kind || 'error'}${e.status ? ' ' + e.status : ''}). 다음 알람에서 다시 봅니다.`);
        }
      }
      const series = await this.getSeries(ctx, ev.t);
      const sig = series ? signalAt(series, ev.t) : null;
      if (ev.confirmed && sig && sig.status !== 'series_missing') {
        ev.sig = sig;
        if (sig.status === 'no_signal') {
          ev.final = 'no_signal';
        } else {
          ev.q = now;
          ev.d = now + this.rules.timing.deadline_minutes_after_q * 60e3;
          ev.packet = {
            event: ev.id, kind: ev.kind, t: ev.t, tm1: sig.tm1, y_tm1: sig.y_tm1, y_t: sig.y_t, d0: sig.d0,
            recent: series.filter((r) => r.date <= ev.t).slice(-20).map((r) => [r.date, r.bp]),
          };
          try {
            ev.ai_brief_published_at = await this.gh.firstCommitDate(SITE_REPO, `posts/${ev.t}.html`);
          } catch {
            ev.ai_brief_published_at = 'lookup_failed';
          }
        }
      } else if (now >= confirmDeadline) {
        ev.final = !ev.confirmed ? 'held_unconfirmed' : 'series_missing';
        ev.missing = !ev.confirmed ? null : (sig ? sig.missing : ['series_unreadable']);
        await this.alert(`final:${ev.id}`, ev.final === 'held_unconfirmed'
          ? `${ev.id} 질문 못 보냄: 보류: 발표 미확인 — FRED 에 ${ev.t} 발표가 없습니다. 날짜가 바뀌었으면 rules/schedule.json 에 새 줄을 더해 주세요.`
          : `${ev.id} 질문 못 보냄: 시리즈 결측(${(ev.missing || []).join(',')}).`);
      }
    }

    // 사건 파일 — 질문(Q) 또는 질문 없는 최종 상태가 정해지면 한 번
    if ((ev.q || ev.final) && !ev.eventWritten) {
      const status = ev.q ? 'questioned' : ev.final;
      const r = await this.gh.ensure(`events/${ev.id}.json`, this.eventFile(ev, status), 'event', `event ${ev.id} ${status}`);
      if (r.state === 'created' || r.state === 'exists') ev.eventWritten = true;
      else await this.writeFailed(`events/${ev.id}.json`, r);
    }
    if (!ev.q) {
      if (ev.final && ev.eventWritten) ev.final = 'done';
      return;
    }
    if (!ev.eventWritten) return; // 사건 파일이 먼저다

    await this.stepQuestion(ev, now);
    await this.stepAi(ev, now);
    await this.stepOutcome(ev, ctx);

    const aiDone = ev.ai && (ev.ai.revealWritten || ev.ai.missingWritten);
    if (ev.deliveryWritten && aiDone && ev.outcomeWritten) ev.final = 'done';
  }

  eventFile(ev, status) {
    return {
      event: ev.id, kind: ev.kind, t: ev.t, rule: this.rules.rule, status,
      confirm: ev.confirmed || null,
      tm1: ev.sig ? ev.sig.tm1 : null, y_tm1: ev.sig ? ev.sig.y_tm1 : null, y_t: ev.sig ? ev.sig.y_t : null, d0: ev.sig ? ev.sig.d0 : null,
      missing: ev.missing || null,
      q_at: ev.q ? iso(ev.q) : null,
      deadline_at: ev.d ? iso(ev.d) : null,
      info_cutoff: ev.q ? iso(ev.q) : null,
      ai_brief_published_at: ev.ai_brief_published_at ?? null,
      packet: ev.packet || null,
    };
  }

  async stepQuestion(ev, now) {
    ev.question = ev.question || { sentAt: null };
    if (ev.deliveryWritten) return;
    if (!ev.question.sentAt && now <= ev.d) {
      const r = await sendMessage(this.fetch, this.env.TELEGRAM_BOT_TOKEN, this.owner, this.questionText(ev));
      if (r.ok) ev.question.sentAt = now;
      else ev.question.lastErr = `${r.status} ${r.description}`.trim();
    }
    let file = null;
    if (ev.question.sentAt) file = { event: ev.id, status: 'delivered', sent_at: iso(ev.question.sentAt) };
    else if (now > ev.d) file = { event: ev.id, status: 'failed', reason: ev.question.lastErr || 'unknown' };
    if (!file) return;
    const r = await this.gh.ensure(`delivery/${ev.id}.json`, file, 'event', `delivery ${ev.id} ${file.status}`);
    if (r.state === 'created' || r.state === 'exists') {
      ev.deliveryWritten = true;
      if (file.status === 'failed') await this.alert(`qfail:${ev.id}`, `${ev.id} 질문 실패 — 마감까지 텔레그램 전송이 한 번도 성공하지 못했습니다(${file.reason}). AI 예측과 채점은 그대로 진행합니다.`);
    } else await this.writeFailed(`delivery/${ev.id}.json`, r);
  }

  questionText(ev) {
    const label = this.rules.events[ev.kind].label;
    const p = ev.packet;
    const recent = p.recent.slice(-6).map(([d, bp]) => `${d.slice(5)} ${pct(bp)}`).join(' · ');
    return [
      `[매크로 판단] 미국 ${label} 발표일 질문`,
      `사건: ${ev.id}`,
      `재무부 2년물: ${p.tm1.slice(5)} ${pct(p.y_tm1)} → ${p.t.slice(5)} ${pct(p.y_t)} (${signed(p.d0)})`,
      `최근: ${recent}`,
      '',
      `질문: 이 움직임이 재무부 값 5번째 날(t+5)까지 같은 방향으로 이어질 확률은?`,
      `마감: ${KST.format(new Date(ev.d))} KST (${ET.format(new Date(ev.d))} ET)`,
      '',
      '답장 형식: 첫 줄 0-100 숫자, 둘째 줄부터 근거',
      '원칙: 이 질문 이후 나온 뉴스·가격은 보지 않고 답합니다.',
    ].join('\n');
  }

  async stepAi(ev, now) {
    ev.ai = ev.ai || { state: 'none' };
    const a = ev.ai;
    if (a.state === 'none') {
      const r = await aiForecast({ fetch: this.fetch, apiKey: this.env.ANTHROPIC_API_KEY, rules: this.rules, packet: ev.packet });
      if (r.ok) {
        const plain = { event: ev.id, model: this.rules.ai.model, p: r.p, prompt_sha256: await sha256Hex(this.rules.ai.system), reason: r.reason, rule: this.rules.rule };
        const nonce = randomHex(32);
        Object.assign(a, { state: 'sealed', plain, nonce, served_model: r.served_model, sha256: await sealHash(plain, nonce), at: now });
      } else {
        Object.assign(a, { state: 'missing', why: r.why, at: now });
      }
    }
    if (a.state === 'sealed' && !a.commitWritten) {
      const file = { event: ev.id, rule: this.rules.rule, sha256: a.sha256, model: a.plain.model, prompt_sha256: a.plain.prompt_sha256, sealed_at: iso(a.at) };
      const r = await this.gh.ensure(`ai/${ev.id}/commit.json`, file, 'sha256', `ai commit ${ev.id}`);
      if (r.state === 'created' || r.state === 'exists') a.commitWritten = true;
      else await this.writeFailed(`ai/${ev.id}/commit.json`, r);
    }
    if (a.state === 'sealed' && a.commitWritten && !a.revealWritten && now > ev.d) {
      const file = { event: ev.id, sha256: a.sha256, plain: a.plain, nonce: a.nonce, served_model: a.served_model };
      const r = await this.gh.ensure(`ai/${ev.id}/reveal.json`, file, 'sha256', `ai reveal ${ev.id}`);
      if (r.state === 'created' || r.state === 'exists') a.revealWritten = true;
      else await this.writeFailed(`ai/${ev.id}/reveal.json`, r);
    }
    if (a.state === 'missing' && !a.missingWritten) {
      const r = await this.gh.ensure(`ai/${ev.id}/missing.json`, { event: ev.id, reason: a.why, at: iso(a.at) }, 'event', `ai missing ${ev.id}`);
      if (r.state === 'created' || r.state === 'exists') {
        a.missingWritten = true;
        await this.alert(`aimiss:${ev.id}`, `${ev.id} AI 예측 기권: ${a.why}`);
      } else await this.writeFailed(`ai/${ev.id}/missing.json`, r);
    }
  }

  async stepOutcome(ev, ctx) {
    if (ev.outcomeWritten) return;
    const series = await this.getSeries(ctx, ev.t);
    if (!series) return;
    let out = outcomeAfter(series, ev.t, ev.sig.d0);
    if (out.status === 'pending') {
      if (ctx.now < etInstant(addDays(ev.t, 14), 12, 0)) return;
      out = { status: 'value_shortage', have: out.have };
      await this.alert(`short:${ev.id}`, `${ev.id} 보류: 값 부족 — t+14일까지 재무부 값이 ${out.have}개뿐입니다.`);
    }
    if (out.t5) {
      const others = ctx.schedule.rows.filter((r) => !r.cancelled && r.t !== ev.t).map((r) => r.t);
      const fomc = await this.cached('fomc', 'rules/fomc-decisions.json');
      if (!fomc || !Array.isArray(fomc.decisions)) {
        await this.alert(`fomc:${etDate(ctx.now)}`, 'FOMC 결정일 파일(rules/fomc-decisions.json)을 읽지 못해 결과 확정을 미룹니다.');
        return;
      }
      const fomcDates = fomc.decisions.filter((r) => !r.cancelled).map((r) => r.date);
      out.overlap = overlaps(ev.t, out.t5, [...others, ...fomcDates]);
    }
    // 같은 날 AI 시황 브리프의 공개 시각 — Q 에는 아직 없을 때가 많아 결과 확정 때 다시 본다.
    let brief = null;
    try { brief = await this.gh.firstCommitDate(SITE_REPO, `posts/${ev.t}.html`); } catch { brief = 'lookup_failed'; }
    const file = { event: ev.id, kind: ev.kind, t: ev.t, rule: this.rules.rule, d0: ev.sig.d0, y_t: ev.sig.y_t, ...out, ai_brief_published_at: brief };
    const r = await this.gh.ensure(`outcomes/${ev.id}.json`, file, 'event', `outcome ${ev.id} ${out.status}`);
    if (r.state === 'created' || r.state === 'exists') ev.outcomeWritten = true;
    else await this.writeFailed(`outcomes/${ev.id}.json`, r);
  }

  // ── 텔레그램 답장 ────────────────────────────────────────────────────────
  async webhook({ secret, update }) {
    if (!this.env.WEBHOOK_SECRET || secret !== this.env.WEBHOOK_SECRET) return { status: 401 };
    await this.armIfMissing();
    const m = update && update.message;
    if (!m || !m.chat || m.chat.type !== 'private' || !m.from || m.from.id !== this.owner || m.chat.id !== this.owner) return { status: 200 };
    if (typeof m.text !== 'string') return { status: 200 };
    const now = this.now();
    const ev = await this.openEvent();
    if (!ev) {
      await this.reply('지금 열린 질문이 없습니다. 기록하지 않았습니다.');
      return { status: 200 };
    }
    const parsed = parseReply(m.text);
    if (!parsed.ok) {
      await this.reply(`형식이 맞지 않아 기록하지 않았습니다(${parsed.why}).\n첫 줄에 0-100 숫자, 둘째 줄부터 근거를 적어 주세요.\n사건: ${ev.id}`);
      return { status: 200 };
    }
    const hmac = await hmacHex(this.env.SALT, String(update.update_id));
    const msgMs = m.date * 1000;
    const record = {
      event: ev.id, rule: this.rules.rule, text: m.text, p: parsed.p, reason: parsed.reason,
      message_date: iso(msgMs), received_at: iso(now), on_time: msgMs <= ev.d, deadline_at: iso(ev.d),
      submission_hmac: hmac,
    };
    const path = `human/${ev.id}/${hmac.slice(0, 16)}.json`;
    await this.storage.put(`pending:${hmac}`, { path, record, since: now });
    await this.saveHuman(hmac, path, record, false);
    return { status: 200 };
  }

  async openEvent() {
    const all = await this.storage.list({ prefix: 'ev:' });
    let best = null;
    for (const ev of all.values()) {
      if (ev.q && !ev.outcomeWritten && (!best || ev.q > best.q)) best = ev;
    }
    return best;
  }

  async saveHuman(hmac, path, record, retry) {
    const r = await this.gh.ensure(path, record, 'submission_hmac', `human ${record.event}`);
    const cls = record.on_time ? '마감 전' : '마감 후';
    if (r.state === 'created' || r.state === 'exists') {
      await this.storage.delete(`pending:${hmac}`);
      const head = r.state === 'created' ? '기록 완료' : '이미 기록됨';
      await this.reply(`${head} · ${record.event} · 지속 확률 ${record.p}% · ${cls}\n${r.commitUrl || r.htmlUrl}`);
    } else if (r.state === 'conflict') {
      await this.storage.delete(`pending:${hmac}`);
      await this.alert(`conflict:${path}`, `저장 충돌: ${path} 에 다른 제출이 있습니다. 기록하지 않았습니다.`);
    } else if (!retry) {
      await this.reply(`보관 중 — 자동으로 다시 저장합니다. 새로 보내지 마세요.\n${record.event} · 지속 확률 ${record.p}%`);
    }
  }

  async retryPending(now) {
    const all = await this.storage.list({ prefix: 'pending:' });
    for (const [key, p] of all) {
      const hmac = key.slice('pending:'.length);
      await this.saveHuman(hmac, p.path, p.record, true);
      const ev = await this.storage.get(`ev:${p.record.event}`);
      if ((await this.storage.get(key)) && ev && now > ev.d) {
        await this.alert(`pendlate:${hmac}`, `${p.record.event} 사람 제출이 마감 뒤까지 저장 대기 중입니다(${p.path}).`);
      }
    }
  }

  // ── 알림 ───────────────────────────────────────────────────────────────
  async reply(text) {
    const r = await sendMessage(this.fetch, this.env.TELEGRAM_BOT_TOKEN, this.owner, text);
    if (!r.ok) this.log({ op: 'reply', status: r.status });
    return r.ok;
  }

  // 같은 열쇠로는 한 번만 보낸다(15분마다 같은 알림이 쌓이지 않게).
  async alert(key, text) {
    if (await this.storage.get(`alerted:${key}`)) return;
    if (await this.reply(`⚠️ ${text}`)) await this.storage.put(`alerted:${key}`, this.now());
  }

  async writeFailed(path, r) {
    await this.alert(`write:${path}:${etDate(this.now())}`, `GitHub 저장 실패(${r.state}${r.status ? ' ' + r.status : ''}): ${path} — 다음 알람에서 다시 시도합니다.`);
  }

  async health() {
    return { alarm: await this.storage.getAlarm(), last_tick: (await this.storage.get('last_tick')) || null };
  }
}

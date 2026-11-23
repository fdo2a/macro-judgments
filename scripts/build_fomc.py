#!/usr/bin/env python3
"""FOMC 결정일 목록 → rules/fomc-decisions.json (겹침 판정용).

출처: 연준 공식 페이지. 2021년부터는 fomccalendars.htm, 그 전은 연도별 fomchistorical<YYYY>.htm.
결정일 = **정례 회의(Meeting)의 마지막 날**. 화상회의(Conference Call)·서면 결의(notation vote)·
결정 없는 전략 회의(Strategy Meeting)는 넣지 않는다 — 긴급 결정(예: 2008-01-22, 2020-03-15)은
겹침에서 빠진다(rules/v1.json 에 한계로 적는다).

    python3 scripts/build_fomc.py --start 2000 --out rules/fomc-decisions.json
"""
import argparse
import datetime as dt
import html
import json
import re
import sys
import urllib.request

UA = 'macro-judgments (research ledger)'
CAL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'
HIST = 'https://www.federalreserve.gov/monetarypolicy/fomchistorical{y}.htm'
MONTHS = {m: i for i, m in enumerate(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
                                      'september', 'october', 'november', 'december'], 1)}
MON3 = {k[:3]: v for k, v in MONTHS.items()}
# 페이지에 「Meeting」으로 적혔지만 정책 결정이 없던 날(연준 페이지로 확인). 이유를 남긴다.
EXCLUDE = {'2003-09-15': '특별 회의 — 결정은 다음 날(2003-09-16) 정례 회의'}


def _month(name):
    n = name.strip().lower()
    return MONTHS.get(n) or MON3.get(n[:3])


def last_day(year, month_text, day_text):
    """'January','27-28' → (1,28) / 'Apr/May','30-1' → (5,1) / 'March','18' → (3,18)."""
    months = [m for m in re.split(r'[/-]', month_text) if m.strip()]
    days = re.findall(r'\d+', day_text)
    if not months or not days:
        raise ValueError(f'bad meeting date: {month_text!r} {day_text!r}')
    m = _month(months[-1])
    if m is None:
        raise ValueError(f'bad month: {month_text!r}')
    return dt.date(year, m, int(days[-1])).isoformat()


def _text(s):
    return html.unescape(re.sub(r'<[^>]+>', ' ', s))


def parse_calendars(page):
    """fomccalendars.htm → [(date, note)] 정례 회의만."""
    out = []
    blocks = re.split(r'(\d{4}) FOMC Meetings', page)
    for i in range(1, len(blocks) - 1, 2):
        year = int(blocks[i])
        body = blocks[i + 1]
        for row in re.findall(r'<div class="[^"]*fomc-meeting"[^>]*>(.*?)(?=<div class="[^"]*fomc-meeting"|</div>\s*</div>\s*</div>|$)', body, re.S):
            mm = re.search(r'fomc-meeting__month[^>]*>(.*?)</div>', row, re.S)
            dd = re.search(r'fomc-meeting__date[^>]*>(.*?)</div>', row, re.S)
            if not mm or not dd:
                continue
            note = _text(row).lower()
            if 'strategy meeting' in note or 'notation vote' in note or 'unscheduled' in note:
                continue
            out.append(last_day(year, _text(mm.group(1)), _text(dd.group(1))))
    return out


def parse_historical(page, year):
    """fomchistorical<YYYY>.htm → 'Month D(-D) Meeting - YYYY' 머리만."""
    out = []
    for h in re.findall(r'<h5[^>]*>(.*?)</h5>', page, re.S):
        t = ' '.join(_text(h).split())
        m = re.match(r'^([A-Za-z/]+)\s+([\d\-\s/A-Za-z]*?\d+)\s+Meeting\s*-\s*(\d{4})$', t)
        if not m or int(m.group(3)) != year:
            continue
        mon, days = m.group(1), m.group(2)
        # 'April 30-May 1' 같은 꼴
        mm = re.match(r'^(\d+)\s*-\s*([A-Za-z]+)\s+(\d+)$', days)
        if mm:
            out.append(dt.date(year, _month(mm.group(2)), int(mm.group(3))).isoformat())
        else:
            out.append(last_day(year, mon, days))
    return out


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode('utf-8', 'replace')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--start', type=int, default=2000)
    ap.add_argument('--out', default='rules/fomc-decisions.json')
    a = ap.parse_args()
    cal = parse_calendars(fetch(CAL))
    first_cal_year = min(int(d[:4]) for d in cal)
    dates = set(cal)
    for y in range(a.start, first_cal_year):
        got = parse_historical(fetch(HIST.format(y=y)), y)
        if len(got) < 6:
            sys.exit(f'{y}: 정례 회의가 {len(got)}개뿐 — 페이지 형식을 확인할 것')
        dates.update(got)
    dates -= set(EXCLUDE)
    per_year = {}
    for d in dates:
        per_year[d[:4]] = per_year.get(d[:4], 0) + 1
    odd = {y: n for y, n in per_year.items() if n != 8}
    doc = {
        'source': [CAL, HIST.format(y='YYYY')],
        'fetched_at': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'definition': '정례 회의(Meeting)의 마지막 날. 화상회의·서면 결의·결정 없는 전략 회의는 넣지 않는다. 바뀌면 새 줄을 더하고 옛 줄에는 cancelled 사유를 붙인다.',
        'excluded': EXCLUDE,
        'years_not_8': odd,
        'years_not_8_why': {'2020': '3월 정례 회의가 3/15 긴급 회의로 대체(긴급 회의는 넣지 않음)', '2027': '10/26-27 은 결정 없는 전략 회의'},
        'decisions': [{'date': d} for d in sorted(dates)],
    }
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print(f'{len(dates)} decisions, years with != 8: {odd}')


if __name__ == '__main__':
    main()

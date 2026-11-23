import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from build_fomc import last_day, parse_calendars, parse_historical  # noqa: E402

CAL = '''<h4><a>2027 FOMC Meetings</a></h4></div>
<div class="row fomc-meeting" "><div class="fomc-meeting__month col"><strong>January</strong></div>
<div class="fomc-meeting__date col">26-27</div></div>
<div class="row fomc-meeting" "><div class="fomc-meeting__month col"><strong>Apr/May</strong></div>
<div class="fomc-meeting__date col">30-1*</div></div>
<div class="row fomc-meeting" "><div class="fomc-meeting__month col"><strong>October</strong></div>
<div class="fomc-meeting__date col">26-27</div><div>Monetary Policy Strategy Meeting</div></div>
<div class="row fomc-meeting" "><div class="fomc-meeting__month col"><strong>November</strong></div>
<div class="fomc-meeting__date col">16-17</div></div>
'''
HIST = '<h5>January 21 Conference Call - 2008</h5><h5>January 29-30 Meeting - 2008</h5><h5>March 18 Meeting - 2008</h5>'


def test_last_day():
    assert last_day(2027, 'January', '26-27') == '2027-01-27'
    assert last_day(2027, 'Apr/May', '30-1*') == '2027-05-01'
    assert last_day(2026, 'March', '18') == '2026-03-18'


def test_calendars_skips_strategy_meeting():
    assert parse_calendars(CAL) == ['2027-01-27', '2027-05-01', '2027-11-17']


def test_historical_meetings_only():
    assert parse_historical(HIST, 2008) == ['2008-01-30', '2008-03-18']

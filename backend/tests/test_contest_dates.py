"""Tests for the contest date helpers in app.api.contests.

The voting period runs the first week of the month after the contest month,
ending end-of-day on the 7th (VOTING_DEADLINE_DAY).

Run with `pytest backend/tests/test_contest_dates.py` if pytest is installed,
or directly via `python backend/tests/test_contest_dates.py`.
"""

import os
import sys
from datetime import date
from pathlib import Path
from types import SimpleNamespace

# Ensure the backend root is on sys.path so `app.*` imports work whether
# this is run from the repo root or backend/.
BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_ROOT))

# Provide minimum env so config validation passes when the module is imported.
os.environ.setdefault("FRONTEND_URL", "https://selah.example.com")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test")
os.environ.setdefault("JWT_SECRET", "test-secret-not-used")

from app.api.contests import (  # noqa: E402
    CONTEST_EVENT_TIME,
    VOTING_DEADLINE_DAY,
    _build_submission_event_fields,
    _build_voting_event_fields,
    _contest_begins_date,
    _submission_deadline_date,
    _voting_deadline_date,
)


def test_voting_deadline_day_is_seven():
    # The product rule: voting lasts the first week of the following month.
    assert VOTING_DEADLINE_DAY == 7


def test_voting_deadline_is_seventh_of_next_month():
    assert _voting_deadline_date("2026-03") == "2026-04-07"


def test_voting_deadline_wraps_december_into_next_year():
    assert _voting_deadline_date("2026-12") == "2027-01-07"


def test_voting_deadline_zero_pads_month_and_day():
    assert _voting_deadline_date("2026-09") == "2026-10-07"
    assert _voting_deadline_date("2026-08") == "2026-09-07"


def test_voting_deadline_all_months_land_on_the_seventh_of_the_next_month():
    for month in range(1, 13):
        result = _voting_deadline_date(f"2026-{month:02d}")
        parsed = date.fromisoformat(result)  # also validates YYYY-MM-DD shape
        assert parsed.day == VOTING_DEADLINE_DAY
        if month == 12:
            assert (parsed.year, parsed.month) == (2027, 1)
        else:
            assert (parsed.year, parsed.month) == (2026, month + 1)


def test_submission_deadline_is_last_day_of_contest_month():
    assert _submission_deadline_date("2026-04") == "2026-04-30"
    assert _submission_deadline_date("2026-12") == "2026-12-31"


def test_submission_deadline_handles_february_and_leap_years():
    assert _submission_deadline_date("2026-02") == "2026-02-28"
    assert _submission_deadline_date("2028-02") == "2028-02-29"


def test_contest_begins_on_first_of_contest_month():
    assert _contest_begins_date("2026-07") == "2026-07-01"


def test_voting_event_scheduled_on_voting_deadline():
    contest = SimpleNamespace(month="2026-12", theme="Night Lights")
    fields = _build_voting_event_fields(contest)
    assert fields["date"] == "2027-01-07"
    assert fields["time"] == CONTEST_EVENT_TIME
    assert "Night Lights" in fields["title"]


def test_submission_event_scheduled_on_last_day_of_month():
    contest = SimpleNamespace(month="2026-02", theme="Winter Light")
    fields = _build_submission_event_fields(contest)
    assert fields["date"] == "2026-02-28"
    assert fields["time"] == CONTEST_EVENT_TIME


if __name__ == "__main__":
    # Allow `python tests/test_contest_dates.py` for environments
    # without pytest installed.
    tests = [v for k, v in list(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in tests:
        try:
            fn()
            print(f"PASS  {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL  {fn.__name__}: {e}")
        except Exception as e:
            failed += 1
            print(f"ERROR {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)

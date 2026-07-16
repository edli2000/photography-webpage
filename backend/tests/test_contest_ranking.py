"""Tests for the dense-ranking winner calculation in app.api.contests.

Placement rules: every submission whose tally is among the top three distinct
vote counts places; ties share the place (several firsts/seconds/thirds are
possible). Within a place, earlier submissions are listed first. Honorable
mentions no longer exist.

Run with `pytest backend/tests/test_contest_ranking.py` if pytest is
installed, or directly via `python backend/tests/test_contest_ranking.py`.
"""

import os
import sys
from datetime import datetime, timedelta, timezone
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

from app.api.contests import _rank_for_category, _winners_from_tallies  # noqa: E402

T0 = datetime(2026, 3, 1, tzinfo=timezone.utc)


def _entries(*votes_list: int) -> list:
    """Build (submission_id, votes, created_at) entries; id N submitted Nth."""
    return [(i + 1, votes, T0 + timedelta(hours=i)) for i, votes in enumerate(votes_list)]


def _places(winners: list[dict]) -> list[tuple[int, int]]:
    return [(w["submissionId"], w["place"]) for w in winners]


def test_no_ties_top_three_place_fourth_excluded():
    winners = _rank_for_category(_entries(10, 8, 5, 2), "theme")
    assert _places(winners) == [(1, 1), (2, 2), (3, 3)]


def test_tie_for_first_all_get_first_place():
    winners = _rank_for_category(_entries(10, 10, 8, 5), "theme")
    assert _places(winners) == [(1, 1), (2, 1), (3, 2), (4, 3)]


def test_tie_for_third_all_get_third_place():
    winners = _rank_for_category(_entries(10, 8, 5, 5, 5, 2), "theme")
    assert _places(winners) == [(1, 1), (2, 2), (3, 3), (4, 3), (5, 3)]


def test_all_tied_everyone_wins_first():
    winners = _rank_for_category(_entries(7, 7, 7, 7), "favorite")
    assert _places(winners) == [(1, 1), (2, 1), (3, 1), (4, 1)]


def test_fewer_than_three_distinct_tallies():
    winners = _rank_for_category(_entries(4, 4, 2), "theme")
    assert _places(winners) == [(1, 1), (2, 1), (3, 2)]


def test_single_entry_places_first():
    winners = _rank_for_category(_entries(1), "theme")
    assert _places(winners) == [(1, 1)]


def test_empty_entries_produce_no_winners():
    assert _rank_for_category([], "theme") == []


def test_fourth_distinct_tally_never_places_even_with_ties():
    winners = _rank_for_category(_entries(9, 9, 8, 7, 6, 6), "theme")
    assert _places(winners) == [(1, 1), (2, 1), (3, 2), (4, 3)]


def test_ties_ordered_by_submission_time_within_place():
    # id 3 submitted before ids 1-2? Build explicitly: later id, earlier time.
    entries = [
        (1, 5, T0 + timedelta(hours=2)),
        (2, 5, T0 + timedelta(hours=1)),
        (3, 5, T0),
    ]
    winners = _rank_for_category(entries, "theme")
    assert _places(winners) == [(3, 1), (2, 1), (1, 1)]


def test_category_is_propagated():
    winners = _rank_for_category(_entries(3, 1), "wildcard")
    assert all(w["category"] == "wildcard" for w in winners)


# --- _winners_from_tallies (imported contests) ---


def _sub(sub_id: int, tallies: dict | None, hours: int = 0) -> SimpleNamespace:
    return SimpleNamespace(
        id=sub_id,
        category_vote_tallies=tallies,
        created_at=T0 + timedelta(hours=hours),
    )


def test_tallies_rank_each_category_independently():
    contest = SimpleNamespace(
        wildcard_category="Best Use of Color",
        submissions=[
            _sub(1, {"theme": 10, "favorite": 2, "wildcard": 0}, hours=0),
            _sub(2, {"theme": 10, "favorite": 5, "wildcard": 3}, hours=1),
            _sub(3, {"theme": 4, "favorite": 5, "wildcard": 0}, hours=2),
        ],
    )
    winners = _winners_from_tallies(contest)
    by_cat = {}
    for w in winners:
        by_cat.setdefault(w["category"], []).append((w["submissionId"], w["place"]))
    assert by_cat["theme"] == [(1, 1), (2, 1), (3, 2)]
    assert by_cat["favorite"] == [(2, 1), (3, 1), (1, 2)]
    assert by_cat["wildcard"] == [(2, 1)]


def test_zero_tallies_never_place():
    contest = SimpleNamespace(
        wildcard_category=None,
        submissions=[
            _sub(1, {"theme": 0, "favorite": 0, "wildcard": 0}),
            _sub(2, {"theme": 1, "favorite": 0, "wildcard": 0}, hours=1),
        ],
    )
    winners = _winners_from_tallies(contest)
    assert _places(winners) == [(2, 1)]


def test_wildcard_ignored_without_wildcard_category():
    contest = SimpleNamespace(
        wildcard_category=None,
        submissions=[_sub(1, {"theme": 0, "favorite": 0, "wildcard": 9})],
    )
    assert _winners_from_tallies(contest) == []


def test_unfinalized_submissions_without_tallies_are_skipped():
    contest = SimpleNamespace(
        wildcard_category=None,
        submissions=[_sub(1, None), _sub(2, None, hours=1)],
    )
    assert _winners_from_tallies(contest) == []


if __name__ == "__main__":
    # Allow `python tests/test_contest_ranking.py` for environments
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

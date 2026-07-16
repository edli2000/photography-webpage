"""move contest voting-deadline events from the 14th to the 7th

Revision ID: 022
Revises: 021
Create Date: 2026-07-15

The contest voting period was shortened from the first two weeks of the month
after the contest month (ending EOD on the 14th) to the first week (ending EOD
on the 7th). New and edited contests get the new date from
app/api/contests.py::_voting_deadline_date; this migration brings the
already-scheduled "contest-{id}-voting-deadline" calendar events in line.

Deliberately conservative, mirroring _update_contest_events policy:
- Completed contests are skipped — their deadline events are historical.
- Only events whose date still equals the old computed default (the 14th of
  the month after the contest month) are rewritten, so an event an admin
  manually rescheduled keeps its custom date.
- Contests whose month field is not YYYY-MM are skipped rather than erroring.
  The regex filter lives in an AS MATERIALIZED CTE because plain WHERE
  predicates have no guaranteed evaluation order, so to_date() could otherwise
  run on (and choke on) an unvalidated month value.

Idempotent: once rewritten to the 7th the WHERE clause no longer matches.
Downgrade is the symmetric reverse (7th back to 14th) under the same guards.
"""

from alembic import op


# The 14th/7th of the month after the contest month, as YYYY-MM-DD text.
_NEXT_MONTH_PREFIX = (
    "to_char(to_date(c.month || '-01', 'YYYY-MM-DD') + interval '1 month', 'YYYY-MM')"
)


def _rewrite(from_day: str, to_day: str) -> str:
    return f"""
        WITH c AS MATERIALIZED (
            SELECT id, month
            FROM contests
            WHERE status != 'completed'
              AND month ~ '^\\d{{4}}-\\d{{2}}$'
        )
        UPDATE events e
        SET date = {_NEXT_MONTH_PREFIX} || '-{to_day}'
        FROM c
        WHERE e.id = 'contest-' || c.id || '-voting-deadline'
          AND e.date = {_NEXT_MONTH_PREFIX} || '-{from_day}'
    """


revision = "022"
down_revision = "021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(_rewrite("14", "07"))


def downgrade() -> None:
    op.execute(_rewrite("07", "14"))

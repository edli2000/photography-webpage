import asyncio
import calendar
import math
import mimetypes
import uuid
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, Form, HTTPException, Query, Request, Response, UploadFile, status
from sqlalchemy import case, select, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .gallery import auto_like_photo_owner, validate_image_upload
from ..models.contest import (
    Contest,
    ContestSubmission,
    ContestVote,
    MAX_SUBMISSIONS_PER_USER,
    MAX_VOTES_PER_CATEGORY,
)
from ..models.event import Event
from ..models.notification import (
    NOTIFICATION_TYPE_CONTEST_COMPLETED,
    NOTIFICATION_TYPE_CONTEST_VOTING_OPEN,
    Notification,
)
from ..models.user import User
from ..schemas.common import PaginatedResponse
from ..schemas.contest import (
    BatchVoteRequest,
    CategoryResultSchema,
    CategoryVotesSchema,
    ContestCreate,
    ContestResponse,
    ContestSubmissionResponse,
    ContestUpdate,
    ContestWinnerSchema,
    FinalizeContestRequest,
    LeaderboardRankingSchema,
    MyResultsContestSchema,
    MyResultsLeaderboardSchema,
    MyResultsResponseSchema,
    MyResultsStatsSchema,
    SubmissionAssignRequest,
    SubmissionExifSchema,
    SubmissionResultSchema,
)
from ..models.gallery import GalleryPhoto
from ..models.member import Member
from ..rate_limit import limiter, AUTH_ATTEMPT
from ..services.storage import delete_uploaded_image, extract_exif_from_bytes, make_photographer_slug, read_image_bytes, save_submission_image, make_user_slug
from .activity import log_activity
from .deps import get_current_user, get_current_user_optional, get_db, require_admin

router = APIRouter()


def _submission_to_response(
    sub: ContestSubmission,
    category_votes: CategoryVotesSchema | None = None,
    anonymize: bool = False,
    current_user_id: uuid.UUID | None = None,
) -> ContestSubmissionResponse:
    exif = None
    if any([sub.exif_camera, sub.exif_focal_length, sub.exif_aperture, sub.exif_shutter_speed, sub.exif_iso]):
        exif = SubmissionExifSchema(
            camera=sub.exif_camera,
            focal_length=sub.exif_focal_length,
            aperture=sub.exif_aperture,
            shutter_speed=sub.exif_shutter_speed,
            iso=sub.exif_iso,
        )
    if anonymize:
        # Route the image through the API proxy so the storage path (which
        # contains the photographer's name slug) never reaches the client.
        # Submission time is withheld too — it could hint at who submitted.
        url = f"/api/v1/contests/{sub.contest_id}/submissions/{sub.id}/image"
        photographer = ""
        created_at = None
    else:
        url = sub.url
        photographer = sub.photographer
        created_at = sub.created_at
    is_own = current_user_id is not None and sub.user_id == current_user_id
    return ContestSubmissionResponse(
        id=sub.id,
        url=url,
        title=sub.title,
        photographer=photographer,
        is_assigned=sub.user_id is not None,
        is_own=is_own,
        votes=sub.vote_count if sub.vote_count else None,
        exif=exif,
        category_votes=category_votes,
        created_at=created_at,
    )


async def _contest_to_response(
    contest: Contest,
    db: AsyncSession,
    user: User | None = None,
) -> ContestResponse:
    # For completed contests, compute per-submission category vote counts
    sub_category_votes: dict[int, CategoryVotesSchema] = {}
    if contest.status == "completed":
        if contest.is_imported:
            # Imported contests: read tallies from JSONB on each submission
            for sub in contest.submissions:
                if sub.category_vote_tallies:
                    sub_category_votes[sub.id] = CategoryVotesSchema(
                        theme=sub.category_vote_tallies.get("theme", 0),
                        favorite=sub.category_vote_tallies.get("favorite", 0),
                        wildcard=sub.category_vote_tallies.get("wildcard", 0),
                    )
        else:
            # Organic contests: aggregate from ContestVote table
            vote_rows = await db.execute(
                select(
                    ContestVote.submission_id,
                    ContestVote.category,
                    func.count().label("cnt"),
                )
                .where(ContestVote.contest_id == contest.id)
                .group_by(ContestVote.submission_id, ContestVote.category)
            )
            for row in vote_rows:
                sid = row.submission_id
                if sid not in sub_category_votes:
                    sub_category_votes[sid] = CategoryVotesSchema()
                setattr(sub_category_votes[sid], row.category, row.cnt)

    is_admin = user is not None and user.role == "admin"
    anonymize = contest.status == "voting" and not is_admin
    current_user_id = user.id if user is not None else None
    submissions = [
        _submission_to_response(
            s,
            sub_category_votes.get(s.id),
            anonymize=anonymize,
            current_user_id=current_user_id,
        )
        for s in contest.submissions
    ]
    submission_count = len(contest.submissions)
    participant_count = len({s.photographer for s in contest.submissions})

    winners = None
    if contest.winners:
        winners = [ContestWinnerSchema.model_validate(w) for w in contest.winners]

    # User-specific fields
    user_submission_count = None
    user_has_voted = None
    if user is not None:
        count_result = await db.execute(
            select(func.count()).select_from(ContestSubmission).where(
                ContestSubmission.contest_id == contest.id,
                ContestSubmission.user_id == user.id,
            )
        )
        user_submission_count = count_result.scalar_one()

        vote_exists = await db.execute(
            select(func.count()).select_from(ContestVote).where(
                ContestVote.contest_id == contest.id,
                ContestVote.user_id == user.id,
            )
        )
        user_has_voted = vote_exists.scalar_one() > 0

    return ContestResponse(
        id=contest.id,
        month=contest.month,
        theme=contest.theme,
        description=contest.description,
        status=contest.status,
        deadline=contest.deadline,
        submission_count=submission_count,
        participant_count=participant_count,
        guidelines=contest.guidelines,
        wildcard_category=contest.wildcard_category,
        is_imported=contest.is_imported,
        submissions=submissions,
        winners=winners,
        user_submission_count=user_submission_count,
        user_has_voted=user_has_voted,
    )


def _rank_for_category(
    entries: list[tuple[int, int, datetime]],
    category: str,
) -> list[dict]:
    """Assign dense ranks for one category.

    *entries* is a list of ``(submission_id, vote_count, created_at)`` tuples
    with positive vote counts. Every submission whose tally is among the top
    three distinct vote counts places; ties share the place, so a category
    may have several firsts, seconds, or thirds. Within a place, earlier
    submissions come first in the returned list.
    """
    if not entries:
        return []

    # Sort: most votes first, earliest submission first within a tie
    entries.sort(key=lambda x: (-x[1], x[2]))

    winners: list[dict] = []
    place = 0
    prev_votes: int | None = None
    for sub_id, votes, _created in entries:
        if votes != prev_votes:
            place += 1
            prev_votes = votes
        if place > 3:
            break
        winners.append({"submissionId": sub_id, "place": place, "category": category})
    return winners


async def _auto_calculate_winners(contest: Contest, db: AsyncSession) -> None:
    """Auto-calculate winners from vote tallies when advancing to completed."""
    vote_rows = await db.execute(
        select(
            ContestVote.category,
            ContestVote.submission_id,
            func.count().label("cnt"),
        )
        .where(ContestVote.contest_id == contest.id)
        .group_by(ContestVote.category, ContestVote.submission_id)
        .order_by(ContestVote.category, func.count().desc())
    )

    # Group by category
    by_category: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for row in vote_rows:
        by_category[row.category].append((row.submission_id, row.cnt))

    # Build created_at lookup for tie ordering
    sub_created = {sub.id: sub.created_at for sub in contest.submissions}

    winners = []
    for category, ranked in by_category.items():
        entries = [(sub_id, cnt, sub_created[sub_id]) for sub_id, cnt in ranked]
        winners.extend(_rank_for_category(entries, category))

    contest.winners = winners if winners else None
    contest.honorable_mentions = None

    # Update total vote_count on each submission
    total_votes: dict[int, int] = defaultdict(int)
    for category, ranked in by_category.items():
        for sub_id, count in ranked:
            total_votes[sub_id] += count

    for sub in contest.submissions:
        sub.vote_count = total_votes.get(sub.id, 0)


def _winners_from_tallies(contest: Contest) -> list[dict]:
    """Compute dense-rank winners from stored per-submission vote tallies.

    Used for imported contests, whose tallies are entered by an admin at
    finalize time and persisted on each submission. Zero tallies never place,
    and the wildcard category only counts when the contest defines one.
    """
    by_category: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for sub in contest.submissions:
        tallies = sub.category_vote_tallies or {}
        for category in ("theme", "favorite", "wildcard"):
            if category == "wildcard" and not contest.wildcard_category:
                continue
            count = tallies.get(category, 0) or 0
            if count > 0:
                by_category[category].append((sub.id, count))

    sub_created = {sub.id: sub.created_at for sub in contest.submissions}
    winners: list[dict] = []
    for category, ranked in by_category.items():
        entries = [(sub_id, cnt, sub_created[sub_id]) for sub_id, cnt in ranked]
        winners.extend(_rank_for_category(entries, category))
    return winners


async def _populate_gallery_from_contest(
    contest: Contest, db: AsyncSession, update_winners: bool = False,
) -> None:
    """Create gallery entries for contest submissions after completion.

    When *update_winners* is True (used by finalize/re-finalize), existing
    gallery entries also get their winner status refreshed instead of being
    skipped.
    """
    # Build winner map: submission_id -> (best_place, best_category)
    winner_map: dict[int, tuple[int, str]] = {}
    # Build full placements map: submission_id -> [{place, category}, ...]
    all_placements: dict[int, list[dict]] = defaultdict(list)
    if contest.winners:
        for w in contest.winners:
            sid = w["submissionId"]
            place = w["place"]
            cat = w.get("category", "theme")
            all_placements[sid].append({"place": place, "category": cat, "month": contest.month})
            if sid not in winner_map or place < winner_map[sid][0]:
                winner_map[sid] = (place, cat)

    # Find existing gallery entries for this contest
    existing_result = await db.execute(
        select(GalleryPhoto).where(
            GalleryPhoto.contest_id == contest.id,
            GalleryPhoto.contest_submission_id.isnot(None),
        )
    )
    existing_photos = {gp.contest_submission_id: gp for gp in existing_result.scalars().all()}

    # Resolve member_id for submissions that have a user_id
    member_by_user: dict[str, int] = {}
    user_ids = [str(sub.user_id) for sub in contest.submissions if sub.user_id]
    if user_ids:
        member_result = await db.execute(
            select(Member.user_id, Member.id).where(Member.user_id.in_(user_ids))
        )
        for row in member_result:
            member_by_user[str(row.user_id)] = row.id

    # Collect newly created photos so we can auto-like them in one pass after
    # flushing — flushing populates photo.id, which the like row needs.
    new_photos: list[tuple[GalleryPhoto, uuid.UUID | None]] = []

    for sub in contest.submissions:
        is_winner = sub.id in winner_map
        place, category = winner_map[sub.id] if is_winner else (None, None)
        placements = all_placements.get(sub.id) or None
        member_id = member_by_user.get(str(sub.user_id)) if sub.user_id else None

        if sub.id in existing_photos:
            if update_winners:
                gp = existing_photos[sub.id]
                gp.is_winner = is_winner
                gp.winner_place = place
                gp.winner_category = category
                gp.winner_placements = placements
                gp.photographer = sub.photographer
                gp.member_id = member_id
            continue

        photo = GalleryPhoto(
            url=sub.url,
            title=sub.title,
            photographer=sub.photographer,
            member_id=member_id,
            exif_camera=sub.exif_camera,
            exif_focal_length=sub.exif_focal_length,
            exif_iso=sub.exif_iso,
            exif_aperture=sub.exif_aperture,
            exif_shutter_speed=sub.exif_shutter_speed,
            contest_id=contest.id,
            contest_submission_id=sub.id,
            is_winner=is_winner,
            winner_place=place,
            winner_category=category,
            winner_placements=placements,
        )
        db.add(photo)
        # We already know the owner's user_id from the submission — pass it
        # directly so the helper can skip the Member lookup it would otherwise
        # do via photo.member_id.
        new_photos.append((photo, sub.user_id))

    if new_photos:
        await db.flush()  # populate photo.id for each newly added photo
        for photo, owner_user_id in new_photos:
            await auto_like_photo_owner(photo, db, owner_user_id=owner_user_id)


# --- Auto-scheduled deadline events ---

CONTEST_EVENT_TIME = "23:59"
CONTEST_EVENT_LOCATION = "Online"
# Voting runs the first week of the month after the contest month, ending at
# end of day on this date. Keep in sync with getVotingDeadline() in
# src/pages/ContestPage.tsx.
VOTING_DEADLINE_DAY = 7


def _parse_contest_month(month_str: str) -> tuple[int, int]:
    """Parse 'YYYY-MM' into (year, month)."""
    year_part, month_part = month_str.split("-", 1)
    return int(year_part), int(month_part)


def _format_contest_month(month_str: str) -> str:
    """Return a human-readable month phrase like 'March 2026' from '2026-03'."""
    year, month = _parse_contest_month(month_str)
    return date(year, month, 1).strftime("%B %Y")


def _submission_deadline_date(month_str: str) -> str:
    """Return YYYY-MM-DD for the last day of the contest month."""
    year, month = _parse_contest_month(month_str)
    last_day = calendar.monthrange(year, month)[1]
    return f"{year:04d}-{month:02d}-{last_day:02d}"


def _voting_deadline_date(month_str: str) -> str:
    """Return YYYY-MM-DD for the 7th of the next month, with year wrap."""
    year, month = _parse_contest_month(month_str)
    next_year = year + 1 if month == 12 else year
    next_month = 1 if month == 12 else month + 1
    return f"{next_year:04d}-{next_month:02d}-{VOTING_DEADLINE_DAY:02d}"


def _contest_begins_date(month_str: str) -> str:
    """Return YYYY-MM-DD for the 1st of the contest month."""
    year, month = _parse_contest_month(month_str)
    return f"{year:04d}-{month:02d}-01"


def _submission_event_id(contest_id: int) -> str:
    return f"contest-{contest_id}-submission-deadline"


def _voting_event_id(contest_id: int) -> str:
    return f"contest-{contest_id}-voting-deadline"


def _contest_begins_event_id(contest_id: int) -> str:
    return f"contest-{contest_id}-begins"


def _build_submission_event_fields(contest: Contest) -> dict:
    month_phrase = _format_contest_month(contest.month)
    return {
        "title": f"Submission Deadline — {contest.theme}",
        "description": (
            f"Last day to submit photos for the {month_phrase} contest. "
            "Submissions close at 11:59 PM."
        ),
        "location": CONTEST_EVENT_LOCATION,
        "date": _submission_deadline_date(contest.month),
        "time": CONTEST_EVENT_TIME,
        "end_time": None,
        "recurrence": None,
    }


def _build_voting_event_fields(contest: Contest) -> dict:
    month_phrase = _format_contest_month(contest.month)
    return {
        "title": f"Voting Deadline — {contest.theme}",
        "description": (
            f"Last day to vote in the {month_phrase} contest. "
            "Voting closes at 11:59 PM."
        ),
        "location": CONTEST_EVENT_LOCATION,
        "date": _voting_deadline_date(contest.month),
        "time": CONTEST_EVENT_TIME,
        "end_time": None,
        "recurrence": None,
    }


def _build_contest_begins_event_fields(contest: Contest) -> dict:
    year, month = _parse_contest_month(contest.month)
    month_name = date(year, month, 1).strftime("%B")
    return {
        "title": f"{month_name} Photo Contest Begins",
        "description": (
            f"Join us for the {month_name} Monthly Photo Contest! "
            'Visit the "Contest" Page for more details.'
        ),
        "location": CONTEST_EVENT_LOCATION,
        "date": _contest_begins_date(contest.month),
        "time": "00:00",
        "end_time": None,
        "recurrence": None,
    }


async def _create_contest_events(contest: Contest, db: AsyncSession) -> None:
    """Insert deadline events for a newly created contest.

    No-op for contests created in 'completed' status (imported past contests).
    Defensive: if a deterministic ID already exists in the events table for
    any reason, skip creating that one rather than raising IntegrityError.
    """
    if contest.status == "completed":
        return

    sub_id = _submission_event_id(contest.id)
    vote_id = _voting_event_id(contest.id)
    begins_id = _contest_begins_event_id(contest.id)

    existing = await db.execute(
        select(Event.id).where(Event.id.in_([sub_id, vote_id, begins_id]))
    )
    existing_ids = {row[0] for row in existing}

    if begins_id not in existing_ids:
        db.add(Event(id=begins_id, **_build_contest_begins_event_fields(contest)))
    if sub_id not in existing_ids:
        db.add(Event(id=sub_id, **_build_submission_event_fields(contest)))
    if vote_id not in existing_ids:
        db.add(Event(id=vote_id, **_build_voting_event_fields(contest)))


async def _update_contest_events(contest: Contest, db: AsyncSession) -> None:
    """Refresh existing deadline events when a contest is edited.

    - Only updates events that already exist (respects manual deletes, and
      respects 'no auto-create for imported contests' — since they were never
      created, they aren't retroactively created here either).
    - No-op while the contest is in 'completed' status: deadlines are now
      historical, leave them as-is.
    """
    if contest.status == "completed":
        return

    sub_id = _submission_event_id(contest.id)
    vote_id = _voting_event_id(contest.id)
    begins_id = _contest_begins_event_id(contest.id)

    result = await db.execute(
        select(Event).where(Event.id.in_([sub_id, vote_id, begins_id]))
    )
    by_id = {ev.id: ev for ev in result.scalars().all()}

    if begins_id in by_id:
        fields = _build_contest_begins_event_fields(contest)
        ev = by_id[begins_id]
        ev.title = fields["title"]
        ev.description = fields["description"]
        ev.location = fields["location"]
        ev.date = fields["date"]
        ev.time = fields["time"]
        ev.end_time = fields["end_time"]

    if sub_id in by_id:
        fields = _build_submission_event_fields(contest)
        ev = by_id[sub_id]
        ev.title = fields["title"]
        ev.description = fields["description"]
        ev.location = fields["location"]
        ev.date = fields["date"]
        ev.time = fields["time"]
        ev.end_time = fields["end_time"]

    if vote_id in by_id:
        fields = _build_voting_event_fields(contest)
        ev = by_id[vote_id]
        ev.title = fields["title"]
        ev.description = fields["description"]
        ev.location = fields["location"]
        ev.date = fields["date"]
        ev.time = fields["time"]
        ev.end_time = fields["end_time"]


async def _delete_contest_events(contest_id: int, db: AsyncSession) -> None:
    """Remove auto-events linked to a contest. Idempotent."""
    sub_id = _submission_event_id(contest_id)
    vote_id = _voting_event_id(contest_id)
    begins_id = _contest_begins_event_id(contest_id)
    result = await db.execute(
        select(Event).where(Event.id.in_([sub_id, vote_id, begins_id]))
    )
    for ev in result.scalars().all():
        await db.delete(ev)


# --- Notifications for contest transitions ---


async def _notify_submitters_for_contest_transition(
    contest: Contest,
    notification_type: str,
    db: AsyncSession,
) -> None:
    """Insert a notification for each unique submitter (with a linked user) of this contest.

    Idempotent per (user_id, type, contestId): if a matching notification already
    exists, it is not duplicated. This protects against admins toggling status
    voting → active → voting and emitting duplicate batches.
    """
    submitter_user_ids = {
        sub.user_id for sub in contest.submissions if sub.user_id is not None
    }
    if not submitter_user_ids:
        return

    # Find which submitters already have a notification of this type for this contest
    existing_result = await db.execute(
        select(Notification.user_id).where(
            Notification.type == notification_type,
            Notification.user_id.in_(submitter_user_ids),
            Notification.payload["contestId"].astext == str(contest.id),
        )
    )
    already_notified = {row[0] for row in existing_result}
    targets = submitter_user_ids - already_notified
    if not targets:
        return

    payload = {
        "contestId": contest.id,
        "contestTheme": contest.theme,
        "contestMonth": contest.month,
    }
    for uid in targets:
        db.add(Notification(
            user_id=uid,
            type=notification_type,
            payload=payload,
        ))


# --- Contest CRUD ---


@router.get("/all", response_model=list[ContestResponse])
async def list_all_contests(
    limit: int = Query(200, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user_optional),
):
    # "voting" sorts first: it is the most time-sensitive state (roughly a
    # one-week window each month), so contest listings lead with it.
    status_order = case(
        (Contest.status == "voting", 0),
        (Contest.status == "upcoming", 1),
        (Contest.status == "active", 2),
        (Contest.status == "completed", 3),
        else_=4,
    )
    result = await db.execute(
        select(Contest)
        .order_by(
            status_order,
            case((Contest.status == "completed", Contest.deadline), else_=None).desc(),
            Contest.deadline.asc(),
        )
        .limit(limit)
    )
    contests = result.scalars().unique().all()
    return [await _contest_to_response(c, db, user) for c in contests]


@router.get("", response_model=PaginatedResponse[ContestResponse])
async def list_contests(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status_filter: str | None = Query(None, alias="status"),
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user_optional),
):
    count_query = select(func.count()).select_from(Contest)
    if status_filter:
        count_query = count_query.where(Contest.status == status_filter)
    count_result = await db.execute(count_query)
    total = count_result.scalar_one()

    # Keep in step with list_all_contests: "voting" leads (see comment there).
    status_order = case(
        (Contest.status == "voting", 0),
        (Contest.status == "upcoming", 1),
        (Contest.status == "active", 2),
        (Contest.status == "completed", 3),
        else_=4,
    )
    query = select(Contest)
    if status_filter:
        query = query.where(Contest.status == status_filter)
    result = await db.execute(
        query
        .order_by(
            status_order,
            case((Contest.status == "completed", Contest.deadline), else_=None).desc(),
            Contest.deadline.asc(),
        )
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    contests = result.scalars().unique().all()

    return PaginatedResponse(
        items=[await _contest_to_response(c, db, user) for c in contests],
        total=total,
        page=page,
        page_size=page_size,
        pages=math.ceil(total / page_size) if total > 0 else 0,
    )


@router.get("/my-results", response_model=MyResultsResponseSchema)
async def get_my_results(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return the current user's competition performance and submission history."""
    result = await db.execute(
        select(Contest)
        .where(Contest.status == "completed")
        .order_by(Contest.month.desc())
    )
    completed = result.scalars().unique().all()

    # Build per-user stats across all completed contests
    sub_to_user: dict[int, str] = {}
    all_user_stats: dict[str, dict] = defaultdict(
        lambda: {"first": 0, "second": 0, "third": 0, "podium": 0, "votes": 0, "submissions": 0, "contests": set(),
                 "cat_wins": defaultdict(int)}
    )

    for contest in completed:
        for sub in contest.submissions:
            if sub.user_id:
                uid = str(sub.user_id)
                sub_to_user[sub.id] = uid
                all_user_stats[uid]["submissions"] += 1
                all_user_stats[uid]["votes"] += sub.vote_count
                all_user_stats[uid]["contests"].add(contest.id)

        if contest.winners:
            for w in contest.winners:
                uid = sub_to_user.get(w["submissionId"])
                if uid:
                    place = w["place"]
                    if place == 1:
                        all_user_stats[uid]["first"] += 1
                    elif place == 2:
                        all_user_stats[uid]["second"] += 1
                    elif place == 3:
                        all_user_stats[uid]["third"] += 1
                    all_user_stats[uid]["podium"] += 1
                    all_user_stats[uid]["cat_wins"][w["category"]] += 1

    my_uid = str(user.id)
    my = all_user_stats.get(my_uid)
    total_completed = len(completed)
    total_members = len(all_user_stats)

    if my:
        contests_entered = len(my["contests"])
        cat_wins = my["cat_wins"]
        best_cat = max(cat_wins, key=cat_wins.get) if cat_wins else None
        stats = MyResultsStatsSchema(
            total_submissions=my["submissions"],
            total_votes=my["votes"],
            first_place_finishes=my["first"],
            second_place_finishes=my["second"],
            third_place_finishes=my["third"],
            podium_finishes=my["podium"],
            contests_entered=contests_entered,
            total_completed_contests=total_completed,
            participation_rate=round(contests_entered / total_completed, 4) if total_completed else 0.0,
            best_category=best_cat,
        )
    else:
        stats = MyResultsStatsSchema(
            total_submissions=0, total_votes=0,
            first_place_finishes=0, second_place_finishes=0, third_place_finishes=0,
            podium_finishes=0, contests_entered=0,
            total_completed_contests=total_completed, participation_rate=0.0,
            best_category=None,
        )

    # Leaderboard rankings (competition-style)
    def _compute_rank(key: str) -> LeaderboardRankingSchema:
        if not all_user_stats or my_uid not in all_user_stats:
            return LeaderboardRankingSchema(value=0, rank=total_members + 1, total_members=total_members)
        my_val = all_user_stats[my_uid][key]
        rank = 1 + sum(1 for s in all_user_stats.values() if s[key] > my_val)
        return LeaderboardRankingSchema(value=my_val, rank=rank, total_members=total_members)

    leaderboard = MyResultsLeaderboardSchema(
        first_place=_compute_rank("first"),
        second_place=_compute_rank("second"),
        third_place=_compute_rank("third"),
        total_podium=_compute_rank("podium"),
        total_votes=_compute_rank("votes"),
    )

    # Per-contest results for the current user
    def _sub_exif(sub: ContestSubmission) -> SubmissionExifSchema | None:
        if any([sub.exif_camera, sub.exif_focal_length, sub.exif_aperture, sub.exif_shutter_speed, sub.exif_iso]):
            return SubmissionExifSchema(
                camera=sub.exif_camera,
                focal_length=sub.exif_focal_length,
                aperture=sub.exif_aperture,
                shutter_speed=sub.exif_shutter_speed,
                iso=sub.exif_iso,
            )
        return None

    contests_out: list[MyResultsContestSchema] = []
    for contest in completed:
        user_subs = [s for s in contest.submissions if s.user_id == user.id]
        user_sub_ids = {s.id for s in user_subs}
        has_submission = len(user_subs) > 0

        # Skip contests the user didn't participate in
        if not has_submission:
            continue

        # Build winner lookup: category -> {submission_id -> place}
        winner_lookup: dict[str, dict[int, int]] = defaultdict(dict)
        if contest.winners:
            for w in contest.winners:
                if w["submissionId"] in user_sub_ids:
                    winner_lookup[w["category"]][w["submissionId"]] = w["place"]

        def _cat_result(category: str) -> CategoryResultSchema:
            if category == "wildcard" and not contest.wildcard_category:
                return CategoryResultSchema(has_submission=False, best_place=None, submissions=[])

            placements = winner_lookup.get(category, {})
            sub_results = []
            for sub in user_subs:
                sub_results.append(SubmissionResultSchema(
                    submission_id=sub.id,
                    url=sub.url,
                    title=sub.title,
                    photographer=sub.photographer,
                    place=placements.get(sub.id),
                    exif=_sub_exif(sub),
                ))
            # Sort: placed first (by place asc), then unplaced
            sub_results.sort(key=lambda r: (r.place is None, r.place or 0))
            best = min((p for p in placements.values()), default=None)
            return CategoryResultSchema(
                has_submission=True,
                best_place=best,
                submissions=sub_results,
            )

        contests_out.append(MyResultsContestSchema(
            contest_id=contest.id,
            month=contest.month,
            theme=contest.theme,
            wildcard_category=contest.wildcard_category,
            has_wildcard=contest.wildcard_category is not None,
            theme_result=_cat_result("theme"),
            favorite_result=_cat_result("favorite"),
            wildcard_result=_cat_result("wildcard"),
        ))

    return MyResultsResponseSchema(stats=stats, leaderboard=leaderboard, contests=contests_out)


@router.get("/{contest_id}", response_model=ContestResponse)
async def get_contest(
    contest_id: int,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user_optional),
):
    result = await db.execute(select(Contest).where(Contest.id == contest_id))
    contest = result.scalar_one_or_none()
    if contest is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contest not found")
    return await _contest_to_response(contest, db, user)


_VALID_IMAGE_SIZES = {"thumb", "medium", "full", "original"}


@router.get("/{contest_id}/submissions/{submission_id}/image")
async def get_anonymous_submission_image(
    contest_id: int,
    submission_id: int,
    size: str = Query("original"),
    db: AsyncSession = Depends(get_db),
):
    # Streams submission image bytes through the API so the underlying storage
    # path (which embeds the photographer's name slug) is never exposed during
    # anonymous voting. Public on purpose; submission IDs aren't sensitive and
    # this is the one place voters fetch ballot images.
    if size not in _VALID_IMAGE_SIZES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid size")

    result = await db.execute(
        select(ContestSubmission).where(
            ContestSubmission.id == submission_id,
            ContestSubmission.contest_id == contest_id,
        )
    )
    sub = result.scalar_one_or_none()
    if sub is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Submission not found")

    actual_url = sub.url
    if size != "original" and "." in actual_url:
        stem, _, ext = actual_url.rpartition(".")
        actual_url = f"{stem}_{size}.{ext}"

    content = await asyncio.to_thread(read_image_bytes, actual_url)
    if content is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Image not found")

    media_type = mimetypes.guess_type(Path(sub.url).name)[0] or "image/jpeg"
    return Response(
        content=content,
        media_type=media_type,
        headers={"Cache-Control": "public, max-age=300"},
    )


@router.post("", response_model=ContestResponse, status_code=status.HTTP_201_CREATED)
async def create_contest(
    body: ContestCreate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    contest = Contest(
        month=body.month,
        theme=body.theme,
        description=body.description,
        status=body.status,
        deadline=body.deadline,
        guidelines=body.guidelines,
        wildcard_category=body.wildcard_category,
        is_imported=body.status == "completed",
    )
    db.add(contest)
    await db.flush()  # populate contest.id before creating linked events
    await _create_contest_events(contest, db)
    await log_activity(db, admin, "create", "contest", body.theme, f"Created contest: {body.theme}")
    await db.commit()
    await db.refresh(contest)
    return await _contest_to_response(contest, db, admin)


@router.put("/{contest_id}", response_model=ContestResponse)
async def update_contest(
    contest_id: int,
    body: ContestUpdate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Contest).where(Contest.id == contest_id))
    contest = result.scalar_one_or_none()
    if contest is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contest not found")

    old_status = contest.status

    if body.month is not None:
        contest.month = body.month
    if body.theme is not None:
        contest.theme = body.theme
    if body.description is not None:
        contest.description = body.description
    if body.status is not None:
        contest.status = body.status
    if body.deadline is not None:
        contest.deadline = body.deadline
    if body.guidelines is not None:
        contest.guidelines = body.guidelines
    if "wildcard_category" in body.model_fields_set:
        contest.wildcard_category = body.wildcard_category

    # Auto-calculate winners when advancing from voting to completed
    if old_status == "voting" and contest.status == "completed":
        await _auto_calculate_winners(contest, db)
        await _populate_gallery_from_contest(contest, db, update_winners=True)

    # Notify submitters when contest enters voting or completed status
    if old_status != contest.status:
        if contest.status == "voting":
            await _notify_submitters_for_contest_transition(
                contest, NOTIFICATION_TYPE_CONTEST_VOTING_OPEN, db,
            )
        elif contest.status == "completed":
            await _notify_submitters_for_contest_transition(
                contest, NOTIFICATION_TYPE_CONTEST_COMPLETED, db,
            )

    # Clear winners when reverting from completed
    if old_status == "completed" and contest.status in ("voting", "active"):
        contest.winners = None
        contest.honorable_mentions = None
        contest.is_imported = False
        for sub in contest.submissions:
            sub.vote_count = 0
            sub.category_vote_tallies = None
        # Remove gallery entries for this contest
        gallery_result = await db.execute(
            select(GalleryPhoto).where(GalleryPhoto.contest_id == contest.id)
        )
        for gp in gallery_result.scalars().all():
            await db.delete(gp)

    await _update_contest_events(contest, db)
    await log_activity(db, admin, "update", "contest", str(contest_id), f"Updated contest: {contest.theme}")
    await db.commit()
    await db.refresh(contest)
    return await _contest_to_response(contest, db, admin)


@router.delete("/{contest_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_contest(
    contest_id: int,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Contest).where(Contest.id == contest_id))
    contest = result.scalar_one_or_none()
    if contest is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contest not found")
    for sub in contest.submissions:
        delete_uploaded_image(sub.url)
    await _delete_contest_events(contest_id, db)
    await log_activity(db, admin, "delete", "contest", str(contest_id), f"Deleted contest: {contest.theme}")
    await db.delete(contest)
    await db.commit()


# --- Submissions ---


@router.post("/{contest_id}/submissions", response_model=ContestSubmissionResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit(AUTH_ATTEMPT)
async def create_submission(
    request: Request,
    contest_id: int,
    file: UploadFile,
    title: str = Form(...),
    photographer: str = Form(...),
    exif_camera: str | None = Form(None),
    exif_focal_length: str | None = Form(None),
    exif_aperture: str | None = Form(None),
    exif_shutter_speed: str | None = Form(None),
    exif_iso: int | None = Form(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Verify contest exists and is active
    result = await db.execute(select(Contest).where(Contest.id == contest_id))
    contest = result.scalar_one_or_none()
    if contest is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contest not found")
    if contest.status != "active":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Contest is not accepting submissions")

    # Enforce submission limit
    count_result = await db.execute(
        select(func.count()).select_from(ContestSubmission).where(
            ContestSubmission.contest_id == contest_id,
            ContestSubmission.user_id == user.id,
        )
    )
    if count_result.scalar_one() >= MAX_SUBMISSIONS_PER_USER:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Maximum {MAX_SUBMISSIONS_PER_USER} submissions per person",
        )

    await validate_image_upload(file)
    slug = make_user_slug(user.id, user.first_name, user.last_name)
    url = await save_submission_image(contest.month, file, user_slug=slug)

    submission = ContestSubmission(
        contest_id=contest_id,
        url=url,
        title=title,
        photographer=photographer,
        user_id=user.id,
        exif_camera=exif_camera,
        exif_focal_length=exif_focal_length,
        exif_aperture=exif_aperture,
        exif_shutter_speed=exif_shutter_speed,
        exif_iso=exif_iso,
    )
    db.add(submission)
    await db.commit()
    await db.refresh(submission)
    return _submission_to_response(submission)


@router.delete("/{contest_id}/submissions/{submission_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_submission(
    contest_id: int,
    submission_id: int,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ContestSubmission).where(
            ContestSubmission.id == submission_id,
            ContestSubmission.contest_id == contest_id,
        )
    )
    submission = result.scalar_one_or_none()
    if submission is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Submission not found")
    delete_uploaded_image(submission.url)
    await db.delete(submission)
    await db.commit()


# --- Voting ---


@router.post("/{contest_id}/vote", status_code=status.HTTP_201_CREATED)
async def cast_vote(
    contest_id: int,
    body: BatchVoteRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Verify contest exists and is in voting status
    result = await db.execute(select(Contest).where(Contest.id == contest_id))
    contest = result.scalar_one_or_none()
    if contest is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contest not found")
    if contest.status != "voting":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Contest is not in voting phase")

    # Check if user has already voted
    existing = await db.execute(
        select(func.count()).select_from(ContestVote).where(
            ContestVote.contest_id == contest_id,
            ContestVote.user_id == user.id,
        )
    )
    if existing.scalar_one() > 0:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="You have already voted in this contest")

    # Determine valid categories for this contest
    valid_categories = {"theme", "favorite"}
    if contest.wildcard_category:
        valid_categories.add("wildcard")

    # Get all submission IDs for this contest, plus the subset owned by the
    # voting user (used to reject self-votes — defense-in-depth, since the
    # frontend already disables those affordances).
    sub_result = await db.execute(
        select(ContestSubmission.id, ContestSubmission.user_id).where(
            ContestSubmission.contest_id == contest_id
        )
    )
    valid_sub_ids: set[int] = set()
    own_sub_ids: set[int] = set()
    for sub_id, owner_id in sub_result:
        valid_sub_ids.add(sub_id)
        if owner_id == user.id:
            own_sub_ids.add(sub_id)

    # Validate and create votes
    votes_to_add = []
    for cat_vote in body.votes:
        if cat_vote.category not in valid_categories:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid category: {cat_vote.category}",
            )
        if len(cat_vote.submission_ids) > MAX_VOTES_PER_CATEGORY:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Maximum {MAX_VOTES_PER_CATEGORY} votes per category",
            )
        if len(cat_vote.submission_ids) < 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="At least 1 vote required per category",
            )
        if len(set(cat_vote.submission_ids)) != len(cat_vote.submission_ids):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Duplicate submission IDs in category",
            )
        for sub_id in cat_vote.submission_ids:
            if sub_id not in valid_sub_ids:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Submission {sub_id} not found in this contest",
                )
            if sub_id in own_sub_ids:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="You cannot vote for your own submissions",
                )
            votes_to_add.append(
                ContestVote(
                    contest_id=contest_id,
                    submission_id=sub_id,
                    user_id=user.id,
                    category=cat_vote.category,
                )
            )

    try:
        for vote in votes_to_add:
            db.add(vote)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Vote conflict detected")

    return {"detail": "Votes recorded"}


# --- Admin Import Endpoints ---


@router.post("/{contest_id}/admin-submissions", response_model=ContestSubmissionResponse, status_code=status.HTTP_201_CREATED)
async def create_admin_submission(
    request: Request,
    contest_id: int,
    file: UploadFile,
    title: str = Form(...),
    photographer: str = Form(...),
    member_id: int | None = Form(None),
    exif_camera: str | None = Form(None),
    exif_focal_length: str | None = Form(None),
    exif_aperture: str | None = Form(None),
    exif_shutter_speed: str | None = Form(None),
    exif_iso: int | None = Form(None),
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Admin-only: upload a submission for an imported contest. No status or limit checks."""
    result = await db.execute(select(Contest).where(Contest.id == contest_id))
    contest = result.scalar_one_or_none()
    if contest is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contest not found")
    if not contest.is_imported:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Admin submissions are only allowed for imported contests")

    await validate_image_upload(file)

    # Resolve member → user_id if a member is specified
    user_id = None
    if member_id is not None:
        member_result = await db.execute(select(Member).where(Member.id == member_id))
        member = member_result.scalar_one_or_none()
        if member is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member not found")
        user_id = member.user_id  # may still be None if member has no linked user

    slug = make_photographer_slug(photographer)
    url = await save_submission_image(contest.month, file, user_slug=slug)

    submission = ContestSubmission(
        contest_id=contest_id,
        url=url,
        title=title,
        photographer=photographer,
        user_id=user_id,
        exif_camera=exif_camera,
        exif_focal_length=exif_focal_length,
        exif_aperture=exif_aperture,
        exif_shutter_speed=exif_shutter_speed,
        exif_iso=exif_iso,
    )
    db.add(submission)
    await db.commit()
    await db.refresh(submission)
    return _submission_to_response(submission)


@router.post("/{contest_id}/finalize", response_model=ContestResponse)
async def finalize_contest(
    contest_id: int,
    body: FinalizeContestRequest,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Admin-only: set vote tallies and calculate winners for an imported contest."""
    result = await db.execute(select(Contest).where(Contest.id == contest_id))
    contest = result.scalar_one_or_none()
    if contest is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contest not found")
    if not contest.is_imported:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only imported contests can be finalized this way")
    if not contest.submissions:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Contest has no submissions to finalize")

    # Build submission lookup
    sub_map = {sub.id: sub for sub in contest.submissions}

    # Set tallies on each submission
    for tally in body.vote_tallies:
        sub = sub_map.get(tally.submission_id)
        if sub is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Submission {tally.submission_id} not found in this contest",
            )
        sub.category_vote_tallies = {"theme": tally.theme, "favorite": tally.favorite, "wildcard": tally.wildcard}
        sub.vote_count = tally.theme + tally.favorite + tally.wildcard

    # Calculate winners from the stored tallies using dense ranking
    winners = _winners_from_tallies(contest)
    contest.winners = winners if winners else None
    contest.honorable_mentions = None

    # Populate/update gallery entries
    await _populate_gallery_from_contest(contest, db, update_winners=True)

    await log_activity(db, admin, "update", "contest", str(contest_id), f"Finalized imported contest: {contest.theme}")
    await db.commit()
    await db.refresh(contest)
    return await _contest_to_response(contest, db, admin)


@router.patch("/{contest_id}/submissions/{submission_id}/assign", response_model=ContestSubmissionResponse)
async def assign_submission(
    contest_id: int,
    submission_id: int,
    body: SubmissionAssignRequest,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Admin-only: reassign a submission to a member (or clear the assignment)."""
    result = await db.execute(
        select(ContestSubmission).where(
            ContestSubmission.id == submission_id,
            ContestSubmission.contest_id == contest_id,
        )
    )
    submission = result.scalar_one_or_none()
    if submission is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Submission not found")

    member_id_for_gallery = None
    if body.member_id is not None:
        member_result = await db.execute(select(Member).where(Member.id == body.member_id))
        member = member_result.scalar_one_or_none()
        if member is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member not found")
        submission.user_id = member.user_id
        member_id_for_gallery = member.id
    else:
        submission.user_id = None

    submission.photographer = body.photographer

    # Update the corresponding gallery entry if it exists
    gallery_result = await db.execute(
        select(GalleryPhoto).where(GalleryPhoto.contest_submission_id == submission_id)
    )
    gallery_photo = gallery_result.scalar_one_or_none()
    if gallery_photo:
        gallery_photo.photographer = body.photographer
        gallery_photo.member_id = member_id_for_gallery

    await db.commit()
    await db.refresh(submission)

    # Build category_votes from tallies if available
    category_votes = None
    if submission.category_vote_tallies:
        category_votes = CategoryVotesSchema(
            theme=submission.category_vote_tallies.get("theme", 0),
            favorite=submission.category_vote_tallies.get("favorite", 0),
            wildcard=submission.category_vote_tallies.get("wildcard", 0),
        )

    return _submission_to_response(submission, category_votes)


@router.post("/{contest_id}/backfill-exif")
async def backfill_exif(
    contest_id: int,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Admin-only: extract EXIF from stored images and backfill submissions + gallery entries."""
    result = await db.execute(select(Contest).where(Contest.id == contest_id))
    contest = result.scalar_one_or_none()
    if contest is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contest not found")

    updated = 0
    skipped = 0
    for sub in contest.submissions:
        # Skip if EXIF is already populated
        if any([sub.exif_camera, sub.exif_focal_length, sub.exif_aperture, sub.exif_shutter_speed, sub.exif_iso]):
            skipped += 1
            continue

        content = read_image_bytes(sub.url)
        if content is None:
            skipped += 1
            continue

        exif = extract_exif_from_bytes(content)
        if not exif:
            skipped += 1
            continue

        # Update submission
        if exif.get("camera"):
            sub.exif_camera = exif["camera"]
        if exif.get("focal_length"):
            sub.exif_focal_length = exif["focal_length"]
        if exif.get("aperture"):
            sub.exif_aperture = exif["aperture"]
        if exif.get("shutter_speed"):
            sub.exif_shutter_speed = exif["shutter_speed"]
        if exif.get("iso"):
            sub.exif_iso = exif["iso"]

        # Also update corresponding gallery entry
        gallery_result = await db.execute(
            select(GalleryPhoto).where(GalleryPhoto.contest_submission_id == sub.id)
        )
        gp = gallery_result.scalar_one_or_none()
        if gp:
            gp.exif_camera = sub.exif_camera
            gp.exif_focal_length = sub.exif_focal_length
            gp.exif_aperture = sub.exif_aperture
            gp.exif_shutter_speed = sub.exif_shutter_speed
            gp.exif_iso = sub.exif_iso

        updated += 1

    await db.commit()
    return {"detail": f"EXIF backfill complete: {updated} updated, {skipped} skipped"}


@router.post("/{contest_id}/refresh-gallery")
async def refresh_gallery(
    contest_id: int,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Admin-only: re-sync gallery entries from current contest winners (updates placements)."""
    result = await db.execute(select(Contest).where(Contest.id == contest_id))
    contest = result.scalar_one_or_none()
    if contest is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contest not found")
    if contest.status != "completed":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Contest must be completed")

    await _populate_gallery_from_contest(contest, db, update_winners=True)
    await db.commit()
    return {"detail": "Gallery entries refreshed with current winner placements"}


@router.post("/recalculate-winners")
async def recalculate_winners(
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Admin-only: recompute winners for every completed contest under the
    current (dense) ranking rules, then refresh gallery winner badges.

    Organic contests recompute from their recorded votes; imported contests
    from the vote tallies stored at finalize time. Imported contests that
    were never finalized (no stored tallies) are left untouched.
    """
    result = await db.execute(select(Contest).where(Contest.status == "completed"))
    contests = result.scalars().unique().all()

    recalculated = 0
    skipped = 0
    for contest in contests:
        if contest.is_imported:
            if not any(sub.category_vote_tallies for sub in contest.submissions):
                skipped += 1
                continue
            winners = _winners_from_tallies(contest)
            contest.winners = winners if winners else None
        else:
            await _auto_calculate_winners(contest, db)
        contest.honorable_mentions = None
        await _populate_gallery_from_contest(contest, db, update_winners=True)
        recalculated += 1

    await log_activity(
        db, admin, "update", "contest", "all",
        f"Recalculated winners for {recalculated} completed contests",
    )
    await db.commit()
    return {"detail": f"Recalculated winners for {recalculated} contests ({skipped} skipped)"}

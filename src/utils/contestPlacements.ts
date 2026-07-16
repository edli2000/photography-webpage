import type { Contest, ContestSubmission, VoteCategory } from '../types/contest';

/**
 * Placement helpers for completed contests.
 *
 * Placement rules (dense ranking — mirrors _rank_for_category in
 * backend/app/api/contests.py): every submission whose tally is among the top
 * three distinct positive vote counts places; ties share the place, so a
 * category may have several firsts, seconds, or thirds. Within a place,
 * earlier submissions are shown first.
 */

export function getCategoryVotes(sub: ContestSubmission, category: VoteCategory): number {
  return sub.categoryVotes ? sub.categoryVotes[category] : (sub.votes ?? 0);
}

function submissionTime(sub: ContestSubmission): number {
  if (sub.createdAt) {
    const t = Date.parse(sub.createdAt);
    if (!Number.isNaN(t)) return t;
  }
  // Unknown time sorts after known times; the id tiebreak below still keeps
  // the order deterministic (ids are assigned in submission order).
  return Number.MAX_SAFE_INTEGER;
}

export function compareBySubmissionTime(a: ContestSubmission, b: ContestSubmission): number {
  return submissionTime(a) - submissionTime(b) || a.id - b.id;
}

export interface RankedSubmission {
  sub: ContestSubmission;
  votes: number;
  /** Dense rank: 1 = highest tally; ties share the rank. */
  rank: number;
  /** Gold/silver/bronze accent — top three distinct tallies, votes required. */
  isMedal: boolean;
}

/** Rank every submission in a category: votes desc, earlier submission first
    within a tie, dense rank assigned down the whole list. */
export function rankSubmissions(
  submissions: ContestSubmission[],
  category: VoteCategory,
): RankedSubmission[] {
  const sorted = submissions
    .map((sub) => ({ sub, votes: getCategoryVotes(sub, category) }))
    .sort((a, b) => b.votes - a.votes || compareBySubmissionTime(a.sub, b.sub));

  let rank = 0;
  let prevVotes: number | null = null;
  return sorted.map(({ sub, votes }) => {
    if (votes !== prevVotes) {
      rank += 1;
      prevVotes = votes;
    }
    return { sub, votes, rank, isMedal: rank <= 3 && votes > 0 };
  });
}

export interface PlacementGroups {
  first: RankedSubmission[];
  second: RankedSubmission[];
  third: RankedSubmission[];
}

/** Group a completed contest's winners for one category by place.

    Trusts the backend-assigned place (the source of truth for placements);
    votes are attached for display only. Winners whose submission is missing
    (deleted after completion) are dropped. */
export function groupWinnersByPlace(contest: Contest, category: VoteCategory): PlacementGroups {
  const subById = new Map(contest.submissions.map((s) => [s.id, s]));
  const groups: PlacementGroups = { first: [], second: [], third: [] };
  for (const w of contest.winners ?? []) {
    if ((w.category || 'theme') !== category) continue;
    const sub = subById.get(w.submissionId);
    if (!sub) continue;
    const row: RankedSubmission = {
      sub,
      votes: getCategoryVotes(sub, category),
      rank: w.place,
      isMedal: true,
    };
    if (w.place === 1) groups.first.push(row);
    else if (w.place === 2) groups.second.push(row);
    else if (w.place === 3) groups.third.push(row);
  }
  const byTime = (a: RankedSubmission, b: RankedSubmission) => compareBySubmissionTime(a.sub, b.sub);
  groups.first.sort(byTime);
  groups.second.sort(byTime);
  groups.third.sort(byTime);
  return groups;
}

export function medalColor(place: number): string | undefined {
  if (place === 1) return '#FFD700';
  if (place === 2) return '#C0C0C0';
  if (place === 3) return '#CD7F32';
  return undefined;
}

export function placeLabel(place: number): string {
  if (place === 1) return '1st Place';
  if (place === 2) return '2nd Place';
  return '3rd Place';
}

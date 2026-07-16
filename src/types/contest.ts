import type { PhotoExif } from './gallery';

export type VoteCategory = 'theme' | 'favorite' | 'wildcard';

export interface CategoryVotes {
  theme: number;
  favorite: number;
  wildcard: number;
}

export interface ContestSubmission {
  id: number;
  url: string;
  title: string;
  photographer: string;
  isAssigned?: boolean;
  isOwn?: boolean;
  votes?: number;
  exif?: PhotoExif;
  categoryVotes?: CategoryVotes;
  /** ISO submission time — orders tied placements. Absent during anonymous voting. */
  createdAt?: string | null;
}

export type ContestStatus = 'upcoming' | 'active' | 'voting' | 'completed';

export interface ContestWinner {
  submissionId: number;
  /** Dense rank: ties share a place, so a category may have several of each. */
  place: 1 | 2 | 3;
  category: VoteCategory;
}

export interface Contest {
  id: number;
  month: string;
  theme: string;
  description: string;
  status: ContestStatus;
  deadline: string;
  submissionCount: number;
  participantCount: number;
  guidelines: string[];
  wildcardCategory?: string | null;
  isImported?: boolean;
  submissions: ContestSubmission[];
  winners?: ContestWinner[];
  userSubmissionCount?: number | null;
  userHasVoted?: boolean | null;
}

export function getCategoryLabel(cat: VoteCategory, wildcardLabel?: string | null): string {
  switch (cat) {
    case 'theme':
      return 'Best Addresses the Theme';
    case 'favorite':
      return 'Personal Favorite';
    case 'wildcard':
      return wildcardLabel || 'Bonus Challenge';
  }
}

// --- My Results types ---

export interface SubmissionResult {
  submissionId: number;
  url: string;
  title: string;
  photographer: string;
  place?: number | null;
  exif?: PhotoExif | null;
}

export interface CategoryResult {
  hasSubmission: boolean;
  bestPlace?: number | null;
  submissions: SubmissionResult[];
}

export interface MyResultsContest {
  contestId: number;
  month: string;
  theme: string;
  wildcardCategory?: string | null;
  hasWildcard: boolean;
  themeResult: CategoryResult;
  favoriteResult: CategoryResult;
  wildcardResult: CategoryResult;
}

export interface LeaderboardRanking {
  value: number;
  rank: number;
  totalMembers: number;
}

export interface MyResultsStats {
  totalSubmissions: number;
  totalVotes: number;
  firstPlaceFinishes: number;
  secondPlaceFinishes: number;
  thirdPlaceFinishes: number;
  podiumFinishes: number;
  contestsEntered: number;
  totalCompletedContests: number;
  participationRate: number;
  bestCategory?: string | null;
}

export interface MyResultsLeaderboard {
  firstPlace: LeaderboardRanking;
  secondPlace: LeaderboardRanking;
  thirdPlace: LeaderboardRanking;
  totalPodium: LeaderboardRanking;
  totalVotes: LeaderboardRanking;
}

export interface MyResultsResponse {
  stats: MyResultsStats;
  leaderboard: MyResultsLeaderboard;
  contests: MyResultsContest[];
}

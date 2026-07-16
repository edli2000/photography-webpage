import type { Contest, MyResultsResponse } from '../types/contest';
import { apiFetch } from './client';

export async function getContests(): Promise<Contest[]> {
  return apiFetch<Contest[]>('/contests/all');
}

export async function getLatestCompletedContest(): Promise<Contest | null> {
  // Completed contests sort most-recent first, so page 1 × size 1 is exactly
  // the latest one.
  const res = await apiFetch<{ items: Contest[] }>(
    '/contests?page=1&page_size=1&status=completed',
  );
  return res.items[0] ?? null;
}

export interface ContestCreateData {
  month: string;
  theme: string;
  description: string;
  status: string;
  deadline: string;
  guidelines: string[];
  wildcardCategory?: string | null;
}

export async function createContest(data: ContestCreateData): Promise<Contest> {
  return apiFetch<Contest>('/contests', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export interface ContestUpdateData {
  month?: string;
  theme?: string;
  description?: string;
  status?: string;
  deadline?: string;
  guidelines?: string[];
  wildcardCategory?: string | null;
}

export async function updateContest(id: number, data: ContestUpdateData): Promise<Contest> {
  return apiFetch<Contest>(`/contests/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteContest(id: number): Promise<void> {
  await apiFetch(`/contests/${id}`, { method: 'DELETE' });
}

export async function getContest(id: number): Promise<Contest> {
  return apiFetch<Contest>(`/contests/${id}`);
}

export async function submitPhoto(contestId: number, formData: FormData): Promise<void> {
  await apiFetch(`/contests/${contestId}/submissions`, {
    method: 'POST',
    body: formData,
    headers: {},
  });
}

export async function deleteSubmission(contestId: number, submissionId: number): Promise<void> {
  await apiFetch(`/contests/${contestId}/submissions/${submissionId}`, { method: 'DELETE' });
}

export async function castVote(
  contestId: number,
  votes: { category: string; submissionIds: number[] }[],
): Promise<void> {
  await apiFetch(`/contests/${contestId}/vote`, {
    method: 'POST',
    body: JSON.stringify({ votes }),
  });
}

// --- Admin Import APIs ---

export async function uploadAdminSubmission(
  contestId: number,
  formData: FormData,
): Promise<void> {
  await apiFetch(`/contests/${contestId}/admin-submissions`, {
    method: 'POST',
    body: formData,
    headers: {},
  });
}

export interface SubmissionVoteTally {
  submissionId: number;
  theme: number;
  favorite: number;
  wildcard: number;
}

export async function finalizeContest(
  contestId: number,
  voteTallies: SubmissionVoteTally[],
): Promise<Contest> {
  return apiFetch<Contest>(`/contests/${contestId}/finalize`, {
    method: 'POST',
    body: JSON.stringify({ voteTallies }),
  });
}

export async function refreshGallery(contestId: number): Promise<{ detail: string }> {
  return apiFetch<{ detail: string }>(`/contests/${contestId}/refresh-gallery`, {
    method: 'POST',
  });
}

export async function recalculateWinners(): Promise<{ detail: string }> {
  return apiFetch<{ detail: string }>('/contests/recalculate-winners', {
    method: 'POST',
  });
}

export async function backfillExif(contestId: number): Promise<{ detail: string }> {
  return apiFetch<{ detail: string }>(`/contests/${contestId}/backfill-exif`, {
    method: 'POST',
  });
}

export async function assignSubmission(
  contestId: number,
  submissionId: number,
  data: { memberId: number | null; photographer: string },
): Promise<void> {
  await apiFetch(`/contests/${contestId}/submissions/${submissionId}/assign`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function getMyResults(): Promise<MyResultsResponse> {
  return apiFetch<MyResultsResponse>('/contests/my-results');
}

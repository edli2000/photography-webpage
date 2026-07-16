import type { Contest, VoteCategory } from '../types/contest';
import type { GalleryPhoto } from '../types/gallery';

/** One slide in the home-page winners showcase: a first-place gallery photo
    plus every category it took first in for that contest. */
export interface ShowcaseSlide {
  photo: GalleryPhoto;
  categories: VoteCategory[];
}

const CATEGORY_ORDER: VoteCategory[] = ['theme', 'favorite', 'wildcard'];

/** Pick the first-place winners of a contest as showcase slides.

    Winners are matched to gallery photos via contestSubmissionId, so photos
    an admin hid or deleted from the gallery are skipped naturally. A photo
    that took first in several categories appears once, carrying all of its
    winning categories. Slides are ordered theme → favorite → wildcard (the
    backend orders ties within a category by earliest submission, which the
    winners array ordering preserves). */
export function pickFirstPlaceSlides(
  contest: Contest | null,
  galleryPhotos: GalleryPhoto[],
): ShowcaseSlide[] {
  if (!contest?.winners?.length) return [];

  const photoBySubmission = new Map<number, GalleryPhoto>();
  for (const photo of galleryPhotos) {
    if (photo.contestId === contest.id && photo.contestSubmissionId != null) {
      photoBySubmission.set(photo.contestSubmissionId, photo);
    }
  }

  const slides: ShowcaseSlide[] = [];
  const slideBySubmission = new Map<number, ShowcaseSlide>();
  for (const category of CATEGORY_ORDER) {
    for (const w of contest.winners) {
      if (w.place !== 1 || (w.category || 'theme') !== category) continue;
      const existing = slideBySubmission.get(w.submissionId);
      if (existing) {
        if (!existing.categories.includes(category)) existing.categories.push(category);
        continue;
      }
      const photo = photoBySubmission.get(w.submissionId);
      if (!photo) continue;
      const slide: ShowcaseSlide = { photo, categories: [category] };
      slideBySubmission.set(w.submissionId, slide);
      slides.push(slide);
    }
  }
  return slides;
}

import type { GalleryPhoto } from '../types/gallery';

/* Display formatters shared by the Gallery section, the shared photo
   lightbox, and the home-page winners showcase. */

export function formatExif(photo: GalleryPhoto): string | null {
  if (!photo.exif) return null;
  const parts: string[] = [];
  if (photo.exif.camera) parts.push(photo.exif.camera);
  if (photo.exif.focalLength) parts.push(photo.exif.focalLength);
  if (photo.exif.aperture) parts.push(photo.exif.aperture);
  if (photo.exif.shutterSpeed) parts.push(photo.exif.shutterSpeed);
  if (photo.exif.iso != null) parts.push(`ISO ${photo.exif.iso}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatContestMonth(month: string): string {
  // "2026-03" → "Mar 2026"
  const [year, m] = month.split('-');
  const idx = parseInt(m, 10) - 1;
  return `${SHORT_MONTHS[idx] ?? m} ${year}`;
}

export function winnerLabel(place: number): string {
  if (place === 1) return '1st';
  if (place === 2) return '2nd';
  if (place === 3) return '3rd';
  return `${place}th`;
}

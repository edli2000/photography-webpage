import { useState, useEffect, useCallback, useRef } from 'react';
import type { GalleryPhoto } from '../types/gallery';
import type { VoteCategory } from '../types/contest';
import { getCategoryLabel } from '../types/contest';
import { X } from 'lucide-react';
import { useImageLoaded } from '../hooks/useImageLoaded';
import { getImageUrl } from '../utils/imageUrl';
import LikeButton from './LikeButton';
import CommentsPanel from './CommentsPanel';
import { formatContestMonth, formatExif, winnerLabel } from '../utils/galleryFormat';
import './Gallery.css';

/* Full-screen photo lightbox shared by the Gallery section and the home-page
   contest winners showcase. Extracted from Gallery.tsx verbatim so both open
   photos with the identical format: header with placements + like button,
   cross-faded full image, prev/next arrows, EXIF strip, comments panel. */

const CROSSFADE_MS = 300;

export default function GalleryLightbox({
  photos,
  index,
  onClose,
  onPrev,
  onNext,
  onLikeChange,
  onCommentCountChange,
}: {
  photos: GalleryPhoto[];
  index: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onLikeChange: (photoId: number, liked: boolean, count: number) => void;
  onCommentCountChange: (photoId: number, count: number) => void;
}) {
  const photo = photos[index];
  const modalRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [isClosing, setIsClosing] = useState(false);

  // Mobile-only: comments panel collapses to a thin handle by default so the
  // image gets the freed vertical space. Toggle expands it to ~50vh.
  const isMobileViewport = () => typeof window !== 'undefined' && window.innerWidth <= 768;
  const [showCommentsToggle, setShowCommentsToggle] = useState(isMobileViewport);
  const [commentsExpanded, setCommentsExpanded] = useState(false);
  useEffect(() => {
    const onResize = () => setShowCommentsToggle(isMobileViewport());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const startClose = () => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onClose();
    } else {
      setIsClosing(true);
    }
  };
  const { loaded, errored, handleLoad, handleError, imgRef } = useImageLoaded(getImageUrl(photo.url, 'full'));

  const [prevPhoto, setPrevPhoto] = useState<GalleryPhoto | null>(null);
  const prevIndexRef = useRef(index);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [fadeIn, setFadeIn] = useState(false);
  const fadeUrlRef = useRef('');

  // Synchronous reset — ensures opacity: 0 start state before paint
  const currentUrl = getImageUrl(photo.url, 'full');
  if (fadeUrlRef.current !== currentUrl) {
    fadeUrlRef.current = currentUrl;
    if (fadeIn) setFadeIn(false);
  }

  // Detect navigation — capture outgoing photo
  useEffect(() => {
    if (prevIndexRef.current !== index) {
      if (!prevPhoto) {
        setPrevPhoto(photos[prevIndexRef.current]);
      }
      prevIndexRef.current = index;
    }
  }, [index, photos, prevPhoto]);

  // Cleanup after cross-fade completes
  useEffect(() => {
    if (fadeIn && prevPhoto) {
      fadeTimerRef.current = setTimeout(() => setPrevPhoto(null), CROSSFADE_MS);
    }
    return () => {
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    };
  }, [fadeIn, prevPhoto]);

  const handleLightboxLoad = useCallback(() => {
    handleLoad();
    requestAnimationFrame(() => setFadeIn(true));
  }, [handleLoad]);

  const handleLightboxError = useCallback(() => {
    handleError();
    requestAnimationFrame(() => setFadeIn(true));
  }, [handleError]);

  const displayPhoto = (prevPhoto && !loaded) ? prevPhoto : photo;
  const exifText = formatExif(displayPhoto);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') startClose();
      if (e.key === 'ArrowLeft') onPrev();
      if (e.key === 'ArrowRight') onNext();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, onPrev, onNext]);

  // Focus trap
  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = modal.querySelectorAll<HTMLElement>(
        'button, [tabindex]:not([tabindex="-1"]), a[href]'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleTab);
    return () => document.removeEventListener('keydown', handleTab);
  }, []);

  return (
    <div
      className={`gallery__lightbox-backdrop${isClosing ? ' gallery__lightbox-backdrop--closing' : ''}`}
      onClick={startClose}
      onAnimationEnd={() => { if (isClosing) { setIsClosing(false); onClose(); } }}
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${photo.title} by ${photo.photographer}`}
    >
      <div className="gallery__lightbox" onClick={(e) => e.stopPropagation()}>
        <div className="gallery__lightbox-media">
        <button
          className="gallery__lightbox-close"
          onClick={startClose}
          aria-label="Close lightbox"
          ref={closeRef}
        >
          <X size={24} />
        </button>
        <span className="gallery__lightbox-counter">
          {index + 1} / {photos.length}
        </span>
        <div className={`gallery__lightbox-header${fadeIn ? ' gallery__lightbox-header--loaded' : ''}`}>
          <div className="gallery__lightbox-header-text">
            <strong>{displayPhoto.title}</strong>
            <span>{displayPhoto.photographer}</span>
            {displayPhoto.winnerPlacements && displayPhoto.winnerPlacements.length > 0 && (
              <div className="gallery__lightbox-placements">
                {displayPhoto.winnerPlacements
                  .sort((a, b) => a.place - b.place)
                  .map((p, i) => (
                    <span key={i} className="gallery__lightbox-placement">
                      {p.month && <span className="gallery__lightbox-placement-month">{formatContestMonth(p.month)} · </span>}
                      {winnerLabel(p.place)} — {getCategoryLabel(p.category as VoteCategory)}
                    </span>
                  ))}
              </div>
            )}
          </div>
          <LikeButton
            photoId={photo.id}
            liked={!!photo.viewerHasLiked}
            count={photo.likeCount ?? 0}
            onChange={(liked, count) => onLikeChange(photo.id, liked, count)}
          />
        </div>

        <div className="gallery__lightbox-body">
          {!loaded && !prevPhoto && (
            <div className="gallery__lightbox-loading">
              <div className="section-spinner__ring" />
            </div>
          )}

          {prevPhoto && (
            <img
              className={`gallery__lightbox-img gallery__lightbox-img--prev${
                fadeIn ? ' gallery__lightbox-img--fade-out' : ''
              }`}
              src={getImageUrl(prevPhoto.url, 'full')}
              alt=""
            />
          )}

          {errored && !prevPhoto ? (
            <div className="img-error-fallback gallery__lightbox-img gallery__lightbox-img--loaded" style={{ minHeight: 'min(200px, 100%)', minWidth: 'min(300px, 100%)' }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 48, height: 48 }}>
                <line x1="2" y1="2" x2="22" y2="22" />
                <path d="M10.41 10.41a2 2 0 1 1-2.83-2.83" />
                <path d="M21 15V6a2 2 0 0 0-2-2H9" />
                <path d="M3 8.7V19a2 2 0 0 0 2 2h12.3" />
              </svg>
            </div>
          ) : (
            <img
              ref={imgRef}
              key={photo.url}
              className={`gallery__lightbox-img${fadeIn ? ' gallery__lightbox-img--loaded' : ''}`}
              src={getImageUrl(photo.url, 'full')}
              alt={photo.title}
              onLoad={handleLightboxLoad}
              onError={handleLightboxError}
            />
          )}

          {/* Arrow buttons live inside the body so they anchor (via their
              existing position: absolute) to the image's container — vertical
              center of the body = vertical center of the painted image,
              regardless of header/exif heights or panel state. */}
          <button
            type="button"
            className="gallery__lightbox-arrow gallery__lightbox-arrow--prev"
            onClick={onPrev}
            aria-label="Previous image"
          >
            &#8249;
          </button>
          <button
            type="button"
            className="gallery__lightbox-arrow gallery__lightbox-arrow--next"
            onClick={onNext}
            aria-label="Next image"
          >
            &#8250;
          </button>
        </div>

        <span className={`gallery__lightbox-exif${fadeIn ? ' gallery__lightbox-exif--loaded' : ''}${exifText ? '' : ' gallery__lightbox-exif--empty'}`}>
          {exifText || '\u00a0'}
        </span>
        </div>

        <div
          className={`gallery__lightbox-panel${
            showCommentsToggle
              ? commentsExpanded
                ? ' gallery__lightbox-panel--expanded'
                : ' gallery__lightbox-panel--collapsed'
              : ''
          }`}
        >
          {showCommentsToggle && (
            <button
              type="button"
              className="gallery__lightbox-panel-toggle"
              onClick={() => setCommentsExpanded((v) => !v)}
              aria-expanded={commentsExpanded}
              aria-controls="gallery-lightbox-comments"
            >
              <span className="gallery__lightbox-panel-toggle-label">
                Comments{photo.commentCount ? ` (${photo.commentCount})` : ''}
              </span>
            </button>
          )}
          <div id="gallery-lightbox-comments" className="gallery__lightbox-panel-body">
            <CommentsPanel
              photoId={photo.id}
              initialCount={photo.commentCount ?? 0}
              onCountChange={(count) => onCommentCountChange(photo.id, count)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

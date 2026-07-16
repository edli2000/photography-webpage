import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { GalleryPhoto } from '../types/gallery';
import { getGalleryPhotos } from '../api/gallery';
import { useImageLoaded } from '../hooks/useImageLoaded';
import { getImageUrl } from '../utils/imageUrl';
import { useToast } from '../contexts/ToastContext';
import GalleryLightbox from './GalleryLightbox';
import { winnerLabel } from '../utils/galleryFormat';
import './Gallery.css';

// PAGE_SIZE aligns with the grid tier so each page renders ~2–4 balanced rows:
//   - mobile (≤480px, 1-col):     4 items (4 rows)
//   - tablet (481–1024, 2–3 col): 6 items (cleanly fills both 2-col and 3-col)
//   - desktop (>1024, 4-col):     12 items (3 rows)
// Breakpoints intentionally match Members.tsx so both sections reflow together.
const PAGE_SIZES = { desktop: 12, tablet: 6, mobile: 4 } as const;
const BREAKPOINTS = { tablet: 1024, mobile: 480 } as const;

function useResponsivePageSize(): number {
  const getSize = () => {
    if (typeof window === 'undefined') return PAGE_SIZES.desktop;
    if (window.innerWidth <= BREAKPOINTS.mobile) return PAGE_SIZES.mobile;
    if (window.innerWidth <= BREAKPOINTS.tablet) return PAGE_SIZES.tablet;
    return PAGE_SIZES.desktop;
  };
  const [size, setSize] = useState(getSize);
  useEffect(() => {
    const mobileQuery = window.matchMedia(`(max-width: ${BREAKPOINTS.mobile}px)`);
    const tabletQuery = window.matchMedia(`(max-width: ${BREAKPOINTS.tablet}px)`);
    const update = () => setSize(getSize());
    mobileQuery.addEventListener('change', update);
    tabletQuery.addEventListener('change', update);
    return () => {
      mobileQuery.removeEventListener('change', update);
      tabletQuery.removeEventListener('change', update);
    };
  }, []);
  return size;
}

function GalleryItem({
  photo,
  onClick,
  onKeyDown,
  ariaLabel,
}: {
  photo: GalleryPhoto;
  onClick: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  ariaLabel: string;
}) {
  const { loaded, errored, handleLoad, handleError, imgRef } = useImageLoaded(getImageUrl(photo.url, 'medium'));
  return (
    <div
      className={`gallery__item${!loaded ? ' shimmer-bg' : ''}`}
      onClick={onClick}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="button"
      aria-label={ariaLabel}
    >
      {errored ? (
        <div className="img-error-fallback">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="2" y1="2" x2="22" y2="22" />
            <path d="M10.41 10.41a2 2 0 1 1-2.83-2.83" />
            <path d="M21 15V6a2 2 0 0 0-2-2H9" />
            <path d="M3 8.7V19a2 2 0 0 0 2 2h12.3" />
          </svg>
        </div>
      ) : (
        <img
          ref={imgRef}
          src={getImageUrl(photo.url, 'medium')}
          alt={photo.title}
          loading="lazy"
          className={`img-fade${loaded ? ' img-fade--loaded' : ''}`}
          onLoad={handleLoad}
          onError={handleError}
        />
      )}
      {photo.isWinner && photo.winnerPlace != null && (
        <span className="gallery__winner-badge">{winnerLabel(photo.winnerPlace)}</span>
      )}
      <div className="gallery__overlay">
        <h3>{photo.title}</h3>
        <p>{photo.photographer}</p>
      </div>
    </div>
  );
}

type ViewMode = 'winners' | 'all';

export default function Gallery() {
  const [winnersPhotos, setWinnersPhotos] = useState<GalleryPhoto[]>([]);
  const [allPhotos, setAllPhotos] = useState<GalleryPhoto[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>('winners');
  const [switching, setSwitching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [slideDir, setSlideDir] = useState<'left' | 'right' | null>(null);
  const [isPageTransitioning, setIsPageTransitioning] = useState(false);
  const [pendingPage, setPendingPage] = useState<number | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const { addToast } = useToast();

  const PAGE_SIZE = useResponsivePageSize();
  const photos = viewMode === 'winners' ? winnersPhotos : allPhotos;

  // Patch a photo in both winners and all arrays so likes/comments stay in sync across view modes
  const patchPhoto = useCallback((photoId: number, patch: Partial<GalleryPhoto>) => {
    const update = (list: GalleryPhoto[]) =>
      list.map((p) => (p.id === photoId ? { ...p, ...patch } : p));
    setWinnersPhotos(update);
    setAllPhotos(update);
  }, []);

  const handleLikeChange = useCallback((photoId: number, liked: boolean, count: number) => {
    patchPhoto(photoId, { viewerHasLiked: liked, likeCount: count });
  }, [patchPhoto]);

  const handleCommentCountChange = useCallback((photoId: number, count: number) => {
    patchPhoto(photoId, { commentCount: count });
  }, [patchPhoto]);

  const loadData = useCallback(() => {
    setLoading(true);
    setError(false);
    Promise.all([
      getGalleryPhotos(1, 100, { winnersOnly: true }),
      getGalleryPhotos(1, 100, { winnersOnly: false }),
    ])
      .then(([winnersRes, allRes]) => {
        setWinnersPhotos(winnersRes.items);
        setAllPhotos(allRes.items);
        setLoading(false);
      })
      .catch(() => {
        setError(true);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Deep link support: ?photo={id} opens that photo's lightbox once data is loaded.
  // Triggers whenever the param appears (including when Gallery is already mounted
  // and a notification click adds the param to the current URL).
  const photoParam = searchParams.get('photo');
  useEffect(() => {
    if (loading || !photoParam) return;
    const photoId = parseInt(photoParam, 10);
    if (Number.isNaN(photoId)) return;

    const idxInAll = allPhotos.findIndex((p) => p.id === photoId);
    const idxInWinners = winnersPhotos.findIndex((p) => p.id === photoId);

    if (idxInAll < 0 && idxInWinners < 0) {
      // Photo not in any loaded set (deleted, hidden, or beyond first 100)
      addToast('info', 'This photo is no longer available.');
      const next = new URLSearchParams(searchParams);
      next.delete('photo');
      setSearchParams(next, { replace: true });
      return;
    }

    if (viewMode === 'winners' && idxInWinners >= 0) {
      setSelectedIndex(idxInWinners);
    } else if (idxInAll >= 0) {
      if (viewMode !== 'all') setViewMode('all');
      setSelectedIndex(idxInAll);
    } else if (idxInWinners >= 0) {
      if (viewMode !== 'winners') setViewMode('winners');
      setSelectedIndex(idxInWinners);
    }
    // Clear the param so future navigation away and back doesn't re-trigger
    const next = new URLSearchParams(searchParams);
    next.delete('photo');
    setSearchParams(next, { replace: true });
  }, [loading, photoParam, allPhotos, winnersPhotos, viewMode, searchParams, setSearchParams, addToast]);

  const handleToggle = useCallback((mode: ViewMode) => {
    if (mode === viewMode || switching) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
      setViewMode(mode);
      setCurrentPage(0);
      setSelectedIndex(null);
    } else {
      setSwitching(true);
      setTimeout(() => {
        setViewMode(mode);
        setCurrentPage(0);
        setSelectedIndex(null);
        setSwitching(false);
      }, 300);
    }
  }, [viewMode, switching]);

  const totalPages = Math.max(1, Math.ceil(photos.length / PAGE_SIZE));

  // Clamp currentPage when PAGE_SIZE changes (e.g. resize across the 768px
  // breakpoint shrinks total page count below the current index).
  useEffect(() => {
    if (currentPage > totalPages - 1) {
      setCurrentPage(totalPages - 1);
    }
  }, [totalPages, currentPage]);

  const hasPrev = currentPage > 0;
  const hasNext = currentPage < totalPages - 1;
  const displayedPhotos = photos.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE
  );

  const goToNextPage = useCallback(() => {
    if (!hasNext || isPageTransitioning) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setSlideDir('left');
      setCurrentPage((p) => p + 1);
    } else {
      setSlideDir('left');
      setPendingPage(currentPage + 1);
      setIsPageTransitioning(true);
    }
  }, [hasNext, isPageTransitioning, currentPage]);

  const goToPrevPage = useCallback(() => {
    if (!hasPrev || isPageTransitioning) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setSlideDir('right');
      setCurrentPage((p) => p - 1);
    } else {
      setSlideDir('right');
      setPendingPage(currentPage - 1);
      setIsPageTransitioning(true);
    }
  }, [hasPrev, isPageTransitioning, currentPage]);

  const goToPrevPhoto = useCallback(() => {
    setSelectedIndex((i) =>
      i === null ? null : i === 0 ? photos.length - 1 : i - 1
    );
  }, [photos.length]);

  const goToNextPhoto = useCallback(() => {
    setSelectedIndex((i) =>
      i === null ? null : i === photos.length - 1 ? 0 : i + 1
    );
  }, [photos.length]);

  const handleClose = useCallback(() => {
    setSelectedIndex((prev) => {
      if (prev !== null) {
        setCurrentPage(Math.floor(prev / PAGE_SIZE));
      }
      return null;
    });
  }, [PAGE_SIZE]);

  const handleItemClick = (localIndex: number) => {
    setSelectedIndex(currentPage * PAGE_SIZE + localIndex);
  };

  const handleItemKeyDown = (e: React.KeyboardEvent, localIndex: number) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleItemClick(localIndex);
    }
  };

  const gridClassName = [
    'gallery__grid',
    isPageTransitioning && slideDir === 'left' && 'gallery__grid--exit-left',
    isPageTransitioning && slideDir === 'right' && 'gallery__grid--exit-right',
    !isPageTransitioning && slideDir === 'left' && 'gallery__grid--slide-from-right',
    !isPageTransitioning && slideDir === 'right' && 'gallery__grid--slide-from-left',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section id="gallery" className="gallery section">
      <div className="container">
        <div className="section-title fade-in-up">
          <h2>Gallery</h2>
          <p>A showcase of our members' best work</p>
          {!loading && !error && (
            <div className="gallery__toggle">
              <button
                className={`gallery__toggle-btn${viewMode === 'winners' ? ' gallery__toggle-btn--active' : ''}`}
                onClick={() => handleToggle('winners')}
              >
                Contest Winners
              </button>
              <button
                className={`gallery__toggle-btn${viewMode === 'all' ? ' gallery__toggle-btn--active' : ''}`}
                onClick={() => handleToggle('all')}
              >
                All Photos
              </button>
            </div>
          )}
        </div>

        {loading && (
          <div className="section-spinner">
            <div className="section-spinner__ring" />
          </div>
        )}

        {error && (
          <div className="section-error">
            <p>Something went wrong loading the gallery.</p>
            <button className="section-error__btn" onClick={loadData}>
              Try Again
            </button>
          </div>
        )}

        {!loading && !error && photos.length === 0 && (
          <div className="gallery__empty fade-in-up">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            <p>
              {viewMode === 'winners'
                ? 'Contest winners will be showcased here. Stay tuned!'
                : 'No submissions yet. Check back soon!'}
            </p>
          </div>
        )}

        {!loading && !error && photos.length > 0 && (
          <div className="fade-in-up">
          <div className={`gallery__carousel${switching ? ' gallery__carousel--switching' : ''}`}>
            {hasPrev && (
              <button
                className="gallery__nav gallery__nav--prev"
                onClick={goToPrevPage}
                aria-label="Previous page"
              >
                <span className="gallery__nav-icon gallery__nav-icon--horizontal" aria-hidden="true">&#8249;</span>
                <span className="gallery__nav-icon gallery__nav-icon--vertical" aria-hidden="true">&#x25B2;</span>
              </button>
            )}

            {totalPages > 1 && (
              <div className="gallery__page-indicator-slot gallery__page-indicator-slot--top">
                <p className="gallery__page-indicator">
                  Page {currentPage + 1} of {totalPages}
                </p>
              </div>
            )}

            <div
              className={gridClassName}
              key={currentPage}
              onAnimationEnd={() => {
                if (isPageTransitioning && pendingPage !== null) {
                  setCurrentPage(pendingPage);
                  setIsPageTransitioning(false);
                  setPendingPage(null);
                } else {
                  setSlideDir(null);
                }
              }}
            >
              {displayedPhotos.map((photo, i) => (
                <GalleryItem
                  key={photo.id}
                  photo={photo}
                  onClick={() => handleItemClick(i)}
                  onKeyDown={(e) => handleItemKeyDown(e, i)}
                  ariaLabel={`View ${photo.title} by ${photo.photographer}`}
                />
              ))}
              {totalPages > 1 &&
                Array.from({ length: PAGE_SIZE - displayedPhotos.length }, (_, i) => (
                  <div key={`placeholder-${i}`} className="gallery__item gallery__item--placeholder" aria-hidden="true" />
                ))}
            </div>

            {hasNext && (
              <button
                className="gallery__nav gallery__nav--next"
                onClick={goToNextPage}
                aria-label="Next page"
              >
                <span className="gallery__nav-icon gallery__nav-icon--horizontal" aria-hidden="true">&#8250;</span>
                <span className="gallery__nav-icon gallery__nav-icon--vertical" aria-hidden="true">&#x25BC;</span>
              </button>
            )}

            {totalPages > 1 && (
              <div className="gallery__page-indicator-slot gallery__page-indicator-slot--bottom">
                <p className="gallery__page-indicator">
                  Page {currentPage + 1} of {totalPages}
                </p>
              </div>
            )}
          </div>
          </div>
        )}
      </div>

      {selectedIndex !== null && (
        <GalleryLightbox
          photos={photos}
          index={selectedIndex}
          onClose={handleClose}
          onPrev={goToPrevPhoto}
          onNext={goToNextPhoto}
          onLikeChange={handleLikeChange}
          onCommentCountChange={handleCommentCountChange}
        />
      )}
    </section>
  );
}

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Trophy } from 'lucide-react';
import type { Contest } from '../types/contest';
import { getCategoryLabel } from '../types/contest';
import type { GalleryPhoto } from '../types/gallery';
import { getLatestCompletedContest } from '../api/contests';
import { getGalleryPhotos } from '../api/gallery';
import { getImageUrl } from '../utils/imageUrl';
import { pickFirstPlaceSlides } from '../utils/winnersShowcase';
import type { ShowcaseSlide } from '../utils/winnersShowcase';
import GalleryLightbox from './GalleryLightbox';
import { formatContestMonth } from '../utils/galleryFormat';
import './ContestSection.css';

const AUTO_ADVANCE_MS = 6000;

function WinnersShowcase({
  contest,
  slides,
  onPatchPhoto,
}: {
  contest: Contest;
  slides: ShowcaseSlide[];
  onPatchPhoto: (photoId: number, patch: Partial<GalleryPhoto>) => void;
}) {
  const [slideIndex, setSlideIndex] = useState(0);
  const [direction, setDirection] = useState<'next' | 'prev'>('next');
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);

  // Clamp instead of resetting in an effect: a refetch can shrink the slide
  // list while the index is past the new end.
  const safeIndex = Math.min(slideIndex, slides.length - 1);
  const slide = slides[safeIndex];

  // The element that opened the lightbox — restore focus when it closes.
  const triggerRef = useRef<HTMLElement | null>(null);

  const goTo = useCallback((next: number, dir: 'next' | 'prev') => {
    setDirection(dir);
    setSlideIndex(next);
  }, []);

  // Gentle auto-advance. Paused while hovered/focused or while the lightbox
  // is open; skipped entirely for a single slide or reduced motion.
  useEffect(() => {
    if (slides.length <= 1 || paused || lightboxIndex !== null) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = setInterval(() => {
      setDirection('next');
      setSlideIndex((i) => (i + 1) % slides.length);
    }, AUTO_ADVANCE_MS);
    return () => clearInterval(timer);
  }, [slides.length, paused, lightboxIndex]);

  // Warm the cache for the other slides so transitions land on loaded pixels.
  useEffect(() => {
    if (slides.length <= 1) return;
    for (const s of slides) {
      const img = new Image();
      img.src = getImageUrl(s.photo.url, 'medium');
    }
  }, [slides]);

  if (!slide) return null;

  const openLightbox = (e: React.MouseEvent | React.KeyboardEvent) => {
    triggerRef.current = e.currentTarget as HTMLElement;
    setLightboxIndex(safeIndex);
  };

  const closeLightbox = () => {
    setLightboxIndex(null);
    triggerRef.current?.focus();
    triggerRef.current = null;
  };

  const categoriesLabel = slide.categories
    .map((c) => getCategoryLabel(c, contest.wildcardCategory))
    .join(' · ');

  return (
    <div
      className="contest-section__showcase"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="contest-section__showcase-heading">
        <Trophy size={16} color="#FFD700" aria-hidden="true" />
        <span>
          {formatContestMonth(contest.month)} Winners — “{contest.theme}”
        </span>
      </div>

      <div
        className="contest-section__frame"
        role="button"
        tabIndex={0}
        aria-label={`View ${slide.photo.title} by ${slide.photo.photographer} in lightbox`}
        onClick={openLightbox}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openLightbox(e);
          }
        }}
      >
        {/* Ambient fill behind off-aspect photos — blurred, thumb-size. */}
        <img
          key={`backdrop-${slide.photo.id}`}
          src={getImageUrl(slide.photo.url, 'thumb')}
          alt=""
          aria-hidden="true"
          className="contest-section__backdrop"
        />
        <img
          key={slide.photo.id}
          src={getImageUrl(slide.photo.url, 'medium')}
          alt={slide.photo.title}
          loading="lazy"
          className={`contest-section__slide-img contest-section__slide-img--${direction}`}
        />

        {slides.length > 1 && (
          <>
            <button
              type="button"
              className="contest-section__arrow contest-section__arrow--left"
              onClick={(e) => {
                e.stopPropagation();
                goTo((safeIndex - 1 + slides.length) % slides.length, 'prev');
              }}
              aria-label="Previous winner"
            >
              <ChevronLeft size={18} />
            </button>
            <button
              type="button"
              className="contest-section__arrow contest-section__arrow--right"
              onClick={(e) => {
                e.stopPropagation();
                goTo((safeIndex + 1) % slides.length, 'next');
              }}
              aria-label="Next winner"
            >
              <ChevronRight size={18} />
            </button>
          </>
        )}
      </div>

      <div key={slide.photo.id} className="contest-section__caption">
        <div className="contest-section__caption-label">
          <span className="contest-section__caption-place">1st Place</span>
          <span className="contest-section__caption-categories">{categoriesLabel}</span>
          {slides.length > 1 && (
            <span className="contest-section__caption-counter" aria-live="polite">
              {safeIndex + 1} of {slides.length}
            </span>
          )}
        </div>
        <span className="contest-section__caption-title">{slide.photo.title}</span>
        <span className="contest-section__caption-photographer">{slide.photo.photographer}</span>
      </div>

      {lightboxIndex !== null && (
        <GalleryLightbox
          photos={slides.map((s) => s.photo)}
          index={Math.min(lightboxIndex, slides.length - 1)}
          onClose={closeLightbox}
          onPrev={() => setLightboxIndex((i) => (i === null ? null : (i - 1 + slides.length) % slides.length))}
          onNext={() => setLightboxIndex((i) => (i === null ? null : (i + 1) % slides.length))}
          onLikeChange={(photoId, liked, count) =>
            onPatchPhoto(photoId, { viewerHasLiked: liked, likeCount: count })}
          onCommentCountChange={(photoId, count) =>
            onPatchPhoto(photoId, { commentCount: count })}
        />
      )}
    </div>
  );
}

function ShowcasePlaceholder({ loading }: { loading: boolean }) {
  return (
    <div className={`contest-section__placeholder${loading ? ' shimmer-bg' : ''}`}>
      {!loading && (
        <>
          <Trophy size={40} aria-hidden="true" />
          <p>Each month’s winners are showcased here once the votes are in. Yours could be next!</p>
        </>
      )}
    </div>
  );
}

export default function ContestSection() {
  const [contest, setContest] = useState<Contest | null>(null);
  const [photos, setPhotos] = useState<GalleryPhoto[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getLatestCompletedContest(),
      getGalleryPhotos(1, 100, { winnersOnly: true }),
    ])
      .then(([latest, winners]) => {
        if (cancelled) return;
        setContest(latest);
        setPhotos(winners.items);
        setLoading(false);
      })
      .catch(() => {
        // Decorative section — fall back to the placeholder quietly.
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep like/comment updates made inside the lightbox reflected locally.
  const patchPhoto = useCallback((photoId: number, patch: Partial<GalleryPhoto>) => {
    setPhotos((list) => list.map((p) => (p.id === photoId ? { ...p, ...patch } : p)));
  }, []);

  const slides = useMemo(() => pickFirstPlaceSlides(contest, photos), [contest, photos]);

  return (
    <section id="contest" className="section" style={{ background: 'var(--color-bg-alt)' }}>
      <div className="container fade-in-up">
        <div className="section-title">
          <h2>Monthly Photography Contest</h2>
          <p>Push your creativity, join the challenge, and take some photos!</p>
        </div>

        <div className="contest-section__grid">
          <div className="contest-section__text">
            <h3>What is the monthly contest?</h3>
            <p>
              Every month, we select a photography "theme" and a “bonus challenge.” Everyone is invited to take photos throughout the month that fit the theme and/or bonus challenge. You’ll be able to submit up to 3 photos per contest. At the start of the next month, all members have the opportunity to vote for 1) Your favorite photo, 2) The photo that best fits the monthly theme, and 3) The photo that stepped up to the bonus challenge! The winners with the most votes in each category will be recognized on our website!
            </p>

            <h3>How can you join the contest?</h3>
            <p>
              Joining is very easy. Simply register and create an account! Once you do that, you'll be able to submit photos and vote! Check out the <Link to="/contest">Contest page</Link> for more details!
            </p>

            <div className="contest-section__cta">
              <Link to="/contest" className="btn btn-primary">
                Go to Current Contest
              </Link>
            </div>
          </div>

          {!loading && contest && slides.length > 0 ? (
            <WinnersShowcase contest={contest} slides={slides} onPatchPhoto={patchPhoto} />
          ) : (
            <ShowcasePlaceholder loading={loading} />
          )}
        </div>
      </div>
    </section>
  );
}

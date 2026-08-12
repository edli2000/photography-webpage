import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getVotingContest } from '../api/contests';
import { formatContestMonth } from '../utils/galleryFormat';
import type { Contest } from '../types/contest';
import heroLogo from '../assets/logo-selah-white.png';
import './Hero.css';

export default function Hero() {
  const { isAuthenticated } = useAuth();
  const bgRef = useRef<HTMLDivElement>(null);
  const [bgLoaded, setBgLoaded] = useState(false);
  const [votingContest, setVotingContest] = useState<Contest | null>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setBgLoaded(true);
    img.onerror = () => setBgLoaded(true);
    img.src = 'https://picsum.photos/id/1018/1920/1080';
  }, []);

  // Voting is members-only, so the vote CTA — and the fetch behind it — are
  // gated on auth. Visitors always keep the stable "Join Us" → /register CTA.
  // No need to clear stale state on logout: voteCta below re-derives from
  // isAuthenticated, and a later login refetches (overwriting with null when
  // nothing is in voting).
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    getVotingContest()
      .then((contest) => {
        if (!cancelled) setVotingContest(contest);
      })
      .catch(() => {
        /* keep the default CTA */
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  useEffect(() => {
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (prefersReduced || isMobile) return;

    let ticking = false;
    const handleScroll = () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          if (bgRef.current) {
            bgRef.current.style.transform = `translate3d(0, ${window.scrollY * 0.15}px, 0)`;
          }
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const voteCta =
    isAuthenticated && votingContest && !votingContest.userHasVoted
      ? `Vote for ${formatContestMonth(votingContest.month)} photos`
      : null;

  return (
    <section id="hero" className="hero">
      <div className={`hero__bg${bgLoaded ? ' hero__bg--loaded' : ''}`} ref={bgRef} />
      <div className="hero__overlay" />
      <div className="hero__content container">
        <h1 className="hero__title">
          <img src={heroLogo} alt="Selah" className="hero__title-logo" />
          {' '}Photography
        </h1>
        <p className="hero__tagline">Capturing Moments, Building Community</p>
        <Link
          to={isAuthenticated ? '/contest' : '/register'}
          className="btn btn-primary hero__cta"
        >
          {voteCta ?? (isAuthenticated ? 'Submit to Contest' : 'Join Us')}
        </Link>
      </div>
    </section>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import heroLogo from '../assets/logo-selah-white.png';
import './Hero.css';
import { getContests } from '../api/contests';

export default function Hero() {
  const { isAuthenticated } = useAuth();
  const bgRef = useRef<HTMLDivElement>(null);
  const [bgLoaded, setBgLoaded] = useState(false);
  const [votingMonth, setVotingMonth] = useState<string | null>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setBgLoaded(true);
    img.onerror = () => setBgLoaded(true);
    img.src = 'https://picsum.photos/id/1018/1920/1080';

    getContests()
      .then((contests) => {
        const votingContest = contests.find((c) => c.status === 'voting');
        if (votingContest) {
          setVotingMonth(votingContest.month);
        }
      })
      .catch(() => { /* ignore */ });
  }, []);

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
          to={isAuthenticated || votingMonth ? '/contest' : '/register'}
          className="btn btn-primary hero__cta"
        >
          {votingMonth ? `Vote for ${votingMonth} photos` : isAuthenticated ? 'Submit to Contest' : 'Join Us'}
        </Link>
      </div>
    </section>
  );
}

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
import { Camera, Users, Check, Trophy, Heart, Sparkles, ArrowLeft, ChevronLeft, ChevronRight, Lock, Maximize2, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Contest, ContestSubmission, VoteCategory } from '../types/contest';
import { getCategoryLabel } from '../types/contest';
import type { PhotoExif } from '../types/gallery';
import { useScrollReveal } from '../hooks/useScrollReveal';
import { useImageLoaded } from '../hooks/useImageLoaded';
import { useAuth } from '../contexts/AuthContext';
import { getContests, submitPhoto, castVote } from '../api/contests';
import Footer from '../components/Footer';
import { getImageUrl } from '../utils/imageUrl';
import { compressImage, isImageFile, IMAGE_ACCEPT } from '../utils/compressImage';
import { extractExif } from '../utils/extractExif';
import './ContestPage.css';

const BATCH_SIZE = 5;
const MAX_FILE_SIZE_MB = 10;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

function formatDeadline(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// Voting runs the first week of the month after the submission deadline,
// ending at end of day on this date. Keep in sync with VOTING_DEADLINE_DAY in
// backend/app/api/contests.py.
const VOTING_DEADLINE_DAY = 7;

function getVotingDeadline(submissionDeadline: string): string {
  const d = new Date(submissionDeadline + 'T00:00:00');
  // Voting deadline is the 7th of the month after the submission deadline
  // Set day of month to 1 first to avoid rollover/overflow issues with differing month lengths
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  d.setDate(VOTING_DEADLINE_DAY);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatExif(exif?: PhotoExif): string {
  if (!exif) return '';
  const parts: string[] = [];
  if (exif.camera) parts.push(exif.camera);
  if (exif.focalLength) parts.push(exif.focalLength);
  if (exif.aperture) parts.push(exif.aperture);
  if (exif.shutterSpeed) parts.push(exif.shutterSpeed);
  if (exif.iso != null) parts.push(`ISO ${exif.iso}`);
  return parts.join(' · ');
}

function shuffleArray<T>(items: readonly T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const CATEGORY_ICON: Record<VoteCategory, LucideIcon> = {
  theme: Trophy,
  favorite: Heart,
  wildcard: Sparkles,
};

/* --- Vote Lightbox (overlays the voting modal during ballot review) --- */

function VoteLightbox({
  sub,
  index,
  total,
  isSelected,
  atSelectionCap,
  isOwn,
  onClose,
  onPrev,
  onNext,
  onToggleSelect,
}: {
  sub: ContestSubmission;
  index: number;
  total: number;
  isSelected: boolean;
  atSelectionCap: boolean;
  isOwn: boolean;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onToggleSelect: () => void;
}) {
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const fullSrc = getImageUrl(sub.url, 'full');
  const { loaded, errored, handleLoad, handleError, imgRef } = useImageLoaded(fullSrc);

  // Own submissions are never selectable; otherwise users can deselect anytime
  // and select only when below the cap.
  const canSelect = !isOwn && (isSelected || !atSelectionCap);
  const hasPrev = index > 0;
  const hasNext = index >= 0 && index < total - 1;

  // Auto-focus the close button on open so keyboard users can act immediately.
  useEffect(() => {
    closeBtnRef.current?.focus();
  }, []);

  // Keyboard handling — registered in capture phase so we can stopImmediatePropagation
  // BEFORE the outer ModalShell's bubble-phase listener sees the event. Without this,
  // pressing Escape would close both the lightbox and the underlying voting modal.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowLeft') {
        e.stopImmediatePropagation();
        e.preventDefault();
        if (hasPrev) onPrev();
      } else if (e.key === 'ArrowRight') {
        e.stopImmediatePropagation();
        e.preventDefault();
        if (hasNext) onNext();
      } else if (e.key === 'Tab') {
        // Lightbox-local focus trap; intercept before the outer modal's trap fires.
        const el = panelRef.current;
        if (!el) return;
        const focusable = el.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [tabindex]:not([tabindex="-1"]), a[href]'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.stopImmediatePropagation();
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.stopImmediatePropagation();
          e.preventDefault();
          first.focus();
        } else if (active && !el.contains(active)) {
          // Focus drifted outside (rare) — reel it back in.
          e.stopImmediatePropagation();
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [onClose, onPrev, onNext, hasPrev, hasNext]);

  return (
    <div
      className="contest__lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="contest-lightbox-title"
      onClick={onClose}
    >
      <div
        className="contest__lightbox-panel"
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="contest__lightbox-close"
          ref={closeBtnRef}
          onClick={onClose}
          aria-label="Close image preview"
        >
          <X size={20} />
        </button>

        <div className="contest__lightbox-image-wrap">
          {!loaded && !errored && <div className="contest__lightbox-spinner" aria-hidden="true" />}
          {errored ? (
            <div className="contest__lightbox-error">
              <p>Failed to load full image.</p>
            </div>
          ) : (
            <img
              ref={imgRef}
              src={fullSrc}
              alt={isOwn ? `${sub.title} (your submission)` : sub.title}
              onLoad={handleLoad}
              onError={handleError}
              className={`contest__lightbox-image${loaded ? ' contest__lightbox-image--loaded' : ''}`}
            />
          )}
        </div>

        <div className="contest__lightbox-info">
          <div className="contest__lightbox-meta">
            <h3 id="contest-lightbox-title" className="contest__lightbox-title">{sub.title}</h3>
          </div>

          <div className="contest__lightbox-actions">
            <div className="contest__lightbox-nav">
              <button
                type="button"
                className="contest__lightbox-nav-btn"
                onClick={onPrev}
                disabled={!hasPrev}
                aria-label="Previous image"
              >
                <ChevronLeft size={20} />
              </button>
              <span className="contest__lightbox-counter" aria-live="polite">
                {index + 1} of {total}
              </span>
              <button
                type="button"
                className="contest__lightbox-nav-btn"
                onClick={onNext}
                disabled={!hasNext}
                aria-label="Next image"
              >
                <ChevronRight size={20} />
              </button>
            </div>

            <div className="contest__lightbox-select">
              {isOwn ? (
                <div className="contest__lightbox-own-label" role="status">
                  Your submission
                </div>
              ) : (
                <button
                  type="button"
                  className={`contest__modal-btn${isSelected ? ' contest__lightbox-select-btn--remove' : ''}`}
                  onClick={onToggleSelect}
                  disabled={!canSelect}
                  style={{ marginTop: 0 }}
                >
                  {isSelected
                    ? (<><Check size={16} aria-hidden="true" /> Selected — click to deselect</>)
                    : 'Select'}
                </button>
              )}
              <span className="contest__lightbox-cap-note" aria-live="polite">
                {isOwn
                  ? "You can't vote for your own submission."
                  : !isSelected && atSelectionCap
                    ? '3 of 3 already chosen — deselect one to swap.'
                    : ''}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* --- Tab config --- */

type TabId = 'submit' | 'vote' | 'rules' | 'gallery' | 'podium' | 'full-results';

interface TabDef {
  id: TabId;
  label: string;
}

const TABS_BY_STATUS: Record<Contest['status'], TabDef[]> = {
  upcoming: [],
  active: [
    { id: 'rules', label: 'Rules' },
    { id: 'submit', label: 'Submit' },
  ],
  voting: [
    { id: 'rules', label: 'Rules' },
    { id: 'vote', label: 'Vote' },
  ],
  completed: [
    { id: 'podium', label: 'Podium' },
    { id: 'full-results', label: 'Full Results' },
    { id: 'gallery', label: 'Gallery' },
  ],
};

const HEIGHT_REF_TAB: Record<Contest['status'], TabId> = {
  upcoming: 'rules',
  active: 'submit',
  voting: 'vote',
  completed: 'podium',
};

/* --- Shared Modal Shell --- */

function ModalShell({
  open,
  onClose,
  ariaLabel,
  children,
}: {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [isClosing, setIsClosing] = useState(false);

  const startClose = useCallback(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onClose();
    } else {
      setIsClosing(true);
    }
  }, [onClose]);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') startClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, startClose]);

  useEffect(() => {
    if (!open) return;
    const el = modalRef.current;
    if (!el) return;
    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = el.querySelectorAll<HTMLElement>(
        'button, [tabindex]:not([tabindex="-1"]), a[href], input, textarea, select'
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
  }, [open]);

  if (!open) return null;

  return (
    <div
      className={`contest__modal-backdrop${isClosing ? ' contest__modal-backdrop--closing' : ''}`}
      onClick={startClose}
      onAnimationEnd={() => { if (isClosing) { setIsClosing(false); onClose(); } }}
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div className="contest__modal" onClick={(e) => e.stopPropagation()}>
        <button
          className="contest__modal-close"
          onClick={startClose}
          aria-label="Close"
          ref={closeRef}
        >
          <X size={24} />
        </button>
        {children}
      </div>
    </div>
  );
}

/* --- Tab Bar --- */

function TabBar({
  tabs,
  activeTab,
  onTabChange,
  isAuthenticated = true,
}: {
  tabs: TabDef[];
  activeTab: TabId;
  onTabChange: (id: TabId) => void;
  isAuthenticated?: boolean;
}) {
  const tabListRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tabList = tabListRef.current;
    const indicator = indicatorRef.current;
    if (!tabList || !indicator) return;

    const activeBtn = tabList.querySelector<HTMLButtonElement>(
      `[data-tab-id="${activeTab}"]`
    );
    if (activeBtn) {
      indicator.style.left = `${activeBtn.offsetLeft}px`;
      indicator.style.width = `${activeBtn.offsetWidth}px`;
    }
  }, [activeTab]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const idx = tabs.findIndex((t) => t.id === activeTab);
    let nextIdx = idx;

    if (e.key === 'ArrowRight') {
      e.preventDefault();
      nextIdx = (idx + 1) % tabs.length;
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      nextIdx = (idx - 1 + tabs.length) % tabs.length;
    } else if (e.key === 'Home') {
      e.preventDefault();
      nextIdx = 0;
    } else if (e.key === 'End') {
      e.preventDefault();
      nextIdx = tabs.length - 1;
    } else {
      return;
    }

    onTabChange(tabs[nextIdx].id);
    const tabList = tabListRef.current;
    if (tabList) {
      const btn = tabList.querySelector<HTMLButtonElement>(
        `[data-tab-id="${tabs[nextIdx].id}"]`
      );
      btn?.focus();
    }
  };

  return (
    <div className="contest__tab-bar" ref={tabListRef} role="tablist" onKeyDown={handleKeyDown}>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        const isDisabled = !isAuthenticated && (tab.id === 'submit' || tab.id === 'vote');
        return (
          <button
            key={tab.id}
            className={`contest__tab${isActive ? ' contest__tab--active' : ''}${isDisabled ? ' contest__tab--disabled' : ''}`}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            data-tab-id={tab.id}
            onClick={() => onTabChange(tab.id)}
          >
            {isDisabled && <Lock size={12} />}
            {tab.label}
          </button>
        );
      })}
      <div className="contest__tab-indicator" ref={indicatorRef} />
    </div>
  );
}

/* --- Tab: Submit --- */

function TabSubmit({
  contest,
  onClose,
  file,
  setFile,
  title,
  setTitle,
  camera,
  focalLength,
  aperture,
  shutterSpeed,
  iso,
  submitted,
  setSubmitted,
  onContestRefresh,
}: {
  contest: Contest;
  onClose: () => void;
  file: File | null;
  setFile: (f: File | null) => void;
  title: string;
  setTitle: (v: string) => void;
  camera: string;
  focalLength: string;
  aperture: string;
  shutterSpeed: string;
  iso: string;
  submitted: boolean;
  setSubmitted: (v: boolean) => void;
  onContestRefresh: () => void;
}) {
  const { isAuthenticated, user } = useAuth();
  const [preview, setPreview] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const userSubCount = contest.userSubmissionCount ?? 0;
  const remaining = Math.max(0, 3 - userSubCount);
  const atLimit = userSubCount >= 3;

  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const canSubmit = file !== null && title.trim() !== '' && !atLimit;

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (atLimit) return;
    const f = e.dataTransfer.files[0];
    if (f && isImageFile(f)) {
      if (f.size > MAX_FILE_SIZE_BYTES) {
        setError(`Image must be under ${MAX_FILE_SIZE_MB}MB`);
        return;
      }
      setError(null);
      setFile(f);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      if (f.size > MAX_FILE_SIZE_BYTES) {
        setError(`Image must be under ${MAX_FILE_SIZE_MB}MB`);
        e.target.value = '';
        return;
      }
      setError(null);
      setFile(f);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !file) return;
    setCompressing(true);
    setError(null);
    try {
      const { file: compressed } = await compressImage(file, { maxSizeMB: MAX_FILE_SIZE_MB });
      setCompressing(false);
      setSubmitting(true);
      try {
        const formData = new FormData();
        formData.append('file', compressed);
        formData.append('title', title.trim());
        formData.append('photographer', `${user!.firstName} ${user!.lastName}`);
        if (camera.trim()) formData.append('exif_camera', camera.trim());
        if (focalLength.trim()) formData.append('exif_focal_length', focalLength.trim());
        if (aperture.trim()) formData.append('exif_aperture', aperture.trim());
        if (shutterSpeed.trim()) formData.append('exif_shutter_speed', shutterSpeed.trim());
        if (iso.trim()) formData.append('exif_iso', iso.trim());
        await submitPhoto(contest.id, formData);
        setSubmitted(true);
        onContestRefresh();
      } finally {
        setSubmitting(false);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to submit photo';
      setError(msg);
    } finally {
      setCompressing(false);
    }
  };

  if (!isAuthenticated) {
    return (
      <div role="tabpanel" aria-label="Submit">
        <div className="contest__submit-success">
          <Camera size={48} />
          <p>Log in to submit your photos</p>
          <Link to="/login" className="contest__modal-btn" onClick={onClose}>
            Log In
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div role="tabpanel" aria-label="Submit">
      {submitted ? (
        <div className="contest__submit-success">
          <Check size={48} />
          <p>Your submission has been received!</p>
          <button className="contest__modal-btn" onClick={onClose}>Close</button>
        </div>
      ) : (
        <form className="contest__submit-form" onSubmit={handleSubmit}>
          <div className="contest__submit-limit">
            <span>{remaining} of 3 submissions remaining</span>
          </div>
          {error && <p className="contest__submit-error">{error}</p>}

          <div
            className={`contest__dropzone${dragging ? ' contest__dropzone--active' : ''}${preview ? ' contest__dropzone--has-preview' : ''}${atLimit ? ' contest__dropzone--disabled' : ''}`}
            onClick={() => !atLimit && fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); if (!atLimit) setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            {preview ? (
              <img src={preview} alt="Preview" className="contest__dropzone-preview" />
            ) : (
              <div className="contest__dropzone-placeholder">
                <Camera size={32} />
                <p>{atLimit ? 'Submission limit reached' : 'Drag & drop your photo here, or click to browse'}</p>
                {!atLimit && <p className="contest__dropzone-hint">Max {MAX_FILE_SIZE_MB}MB</p>}
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept={IMAGE_ACCEPT}
              onChange={handleFileChange}
              className="contest__file-input"
              disabled={atLimit}
            />
          </div>

          <label className="contest__form-label">
            <span>Title <span className="contest__required">*</span></span>
            <input
              type="text"
              className="contest__form-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Give your photo a title"
              disabled={atLimit}
            />
          </label>

          <button
            type="submit"
            className="contest__modal-btn contest__modal-btn--submit"
            disabled={!canSubmit || compressing || submitting}
          >
            {compressing ? 'Compressing...' : submitting ? 'Submitting...' : atLimit ? 'Submission Limit Reached' : 'Submit Photo'}
          </button>
          <p className="contest__submit-disclaimer">Submissions cannot be changed once submitted.</p>
        </form>
      )}
    </div>
  );
}

/* --- Tab: Vote (Wizard) --- */

function WizardProgressBar({
  steps,
  currentStep,
}: {
  steps: string[];
  currentStep: number;
}) {
  return (
    <div className="contest__wizard-progress">
      {steps.map((label, i) => (
        <div
          key={label}
          className={`contest__wizard-step${i === currentStep ? ' contest__wizard-step--active' : ''}${i < currentStep ? ' contest__wizard-step--completed' : ''}`}
        >
          <div className="contest__wizard-step-dot">
            {i < currentStep ? <Check size={12} /> : i + 1}
          </div>
          <span className="contest__wizard-step-label">{label}</span>
        </div>
      ))}
    </div>
  );
}

function TabVote({
  contest,
  onClose,
  onContestRefresh,
}: {
  contest: Contest;
  onClose: () => void;
  onContestRefresh: () => void;
}) {
  const { isAuthenticated } = useAuth();

  // Determine categories for this contest
  const categories = useMemo<VoteCategory[]>(() => {
    const cats: VoteCategory[] = ['theme', 'favorite'];
    if (contest.wildcardCategory) cats.push('wildcard');
    return cats;
  }, [contest.wildcardCategory]);

  const stepLabels = useMemo(() => {
    return [...categories.map((c) => getCategoryLabel(c, contest.wildcardCategory)), 'Review'];
  }, [categories, contest.wildcardCategory]);

  // Per-voter, per-session shuffled ballot. We shuffle the ID list (not the
  // submission objects) and look each one up by id at render time, so an admin
  // edit landing during a voting session reflects the latest title/url without
  // resorting the ballot. The shuffle is keyed on the sorted-id signature so it
  // only re-shuffles if a submission is added or removed.
  const submissionIdsKey = useMemo(
    () => contest.submissions.map((s) => s.id).slice().sort((a, b) => a - b).join(','),
    [contest.submissions],
  );
  const shuffledIds = useMemo(
    () => shuffleArray(contest.submissions.map((s) => s.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [submissionIdsKey],
  );
  const subById = useMemo(
    () => new Map(contest.submissions.map((s) => [s.id, s])),
    [contest.submissions],
  );

  const [currentStep, setCurrentStep] = useState(0);
  const [selections, setSelections] = useState<Record<VoteCategory, Set<number>>>(() => ({
    theme: new Set(),
    favorite: new Set(),
    wildcard: new Set(),
  }));
  const [voted, setVoted] = useState(contest.userHasVoted === true);
  const [submittingVote, setSubmittingVote] = useState(false);
  const [voteError, setVoteError] = useState<string | null>(null);

  // Track step direction so the wrapper can pick the matching slide animation.
  // Starts equal to currentStep so the first paint is "forward" with no prior step
  // to slide from — the user just sees the initial step appear.
  const prevStepRef = useRef(currentStep);
  const direction: 'forward' | 'backward' =
    currentStep < prevStepRef.current ? 'backward' : 'forward';
  useLayoutEffect(() => {
    prevStepRef.current = currentStep;
  }, [currentStep]);

  // Lightbox state — null when closed; otherwise holds the submission id being viewed.
  const [lightboxId, setLightboxId] = useState<number | null>(null);
  const lightboxIndex = lightboxId == null ? -1 : shuffledIds.indexOf(lightboxId);
  const lightboxSub = lightboxId == null ? null : subById.get(lightboxId) ?? null;

  // The element that opened the lightbox — used to restore focus on close.
  const triggerElRef = useRef<HTMLElement | null>(null);
  const hadLightboxRef = useRef(false);
  useEffect(() => {
    if (lightboxId != null) {
      hadLightboxRef.current = true;
    } else if (hadLightboxRef.current) {
      triggerElRef.current?.focus();
      triggerElRef.current = null;
      hadLightboxRef.current = false;
    }
  }, [lightboxId]);

  // If the open submission disappears (admin edit during voting), close the lightbox.
  useEffect(() => {
    if (lightboxId != null && !subById.has(lightboxId)) {
      setLightboxId(null);
    }
  }, [lightboxId, subById]);

  // Prune selections that have become invalid since they were chosen — either
  // the submission was removed (admin delete) or its ownership flipped to the
  // current user (admin reassign). Without this, the user could submit a vote
  // that the backend rejects with a generic 400 and have no way to recover.
  useEffect(() => {
    setSelections((prev) => {
      let changed = false;
      const next: Record<VoteCategory, Set<number>> = { ...prev };
      for (const cat of categories) {
        const ids = prev[cat];
        const filtered = new Set<number>();
        for (const id of ids) {
          const s = subById.get(id);
          if (s && s.isOwn !== true) filtered.add(id);
        }
        if (filtered.size !== ids.size) {
          next[cat] = filtered;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [subById, categories]);

  // Defensive: any wizard step change closes the lightbox. Today the focus trap
  // and visual obscuring make this unreachable through the UI; this effect
  // guards future programmatic step changes from leaving stale lightbox state.
  useEffect(() => {
    setLightboxId(null);
  }, [currentStep]);

  const isReviewStep = currentStep === categories.length;
  const currentCategory = isReviewStep ? null : categories[currentStep];

  const toggleSelection = (category: VoteCategory, subId: number) => {
    setSelections((prev) => {
      const s = new Set(prev[category]);
      if (s.has(subId)) {
        s.delete(subId);
      } else if (s.size < 3) {
        s.add(subId);
      }
      return { ...prev, [category]: s };
    });
  };

  const currentSelectionCount = currentCategory ? selections[currentCategory].size : 0;
  const canGoNext = currentCategory !== null;

  const handleCastVotes = async () => {
    setSubmittingVote(true);
    setVoteError(null);
    try {
      const votes = categories
        .filter((cat) => selections[cat].size > 0)
        .map((cat) => ({
          category: cat,
          submissionIds: [...selections[cat]],
        }));
      await castVote(contest.id, votes);
      setVoted(true);
      onContestRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to cast votes';
      setVoteError(msg);
    }
    setSubmittingVote(false);
  };

  if (!isAuthenticated) {
    return (
      <div role="tabpanel" aria-label="Vote">
        <div className="contest__submit-success">
          <Camera size={48} />
          <p>Log in to vote</p>
          <Link to="/login" className="contest__modal-btn" onClick={onClose}>
            Log In
          </Link>
        </div>
      </div>
    );
  }

  if (voted) {
    return (
      <div role="tabpanel" aria-label="Vote">
        <div className="contest__submit-success">
          <Check size={48} />
          <p>You&apos;ve already voted in this contest!</p>
          <button className="contest__modal-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  return (
    <div role="tabpanel" aria-label="Vote">
      <WizardProgressBar steps={stepLabels} currentStep={currentStep} />

      <div
        key={currentStep}
        className={`contest__vote-step contest__vote-step--${direction}`}
      >
        {/* Category step */}
        {currentCategory && (() => {
          const Icon = CATEGORY_ICON[currentCategory];
          return (
          <>
            <div className="contest__vote-header">
              <div className="contest__vote-header-row">
                <h3 className="contest__vote-header-title">
                  <Icon size={18} aria-hidden="true" />
                  {getCategoryLabel(currentCategory, contest.wildcardCategory)}
                </h3>
                <span
                  className={`contest__vote-header-chip${
                    currentSelectionCount === 3 ? ' contest__vote-header-chip--full' : ''
                  }`}
                  aria-live="polite"
                >
                  {currentSelectionCount} / 3
                </span>
              </div>
              <p className="contest__vote-header-action">Select up to 3 photos</p>
            </div>
            <div className="contest__vote-grid">
              {shuffledIds.map((id) => {
                const sub = subById.get(id);
                if (!sub) return null;
                const isOwn = sub.isOwn === true;
                const selected = selections[currentCategory].has(sub.id);
                const maxReached = selections[currentCategory].size >= 3;
                const capped = !selected && maxReached;
                // Selection is gated by both reasons; the visual state (and class) tracks
                // each separately so users get the right helper text in the lightbox.
                const selectionDisabled = isOwn || capped;
                const ariaLabel = isOwn ? `${sub.title} (your submission, not eligible to vote)` : sub.title;
                return (
                  <div
                    key={sub.id}
                    className={`contest__vote-thumb${selected ? ' contest__vote-thumb--selected' : ''}${capped ? ' contest__vote-thumb--disabled' : ''}${isOwn ? ' contest__vote-thumb--own' : ''}`}
                    onClick={() => !selectionDisabled && toggleSelection(currentCategory, sub.id)}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && !selectionDisabled) {
                        e.preventDefault();
                        toggleSelection(currentCategory, sub.id);
                      }
                    }}
                    tabIndex={selectionDisabled ? -1 : 0}
                    role="checkbox"
                    aria-checked={selected}
                    aria-disabled={selectionDisabled}
                    aria-label={ariaLabel}
                  >
                    <div className="contest__vote-thumb-image">
                      <button
                        type="button"
                        className="contest__vote-thumb-expand"
                        onClick={(e) => {
                          e.stopPropagation();
                          triggerElRef.current = e.currentTarget;
                          setLightboxId(sub.id);
                        }}
                        onKeyDown={(e) => {
                          // Stop Enter/Space from bubbling to the thumb's selection toggle.
                          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
                        }}
                        aria-label={`Expand ${sub.title}`}
                      >
                        <Maximize2 size={14} aria-hidden="true" />
                      </button>
                      <img src={getImageUrl(sub.url, 'thumb')} alt={sub.title} loading="lazy" />
                      {selected && (
                        <div className="contest__vote-check" aria-hidden="true">
                          <Check size={40} strokeWidth={3} />
                        </div>
                      )}
                    </div>
                    <div className="contest__vote-info">
                      <span className="contest__vote-title">{sub.title}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
          );
        })()}

        {/* Review step */}
        {isReviewStep && (
          <div className="contest__wizard-review">
            <p className="contest__modal-subtitle">Review your selections</p>
            {voteError && <p className="contest__submit-error">{voteError}</p>}
            {categories.map((cat) => (
              <div key={cat} className="contest__wizard-review-category">
                <div className="contest__wizard-review-header">
                  <span>{getCategoryLabel(cat, contest.wildcardCategory)}</span>
                  <button
                    className="contest__wizard-review-edit"
                    onClick={() => setCurrentStep(categories.indexOf(cat))}
                  >
                    Edit
                  </button>
                </div>
                <div className="contest__wizard-review-photos">
                  {[...selections[cat]].map((subId) => {
                    const sub = contest.submissions.find((s) => s.id === subId);
                    if (!sub) return null;
                    return (
                      <div key={subId} className="contest__wizard-review-photo">
                        <img src={getImageUrl(sub.url, 'thumb')} alt={sub.title} />
                        <span>{sub.title}</span>
                      </div>
                    );
                  })}
                  {selections[cat].size === 0 && (
                    <span className="contest__wizard-review-empty">No selections</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {isReviewStep && (
          <p className="contest__submit-disclaimer">Once submitted, your vote cannot be changed.</p>
        )}
      </div>

      {/* Wizard footer */}
      <div className="contest__wizard-footer">
        <button
          className="contest__modal-btn"
          onClick={() => setCurrentStep((s) => s - 1)}
          disabled={currentStep === 0}
          style={{ opacity: currentStep === 0 ? 0.4 : 1 }}
        >
          Back
        </button>
        {isReviewStep ? (
          <button
            className="contest__modal-btn contest__modal-btn--submit"
            onClick={handleCastVotes}
            disabled={submittingVote}
            style={{ width: 'auto', marginTop: 0 }}
          >
            {submittingVote ? 'Submitting...' : 'Cast Votes'}
          </button>
        ) : (
          <button
            className="contest__modal-btn"
            onClick={() => setCurrentStep((s) => s + 1)}
            disabled={!canGoNext}
          >
            Next
          </button>
        )}
      </div>

      {lightboxId != null && lightboxSub && currentCategory != null && (
        <VoteLightbox
          sub={lightboxSub}
          index={lightboxIndex}
          total={shuffledIds.length}
          isSelected={selections[currentCategory].has(lightboxSub.id)}
          atSelectionCap={selections[currentCategory].size >= 3}
          isOwn={lightboxSub.isOwn === true}
          onClose={() => setLightboxId(null)}
          onPrev={() => {
            if (lightboxIndex > 0) setLightboxId(shuffledIds[lightboxIndex - 1]);
          }}
          onNext={() => {
            if (lightboxIndex >= 0 && lightboxIndex < shuffledIds.length - 1) {
              setLightboxId(shuffledIds[lightboxIndex + 1]);
            }
          }}
          onToggleSelect={() => toggleSelection(currentCategory, lightboxSub.id)}
        />
      )}
    </div>
  );
}

/* --- Tab: Rules --- */

function TabRules({ contest }: { contest: Contest }) {
  const isVoting = contest.status === 'voting';
  const isActive = contest.status === 'active';

  return (
    <div role="tabpanel" aria-label="Rules">
      {isVoting && (
        <div className="contest__rules-voting-info">
          <h3>How Voting Works</h3>
          <ul className="contest__rules-list">
            <li>
              Vote in {contest.wildcardCategory ? '3' : '2'} categories: Best Addresses the Theme, Personal Favorite{contest.wildcardCategory ? `, and ${contest.wildcardCategory}` : ''}
            </li>
            <li>Select up to 3 photos per category</li>
            <li>Votes are final and cannot be changed</li>
            <li>Voting deadline: {getVotingDeadline(contest.deadline)}</li>
            <li>Results are revealed after the voting period ends</li>
          </ul>
          <details className="contest__rules-details">
            <summary className="contest__rules-details-summary">View Original Submission Guidelines</summary>
            <ul className="contest__rules-list">
              <li>Maximum 3 submissions per person</li>
              <li>Submissions cannot be changed once submitted</li>
              <li>Submission deadline: {formatDeadline(contest.deadline)}</li>
              {contest.guidelines.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {isActive && (
        <div className="contest__rules-voting-info">
          {contest.description && (
            <p className="contest__rules-description">{contest.description}</p>
          )}
          <h3>Submission Info</h3>
          <ul className="contest__rules-list">
            <li>Maximum 3 submissions per person</li>
            <li>Submissions cannot be changed once submitted</li>
            <li>Submission deadline: {formatDeadline(contest.deadline)}</li>
            {contest.guidelines.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
          {contest.wildcardCategory && (
            <div className="contest__rules-bonus">
              <h3>Bonus Challenge Category</h3>
              <p>{contest.wildcardCategory}</p>
            </div>
          )}
        </div>
      )}

    </div>
  );
}

/* --- Tab: Gallery --- */

function TabGallery({ contest }: { contest: Contest }) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const expandedSub = expandedId
    ? contest.submissions.find((s) => s.id === expandedId) ?? null
    : null;

  if (expandedSub) {
    const exifStr = formatExif(expandedSub.exif);
    return (
      <div role="tabpanel" aria-label="Gallery">
        <div className="contest__gallery-expanded">
          <button
            className="contest__gallery-back"
            onClick={() => setExpandedId(null)}
          >
            <ArrowLeft size={16} /> Back to gallery
          </button>
          <img
            src={getImageUrl(expandedSub.url, 'medium')}
            alt={expandedSub.title}
            className="contest__gallery-expanded-img"
          />
          <div className="contest__gallery-expanded-info">
            <h3>{expandedSub.title}</h3>
            {expandedSub.photographer && (
              <p className="contest__gallery-expanded-photographer">
                {expandedSub.photographer}
              </p>
            )}
            {exifStr && (
              <p className="contest__gallery-expanded-exif">{exifStr}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div role="tabpanel" aria-label="Gallery">
      <div className="contest__gallery-grid">
        {contest.submissions.map((sub) => (
          <div
            key={sub.id}
            className="contest__gallery-item"
            onClick={() => setExpandedId(sub.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setExpandedId(sub.id);
              }
            }}
            tabIndex={0}
            role="button"
            aria-label={sub.photographer ? `View ${sub.title} by ${sub.photographer}` : `View ${sub.title}`}
          >
            <img
              src={getImageUrl(sub.url, 'medium')}
              alt={sub.title}
              loading="lazy"
            />
            <div className="contest__gallery-item-overlay">
              <span className="contest__gallery-item-title">{sub.title}</span>
              {sub.photographer && (
                <span className="contest__gallery-item-photographer">{sub.photographer}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* --- Tab: Podium (Carousel) --- */

function TabPodium({ contest }: { contest: Contest }) {
  const categories = useMemo<VoteCategory[]>(() => {
    const cats: VoteCategory[] = ['theme', 'favorite'];
    if (contest.wildcardCategory) cats.push('wildcard');
    return cats;
  }, [contest.wildcardCategory]);

  const [activeSlide, setActiveSlide] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  // Auto-rotate
  useEffect(() => {
    if (categories.length <= 1 || isPaused) return;
    const timer = setInterval(() => {
      setActiveSlide((s) => (s + 1) % categories.length);
    }, 6000);
    return () => clearInterval(timer);
  }, [categories.length, isPaused]);

  const trophyColor = (place: number) => {
    if (place === 1) return '#FFD700';
    if (place === 2) return '#C0C0C0';
    return '#CD7F32';
  };

  const placeLabel = (place: number) => {
    if (place === 1) return '1st Place';
    if (place === 2) return '2nd Place';
    return '3rd Place';
  };

  if (categories.length === 0) {
    return (
      <div role="tabpanel" aria-label="Podium">
        <p className="contest__modal-subtitle">No winners have been announced yet.</p>
      </div>
    );
  }

  const currentCat = categories[activeSlide];

  // Resolve podium submissions and recompute competition ranks from vote data
  // so ties display correctly regardless of stored place values.
  const winnersForCat = (() => {
    const raw = (contest.winners || [])
      .filter((w) => (w.category || 'theme') === currentCat)
      .map((w) => {
        const sub = contest.submissions.find((s) => s.id === w.submissionId);
        if (!sub) return null;
        const votes = sub.categoryVotes ? sub.categoryVotes[currentCat] : (sub.votes ?? 0);
        return { ...sub, votes };
      })
      .filter((x): x is ContestSubmission & { votes: number } => x !== null)
      .sort((a, b) => b.votes - a.votes);

    // Assign competition ranks (ties share the same rank)
    let currentRank = 1;
    return raw.map((sub, i) => {
      if (i > 0 && sub.votes < raw[i - 1].votes) currentRank = i + 1;
      const place = (currentRank <= 3 ? currentRank : 3) as 1 | 2 | 3;
      return { ...sub, place };
    });
  })();

  const mentionsForCat = (contest.honorableMentions || [])
    .filter((hm) => (hm.category || 'theme') === currentCat)
    .map((hm) => contest.submissions.find((s) => s.id === hm.submissionId))
    .filter((x): x is ContestSubmission => x !== undefined);

  return (
    <div
      role="tabpanel"
      aria-label="Podium"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      <div className="contest__carousel">
        {categories.length > 1 && (
          <button
            className="contest__carousel-arrow contest__carousel-arrow--left"
            onClick={() => setActiveSlide((s) => (s - 1 + categories.length) % categories.length)}
            aria-label="Previous category"
          >
            <ChevronLeft size={20} />
          </button>
        )}

        <div key={currentCat} className="contest__carousel-slide contest__carousel-slide--active">
          <h3 className="contest__carousel-category-label">
            {getCategoryLabel(currentCat, contest.wildcardCategory)}
          </h3>

          <div className="contest__podium-stage">
            {winnersForCat.length === 0 && (
              <p className="contest__modal-subtitle">No winners announced for this category.</p>
            )}
            {winnersForCat.map((p) => (
              <div
                key={p.id}
                className={`contest__podium-place contest__podium-place--${p.place}`}
              >
                <div className="contest__podium-photo">
                  <img src={getImageUrl(p.url, 'thumb')} alt={p.title} />
                </div>
                <div className="contest__podium-text">
                  <Trophy size={24} color={trophyColor(p.place)} />
                  <span className="contest__podium-label" style={{ color: trophyColor(p.place) }}>
                    {placeLabel(p.place)}
                  </span>
                  <span className="contest__podium-title">{p.title}</span>
                  <span className="contest__podium-photographer">{p.photographer}</span>
                  <span className="contest__podium-votes">{(p.categoryVotes ? p.categoryVotes[currentCat] : (p.votes ?? 0))} votes</span>
                </div>
              </div>
            ))}
          </div>

          {mentionsForCat.length > 0 && (
            <div className="contest__podium-mentions">
              <h3 className="contest__podium-mentions-heading">Honorable Mentions</h3>
              <div className="contest__podium-mentions-grid">
                {mentionsForCat.map((m) => (
                  <div key={m.id} className="contest__podium-mention-card">
                    <img src={getImageUrl(m.url, 'thumb')} alt={m.title} />
                    <div className="contest__podium-mention-info">
                      <span className="contest__podium-mention-title">{m.title}</span>
                      <span className="contest__podium-mention-photographer">{m.photographer}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {categories.length > 1 && (
          <button
            className="contest__carousel-arrow contest__carousel-arrow--right"
            onClick={() => setActiveSlide((s) => (s + 1) % categories.length)}
            aria-label="Next category"
          >
            <ChevronRight size={20} />
          </button>
        )}
      </div>

      {categories.length > 1 && (
        <div className="contest__carousel-dots">
          {categories.map((cat, i) => (
            <button
              key={cat}
              className={`contest__carousel-dot${i === activeSlide ? ' contest__carousel-dot--active' : ''}`}
              onClick={() => setActiveSlide(i)}
            >
              {getCategoryLabel(cat, contest.wildcardCategory)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* --- Tab: Full Results --- */

function TabFullResults({ contest }: { contest: Contest }) {
  const categories = useMemo<VoteCategory[]>(() => {
    const cats: VoteCategory[] = ['theme', 'favorite'];
    if (contest.wildcardCategory) cats.push('wildcard');
    return cats;
  }, [contest.wildcardCategory]);

  const [selectedCategory, setSelectedCategory] = useState<VoteCategory>(categories[0]);

  const ranked = useMemo(() => {
    const sorted = [...contest.submissions]
      .sort((a, b) => {
        const aVotes = a.categoryVotes ? a.categoryVotes[selectedCategory] : (a.votes ?? 0);
        const bVotes = b.categoryVotes ? b.categoryVotes[selectedCategory] : (b.votes ?? 0);
        return bVotes - aVotes;
      })
      .slice(0, 10);

    // Top 3: competition-style ranks (ties share rank). 4+: sequential.
    let currentRank = 1;
    return sorted.map((sub, i) => {
      const votes = sub.categoryVotes ? sub.categoryVotes[selectedCategory] : (sub.votes ?? 0);
      if (i > 0) {
        const prevVotes = sorted[i - 1].categoryVotes
          ? sorted[i - 1].categoryVotes![selectedCategory]
          : (sorted[i - 1].votes ?? 0);
        if (votes < prevVotes) currentRank = i + 1;
      }
      // After the podium, switch to simple sequential ranks
      const displayRank = currentRank <= 3 ? currentRank : i + 1;
      return { ...sub, competitionRank: displayRank };
    });
  }, [contest.submissions, selectedCategory]);

  const stats = useMemo(() => {
    let totalVotes = 0;
    for (const s of contest.submissions) {
      totalVotes += s.categoryVotes ? s.categoryVotes[selectedCategory] : (s.votes ?? 0);
    }
    const avgVotes = contest.submissions.length > 0
      ? (totalVotes / contest.submissions.length).toFixed(1)
      : '0';
    const uniquePhotographers = new Set(contest.submissions.map((s) => s.photographer)).size;
    return { totalVotes, avgVotes, uniquePhotographers };
  }, [contest.submissions, selectedCategory]);

  const getVotesForSub = (sub: ContestSubmission) => {
    return sub.categoryVotes ? sub.categoryVotes[selectedCategory] : (sub.votes ?? 0);
  };

  const medalColor = (rank: number) => {
    if (rank === 1) return '#FFD700';
    if (rank === 2) return '#C0C0C0';
    if (rank === 3) return '#CD7F32';
    return undefined;
  };

  return (
    <div role="tabpanel" aria-label="Full Results">
      <div className="contest__category-pills">
        {categories.map((cat) => (
          <button
            key={cat}
            className={`contest__category-pill${cat === selectedCategory ? ' contest__category-pill--active' : ''}`}
            onClick={() => setSelectedCategory(cat)}
          >
            {getCategoryLabel(cat, contest.wildcardCategory)}
          </button>
        ))}
      </div>

      <div className="contest__results-list">
        {ranked.map((sub) => {
          const rank = sub.competitionRank;
          const color = medalColor(rank);
          return (
            <div
              key={sub.id}
              className={`contest__results-row${rank <= 3 ? ' contest__results-row--medal' : ''}`}
              style={color ? { borderLeftColor: color } : undefined}
            >
              <span
                className="contest__results-rank"
                style={color ? { color } : undefined}
              >
                {rank}
              </span>
              <img
                className="contest__results-thumb"
                src={getImageUrl(sub.url, 'thumb')}
                alt={sub.title}
                loading="lazy"
              />
              <div className="contest__results-info">
                <span className="contest__results-name">{sub.title}</span>
                <span className="contest__results-photographer">{sub.photographer}</span>
              </div>
              {rank <= 3 && (
                <span className="contest__results-votes">{getVotesForSub(sub)} votes</span>
              )}
            </div>
          );
        })}
      </div>

      <div className="contest__results-stats">
        <div className="contest__results-stat">
          <span className="contest__results-stat-value">{stats.totalVotes}</span>
          <span className="contest__results-stat-label">Total Votes</span>
        </div>
        <div className="contest__results-stat">
          <span className="contest__results-stat-value">{stats.avgVotes}</span>
          <span className="contest__results-stat-label">Avg Votes / Photo</span>
        </div>
        <div className="contest__results-stat">
          <span className="contest__results-stat-value">{stats.uniquePhotographers}</span>
          <span className="contest__results-stat-label">Unique Photographers</span>
        </div>
      </div>
    </div>
  );
}

/* --- Contest Modal (unified) --- */

function ContestModal({
  contest,
  onClose,
  onContestRefresh,
}: {
  contest: Contest;
  onClose: () => void;
  onContestRefresh: () => void;
}) {
  const { isAuthenticated } = useAuth();
  const tabs = TABS_BY_STATUS[contest.status];
  const refTab = HEIGHT_REF_TAB[contest.status];
  const [activeTab, setActiveTab] = useState<TabId>(refTab);

  // Lifted submission form state
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [camera, setCamera] = useState('');
  const [focalLength, setFocalLength] = useState('');
  const [aperture, setAperture] = useState('');
  const [shutterSpeed, setShutterSpeed] = useState('');
  const [iso, setIso] = useState('');
  const [submitted, setSubmitted] = useState(false);

  // Auto-extract EXIF from original file before compression
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    extractExif(file).then((exif) => {
      if (cancelled) return;
      if (exif.camera) setCamera((v) => v || exif.camera);
      if (exif.focalLength) setFocalLength((v) => v || exif.focalLength);
      if (exif.aperture) setAperture((v) => v || exif.aperture);
      if (exif.shutterSpeed) setShutterSpeed((v) => v || exif.shutterSpeed);
      if (exif.iso) setIso((v) => v || exif.iso);
    });
    return () => { cancelled = true; };
  }, [file]);

  const tabContentRef = useRef<HTMLDivElement>(null);
  const [lockedHeight, setLockedHeight] = useState<number | null>(null);

  // Track mobile viewport so we can skip the height-locking mechanism below.
  // Locking the tab-content height to the podium tab's offsetHeight makes the
  // modal stable across tab switches on desktop, but on mobile the podium's
  // column layout is much taller than the 92vh modal — locking it would clip
  // the bottom of every tab (Issue 6). On mobile we just let flex: 1 +
  // overflow-y: auto handle sizing.
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
  );
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 768px)');
    const onChange = () => setIsMobile(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  // Run once on mount. The first render shows the refTab content (so its layout
  // can be measured before paint); after measuring we switch to the first tab.
  // We deliberately do NOT re-run on isMobile changes — measuring after a
  // viewport transition would capture the *current* tab's height, not the
  // canonical refTab's, locking the modal to a wrong size. Use the live
  // matchMedia value here so a desktop mount measures, a mobile mount doesn't.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!tabContentRef.current) return;
    const isMobileAtMount = window.matchMedia('(max-width: 768px)').matches;
    if (!isMobileAtMount) {
      setLockedHeight(tabContentRef.current.offsetHeight);
    }
    if (refTab !== tabs[0].id) {
      setActiveTab(tabs[0].id);
    }
  }, []);

  const modalTitle =
    contest.status === 'active'
      ? `Submit to "${contest.theme}"`
      : contest.status === 'voting'
        ? `Vote — "${contest.theme}"`
        : contest.status === 'upcoming'
          ? `Upcoming — "${contest.theme}"`
          : `Results — "${contest.theme}"`;

  return (
    <ModalShell open ariaLabel={modalTitle} onClose={onClose}>
      <h2 className="contest__modal-title">
        {contest.status === 'completed' && <Trophy size={22} />}
        {modalTitle}
      </h2>

      <div
        className="contest__tab-content"
        ref={tabContentRef}
        style={lockedHeight !== null && !isMobile ? { height: lockedHeight, flex: 'none' } : undefined}
      >
        {/* TabBar lives inside tab-content (the scroll container) so it can be
            position: sticky; top: 0 — keeps the tab labels glued to the top of
            the visible content area regardless of modal height pressure. */}
        <TabBar tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} isAuthenticated={isAuthenticated} />
        <div key={activeTab} className="contest__tab-panel">
          {activeTab === 'submit' && (
            <TabSubmit
              contest={contest}
              onClose={onClose}
              file={file}
              setFile={setFile}
              title={title}
              setTitle={setTitle}
              camera={camera}
              focalLength={focalLength}
              aperture={aperture}
              shutterSpeed={shutterSpeed}
              iso={iso}
              submitted={submitted}
              setSubmitted={setSubmitted}
              onContestRefresh={onContestRefresh}
            />
          )}
          {activeTab === 'vote' && (
            <TabVote
              contest={contest}
              onClose={onClose}
              onContestRefresh={onContestRefresh}
            />
          )}
          {activeTab === 'rules' && <TabRules contest={contest} />}
          {activeTab === 'gallery' && <TabGallery contest={contest} />}
          {activeTab === 'podium' && <TabPodium contest={contest} />}
          {activeTab === 'full-results' && <TabFullResults contest={contest} />}
        </div>
      </div>
    </ModalShell>
  );
}

/* --- Contest Card --- */

function ContestCard({
  contest,
  onClick,
}: {
  contest: Contest;
  onClick: () => void;
}) {
  const isUpcoming = contest.status === 'upcoming';
  const statusLabel =
    contest.status === 'active'
      ? 'Open for Submissions'
      : contest.status === 'voting'
        ? 'Voting in Progress'
        : contest.status === 'upcoming'
          ? 'Upcoming'
          : 'Completed';

  return (
    <div
      className={`contest__card fade-in-up${isUpcoming ? ' contest__card--upcoming' : ''}`}
      onClick={isUpcoming ? undefined : onClick}
      onKeyDown={isUpcoming ? undefined : (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      tabIndex={isUpcoming ? -1 : 0}
      role={isUpcoming ? undefined : 'button'}
      aria-label={`${contest.theme} — ${statusLabel}`}
    >
      <div className="contest__card-header">
        <span className={`contest__status contest__status--${contest.status}`}>
          {statusLabel}
        </span>
        <h2>{contest.theme}</h2>
        <p className="contest__card-month">{contest.month}</p>
        <p className="contest__card-desc">{contest.description}</p>
      </div>

      <div className="contest__card-stats">
        <div className="contest__stat">
          <Camera size={18} />
          <span>{contest.submissionCount} submissions</span>
        </div>
        <div className="contest__stat">
          <Users size={18} />
          <span>{contest.participantCount} participants</span>
        </div>
        <div className="contest__stat">
          <span className="contest__stat-date">
            {contest.status === 'completed'
              ? 'Completed'
              : contest.status === 'voting'
                ? `Voting Deadline: ${getVotingDeadline(contest.deadline)}`
                : `Deadline: ${formatDeadline(contest.deadline)}`}
          </span>
        </div>
      </div>
    </div>
  );
}

/* --- Main Contest Page --- */

export default function ContestPage() {
  const [contests, setContests] = useState<Contest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [openModal, setOpenModal] = useState<{ contestId: number } | null>(null);
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const loadData = useCallback(() => {
    setLoading(true);
    setError(false);
    getContests()
      .then((data) => {
        setContests(data);
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

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  useScrollReveal();

  // Infinite scroll
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisibleCount((v) => v + BATCH_SIZE);
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loading]);

  const activeContest = contests.find((c) => c.status === 'active') ?? contests[0];
  const visibleContests = contests.slice(0, visibleCount);
  const modalContest = openModal ? contests.find((c) => c.id === openModal.contestId) : null;

  if (loading) {
    return (
      <div className="contest-page">
        <div className="contest-page__loading">
          <div className="section-spinner">
            <div className="section-spinner__ring" />
          </div>
        </div>
      </div>
    );
  }

  if (error || contests.length === 0) {
    return (
      <div className="contest-page">
        <div className="contest-page__error">
          <div className="section-error">
            <p>Something went wrong loading contests.</p>
            <button className="section-error__btn" onClick={loadData}>
              Try Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="contest-page">
      {/* Hero Banner */}
      <div className="contest-page__hero">
        <div className="contest-page__hero-bg">
          <img
            src={getImageUrl(activeContest?.submissions[0]?.url ?? 'https://picsum.photos/seed/contest-hero/1600/600', 'full')}
            alt=""
            aria-hidden="true"
          />
        </div>
        <div className="contest-page__hero-content container">
          <span className="contest-page__hero-badge">Monthly Photo Contest</span>
          <h1>{activeContest?.theme ?? 'Photo Contest'}</h1>
          <p>{activeContest?.description ?? ''}</p>
        </div>
      </div>

      <div className="container">
        {/* Contest Cards */}
        <div className="contest__cards">
          {visibleContests.map((c) => (
            <ContestCard
              key={c.id}
              contest={c}
              onClick={() => setOpenModal({ contestId: c.id })}
            />
          ))}
        </div>

        {/* Infinite scroll sentinel */}
        {visibleCount < contests.length && (
          <div ref={sentinelRef} className="contest__sentinel" />
        )}
      </div>

      <Footer />

      {/* Modal */}
      {modalContest && (
        <ContestModal
          contest={modalContest}
          onClose={() => setOpenModal(null)}
          onContestRefresh={loadData}
        />
      )}
    </div>
  );
}

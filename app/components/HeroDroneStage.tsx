/**
 * The hero's 3D layer: the scroll-driven walkthrough, its progress rail, and the
 * copy panel that follows it.
 *
 * This is an absolutely-positioned layer, not a section of its own — it fills
 * the hero's sticky pane so the wordmark, size selector and buy bubble sit over
 * the same drone. The route owns the splash; this owns the drone.
 *
 * Rendering rules live here rather than in the scene: the 3D is skipped under
 * 768px or `prefers-reduced-motion`, matching the policy the rest of the
 * homepage uses, and in that case the fallback list becomes the actual content
 * instead of being visually hidden.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import type {
  HeroBeat,
  HeroDroneSceneProps,
  HeroLoadState,
} from '~/components/HeroDroneScene';

function shouldLoad3D() {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  if (window.innerWidth < 768) return false;
  return true;
}

// three.js and the scene are a large chunk, and mobile renders a static page
// instead, so this must stay a dynamic import or every phone downloads a
// renderer it never uses. Started at module eval rather than in an effect so it
// races hydration; the type-only import above adds no runtime dependency.
const scenePromise =
  typeof window !== 'undefined' && shouldLoad3D()
    ? import('~/components/HeroDroneScene')
    : null;

export function HeroDroneStage({
  model,
  size,
  onLoad,
  onReady,
  onProgress,
  onBeat,
  onBeats,
}: {
  model?: string;
  size?: string;
  /** Model download progress, for the route's splash. */
  onLoad?: (s: HeroLoadState) => void;
  /** Fires once the drone is rigged and the walkthrough is live. */
  onReady?: () => void;
  /** Walkthrough position 0..1, every frame. */
  onProgress?: (f: number) => void;
  /** Presented beat, or null while the drone rests whole between parts. */
  onBeat?: (beat: HeroBeat | null, index: number) => void;
  /** The whole beat list once known, in order. */
  onBeats?: (beats: HeroBeat[]) => void;
}) {
  // The homepage drives this from its size selector. The scene falls back to
  // the 3 inch if the requested design has no assembly built yet, so adding
  // od5/ later is the only step needed to light this up.
  const folder = model ?? `od${size ?? '3'}`;
  const [use3D, setUse3D] = useState(false);
  const [Scene, setScene] = useState<React.ComponentType<HeroDroneSceneProps> | null>(
    null,
  );
  useEffect(() => {
    if (!shouldLoad3D() || !scenePromise) {
      // Tell the route now, or it sits behind the splash's dim layer waiting out
      // the safety timeout on a machine that will never show a drone.
      onReady?.();
      return;
    }
    setUse3D(true);
    scenePromise
      .then((m) => setScene(() => m.HeroDroneScene))
      .catch((err) => {
        console.error('[hero] failed to load the 3D scene chunk:', err);
        onReady?.();
      });
  }, [onReady]);

  const [beats, setBeats] = useState<HeroBeat[]>([]);
  const [active, setActive] = useState(0);
  // True while the drone rests whole between parts (the scene reports beat
  // null). The copy panel clears; the rail keeps the last part's dot lit.
  // Starts true: the sequence opens on the whole drone, which carries no
  // caption, and the scene only reports once a part is presented.
  const [resting, setResting] = useState(true);
  const seek = useRef<((i: number) => void) | null>(null);
  const fillRef = useRef<HTMLDivElement>(null);

  const handleBeat = useCallback(
    (b: HeroBeat | null, i: number) => {
      setResting(!b);
      if (b && i >= 0) setActive(i);
      onBeat?.(b, i);
    },
    [onBeat],
  );
  const handleBeats = useCallback(
    (b: HeroBeat[]) => {
      setBeats(b);
      onBeats?.(b);
    },
    [onBeats],
  );
  const onSeeker = useCallback((fn: (i: number) => void) => {
    seek.current = fn;
  }, []);
  // Fires every frame, so it writes straight to the DOM rather than to state.
  const handleProgress = useCallback(
    (f: number) => {
      if (fillRef.current)
        fillRef.current.style.width = `${Math.max(0, Math.min(1, f)) * 100}%`;
      onProgress?.(f);
    },
    [onProgress],
  );

  const beat = beats[active];

  return (
    <div className="hp-stage">
      {Scene ? (
        <Scene
          model={folder}
          onBeat={handleBeat}
          onBeats={handleBeats}
          onProgress={handleProgress}
          onLoad={onLoad}
          onReady={onReady}
          onSeeker={onSeeker}
        />
      ) : null}

      {use3D ? (
        <nav className="hp-rail" aria-label="Drone parts">
          <div className="hp-rail-fill" ref={fillRef} />
          {beats.map((b, i) => (
            <button
              key={b.id}
              type="button"
              className={`hp-dot${i === active ? ' on' : ''}${i < active ? ' done' : ''}`}
              style={{left: `${(i / Math.max(1, beats.length - 1)) * 100}%`}}
              aria-label={b.title}
              aria-current={i === active ? 'true' : undefined}
              onClick={() => seek.current?.(i)}
            />
          ))}
        </nav>
      ) : null}

      {/* The spotlight cuts as a part leaves; that is the cue for this.
          During a rest the panel clears entirely: the whole drone is the
          content, and a caption would race ahead of the next part. */}
      {use3D && !resting ? (
        <div className="hp-copy" key={beat?.id} aria-live="polite">
          {/* No step counter: the rail's dots already say where you are. */}
          {beat ? (
            <>
              <h2 className="hp-title">{beat.title}</h2>
              <p className="hp-note">{beat.note}</p>
            </>
          ) : null}
        </div>
      ) : null}

      {/* Every beat's copy in the DOM, always. Without this most of the text
          exists only in JS state: invisible to crawlers, to screen readers, and
          to anyone whose device never loads the scene. */}
      <ul className="hp-fallback">
        {beats.map((b) => (
          <li key={b.id}>
            <h3>{b.title}</h3>
            <p>{b.note}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Sound manager for the Practice live game. Plays real sampled audio from
 * /sounds/practice/ — the Lichess "SFX" set by Enigmahack, AGPL-3-licensed
 * (see apps/web/public/sounds/practice/NOTICE).
 *
 * Sounds are silenced when the user has soundEnabled = false in their prefs.
 */

type SoundKind = 'move' | 'capture' | 'check' | 'gameStart' | 'win' | 'loss' | 'draw' | 'lowTime';

const FILES: Record<SoundKind, string> = {
  move: '/sounds/practice/Move.mp3',
  capture: '/sounds/practice/Capture.mp3',
  check: '/sounds/practice/Check.mp3',
  gameStart: '/sounds/practice/NewChallenge.mp3',
  win: '/sounds/practice/Victory.mp3',
  loss: '/sounds/practice/Defeat.mp3',
  draw: '/sounds/practice/Draw.mp3',
  lowTime: '/sounds/practice/LowTime.mp3',
};

// Per-event volume tuning — Victory/Defeat/NewChallenge are noticeably louder
// in the source mix than the move clicks, so we trim them back to keep moves
// audible without making end-of-game blasts.
const VOLUME: Record<SoundKind, number> = {
  move: 0.55,
  capture: 0.6,
  check: 0.6,
  gameStart: 0.45,
  win: 0.5,
  loss: 0.5,
  draw: 0.5,
  lowTime: 0.6,
};

class SoundManager {
  private enabled = true;
  private cache: Partial<Record<SoundKind, HTMLAudioElement>> = {};

  setEnabled(on: boolean) {
    this.enabled = on;
  }

  /** Warm the audio cache so the first move doesn't stall on a network fetch. */
  preload(): void {
    if (typeof window === 'undefined') return;
    for (const kind of Object.keys(FILES) as SoundKind[]) {
      this.ensure(kind);
    }
  }

  private ensure(kind: SoundKind): HTMLAudioElement | null {
    if (typeof window === 'undefined') return null;
    let el = this.cache[kind];
    if (!el) {
      el = new Audio(FILES[kind]);
      el.preload = 'auto';
      el.volume = VOLUME[kind];
      this.cache[kind] = el;
    }
    return el;
  }

  play(kind: SoundKind): void {
    if (!this.enabled) return;
    const base = this.ensure(kind);
    if (!base) return;
    // Clone so overlapping events (e.g. capture+check on the same move) don't
    // cut each other off, and so a still-playing sample doesn't block the next
    // one in fast blitz games.
    const node = base.cloneNode(true) as HTMLAudioElement;
    node.volume = VOLUME[kind];
    const p = node.play();
    if (p && typeof p.catch === 'function') {
      // Browser autoplay policies may reject .play() until the first user
      // gesture; swallow that — the next interaction will succeed.
      p.catch(() => {});
    }
  }
}

export const sounds = new SoundManager();

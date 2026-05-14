/**
 * Lightweight sound manager for the Practice live game. No asset preloading;
 * we use WebAudio oscillators for short blips so the bundle doesn't need
 * extra public files at MVP. Replace with real assets later.
 *
 * Sounds are silenced when the user has soundEnabled = false in their prefs.
 */

type SoundKind = 'move' | 'capture' | 'check' | 'gameStart' | 'gameEnd' | 'lowTime';

class SoundManager {
  private enabled = true;
  private ctx: AudioContext | null = null;

  setEnabled(on: boolean) {
    this.enabled = on;
  }

  private ensureCtx(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
    }
    return this.ctx;
  }

  play(kind: SoundKind): void {
    if (!this.enabled) return;
    const ctx = this.ensureCtx();
    if (!ctx) return;

    if (kind === 'gameStart') {
      // Two-tone "gong" — low pitch into a higher overtone, longer decay than
      // the per-move blips so it stands out when the user is in another tab
      // and matchmaking finally fires.
      this.tone(ctx, 220, 'triangle', 0.32, 0, 0.45);
      this.tone(ctx, 330, 'triangle', 0.28, 0.06, 0.55);
      this.tone(ctx, 440, 'sine', 0.18, 0.12, 0.7);
      return;
    }

    // Tiny synthesised blips — distinct timbres per event.
    const { freq, durMs, type } = {
      move: { freq: 660, durMs: 60, type: 'triangle' as OscillatorType },
      capture: { freq: 380, durMs: 90, type: 'square' as OscillatorType },
      check: { freq: 880, durMs: 110, type: 'sawtooth' as OscillatorType },
      gameEnd: { freq: 260, durMs: 220, type: 'triangle' as OscillatorType },
      lowTime: { freq: 1200, durMs: 50, type: 'sine' as OscillatorType },
    }[kind];

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durMs / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + durMs / 1000 + 0.02);
  }

  private tone(
    ctx: AudioContext,
    freq: number,
    type: OscillatorType,
    peak: number,
    delaySec: number,
    durSec: number,
  ): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    const start = ctx.currentTime + delaySec;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + durSec);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + durSec + 0.02);
  }
}

export const sounds = new SoundManager();

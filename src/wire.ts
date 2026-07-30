/**
 * The wire — TeleWire's signature element.
 *
 * A live trace of the single thing this app exists to do: move bytes from
 * Telegram's data centers onto this disk, with nothing in between. It sits
 * directly under the masthead, spanning the full width, and it is driven by
 * *real* aggregate throughput reported by the Rust download engine — never by
 * a decorative timer. Idle means a flat cyan line, because idle is a true
 * state worth showing, not a reason to invent motion.
 *
 * Why canvas rather than DOM/SVG: this repaints ~60x/sec while several
 * parallel downloads are also pushing progress events across the IPC bridge.
 * A canvas repaint is one composited layer; the equivalent SVG path animation
 * would put continuous layout work on the main thread and make the
 * virtualized file list stutter — exactly the jank §17 forbids.
 */

import { reducedMotion } from "./lib/ui";

/** Pulses travel left→right. Each is a gaussian bump riding the baseline. */
interface Pulse {
  /** 0..1 across the canvas width. */
  x: number;
  /** Height in device-independent px. */
  amp: number;
}

export interface Wire {
  /** Feed real throughput. `bps` is the summed rate across all active jobs. */
  setThroughput(bps: number): void;
  /** Connection state changes the resting colour. */
  setState(state: "offline" | "online" | "transfer"): void;
  destroy(): void;
}

const COLORS = {
  offline: "#6b7f9c",
  online: "#43c6d8",
  transfer: "#f2a93b",
};

/**
 * Throughput is mapped through a log curve: a 200 KB/s trickle and a 40 MB/s
 * torrent differ by 200x linearly, which would either flatten the low end to
 * nothing or peg the high end. Log scaling keeps both legible.
 */
const REF_BPS = 40 * 1024 * 1024;
function intensity(bps: number): number {
  if (bps <= 0) return 0;
  return Math.max(0, Math.min(1, Math.log10(1 + bps / 1024) / Math.log10(1 + REF_BPS / 1024)));
}

export function createWire(canvas: HTMLCanvasElement): Wire {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    // Software-rendered webview with no 2D context: degrade to nothing rather
    // than crashing the app over an ornament.
    return { setThroughput() {}, setState() {}, destroy() {} };
  }

  let width = 0;
  let height = 0;
  let dpr = 1;
  let raf = 0;
  let running = true;

  let state: "offline" | "online" | "transfer" = "offline";
  let target = 0; // intensity we are heading toward
  let level = 0; // smoothed intensity actually drawn
  let sinceEmit = 0;
  let last = performance.now();
  const pulses: Pulse[] = [];

  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  const draw = (now: number) => {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // Ease toward the reported rate so a jittery sample doesn't make the line
    // twitch — the eye reads smoothed motion as "throughput", raw as "noise".
    level += (target - level) * Math.min(1, dt * 4);

    const mid = height / 2;
    const color = COLORS[state];

    ctx.fillStyle = "#070d16";
    ctx.fillRect(0, 0, width, height);

    // Emit pulses at a rate proportional to throughput: more bytes moving =
    // more signal on the wire. This is the whole point of the motif.
    if (level > 0.01) {
      const perSecond = 1 + level * 9;
      sinceEmit += dt;
      while (sinceEmit > 1 / perSecond) {
        sinceEmit -= 1 / perSecond;
        pulses.push({ x: 0, amp: (0.35 + level * 0.65) * (mid - 3) });
      }
    } else {
      sinceEmit = 0;
    }

    const travel = 0.35 + level * 0.55; // fraction of width per second
    for (let i = pulses.length - 1; i >= 0; i--) {
      pulses[i].x += travel * dt;
      if (pulses[i].x > 1.15) pulses.splice(i, 1);
    }

    // Baseline + pulses drawn as one path so the trace reads as a single
    // continuous wire rather than a line with blobs on it.
    ctx.beginPath();
    const step = 2;
    for (let px = 0; px <= width; px += step) {
      const t = px / width;
      let y = mid;
      for (const p of pulses) {
        const d = (t - p.x) * 26; // 26 controls pulse width
        if (d > -4 && d < 4) y -= p.amp * Math.exp(-d * d);
      }
      if (px === 0) ctx.moveTo(px, y);
      else ctx.lineTo(px, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = state === "offline" ? 0.45 : 0.9;
    ctx.stroke();

    // A soft echo underneath gives the trace the glow of a lit instrument
    // without resorting to a blur filter (which would cost a real repaint).
    if (level > 0.02) {
      ctx.globalAlpha = 0.16 * level;
      ctx.lineWidth = 5;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    raf = requestAnimationFrame(draw);
  };

  /** A single static frame, for reduced-motion and for the idle case. */
  const drawStatic = () => {
    const mid = height / 2;
    ctx.fillStyle = "#070d16";
    ctx.fillRect(0, 0, width, height);
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.strokeStyle = COLORS[state];
    ctx.globalAlpha = state === "offline" ? 0.45 : 0.9;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  // Respecting prefers-reduced-motion here means no animation at all — but the
  // wire still shows connection state through colour, so no information is
  // lost, only the movement.
  const still = reducedMotion();
  if (still) drawStatic();
  else raf = requestAnimationFrame(draw);

  // Stop burning frames when the window is hidden; a background download
  // manager shouldn't keep a GPU awake to animate an ornament nobody sees.
  const onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
    } else if (!still && running) {
      last = performance.now();
      raf = requestAnimationFrame(draw);
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  return {
    setThroughput(bps) {
      target = intensity(bps);
      if (still) drawStatic();
    },
    setState(next) {
      state = next;
      if (still) drawStatic();
    },
    destroy() {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}

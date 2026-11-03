// A faint field of ASCII characters drifting behind the app, like a shader
// drawn in text: grey on the paper (light on black in dark mode), densest at
// the top and gone by the middle of the screen, so the cards stay clean.
// Still for people who ask for less motion.

import { useEffect, useRef } from "react";
import { type Theme, useTheme } from "./theme";

/** Lightest to densest; a space leaves the cell empty. */
const RAMP = " .:-=+*#";
const CELL_W = 9;
const CELL_H = 15;
const FONT_PX = 11;
const FPS = 12;
/** How far down the screen the field reaches, as a share of its height; less on a tall phone, where the title sits in it. */
const reach = () => Math.min(0.5, (0.42 * window.innerWidth) / window.innerHeight);

const INK: Record<Theme, { rgb: string; strength: number }> = {
  light: { rgb: "82, 82, 91", strength: 0.24 },
  dark: { rgb: "228, 228, 231", strength: 0.12 },
};

function hash(x: number, y: number) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Smooth value noise, 0 to 1. */
function noise(x: number, y: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number) {
  let sum = 0;
  let amp = 0.5;
  for (let i = 0; i < 3; i++) {
    sum += amp * noise(x, y);
    x = x * 2.03 + 17.1;
    y = y * 2.03 + 9.2;
    amp *= 0.5;
  }
  return sum / 0.875;
}

const smoothstep = (from: number, to: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

/** The characters, pre-drawn once per theme; denser ones are also darker. */
function atlas(theme: Theme, cw: number, ch: number, dpr: number) {
  const canvas = document.createElement("canvas");
  canvas.width = cw * RAMP.length;
  canvas.height = ch;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${FONT_PX * dpr}px "Geist Mono Variable", ui-monospace, Menlo, Consolas, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const { rgb, strength } = INK[theme];
  for (let i = 1; i < RAMP.length; i++) {
    ctx.fillStyle = `rgba(${rgb}, ${strength * (0.35 + (0.65 * i) / (RAMP.length - 1))})`;
    ctx.fillText(RAMP[i]!, i * cw + cw / 2, ch / 2);
  }
  return canvas;
}

export function AsciiField() {
  const ref = useRef<HTMLCanvasElement>(null);
  const theme = useTheme();

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let glyphs: HTMLCanvasElement | null = null;
    let cw = 0;
    let ch = 0;
    let cols = 0;
    let rows = 0;
    let height = 1;
    let extent = 0.5;

    const size = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cw = Math.round(CELL_W * dpr);
      ch = Math.round(CELL_H * dpr);
      canvas.width = Math.ceil(window.innerWidth * dpr);
      canvas.height = Math.ceil(window.innerHeight * dpr);
      height = canvas.height;
      extent = reach();
      cols = Math.ceil(canvas.width / cw);
      rows = Math.ceil((canvas.height * extent) / ch);
      glyphs = atlas(theme, cw, ch, dpr);
    };

    const draw = (t: number) => {
      if (!glyphs) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // About 2.6 noise cells per screen height, whatever the screen.
      const scale = 2.6 / height;
      for (let row = 0; row < rows; row++) {
        const y = row * ch;
        const fade = 1 - smoothstep(0.02, extent, y / height);
        for (let col = 0; col < cols; col++) {
          const fx = col * cw * scale;
          const fy = y * scale;
          const wx = fbm(fx + t * 0.05, fy);
          const wy = fbm(fx + 5.2, fy - t * 0.04);
          const n = fbm(fx * 1.1 + wx * 1.5 + t * 0.02, fy * 1.1 + wy * 1.5);
          const value = Math.min(1, Math.max(0, (n - 0.43) * 3.2)) * fade;
          const index = Math.min(RAMP.length - 1, Math.floor(value * RAMP.length));
          if (index > 0) ctx.drawImage(glyphs, index * cw, 0, cw, ch, col * cw, y, cw, ch);
        }
      }
    };

    let frame = 0;
    let last = 0;
    const began = performance.now();
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - last < 1000 / FPS) return;
      last = now;
      draw((now - began) / 1000);
    };
    const onResize = () => {
      size();
      if (still) draw(0);
    };

    // The characters need the mono font; draw with a fallback if it's slow.
    let cancelled = false;
    void Promise.race([document.fonts.load(`${FONT_PX}px "Geist Mono Variable"`), new Promise((done) => setTimeout(done, 1_500))]).then(() => {
      if (cancelled) return;
      size();
      if (still) draw(0);
      else frame = requestAnimationFrame(tick);
    });
    window.addEventListener("resize", onResize);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, [theme]);

  return <canvas ref={ref} aria-hidden className="pointer-events-none fixed inset-0 -z-10 size-full" />;
}

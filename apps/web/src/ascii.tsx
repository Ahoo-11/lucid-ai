// A faint field of ASCII characters drifting behind the app, like a shader
// drawn in text: grey on the paper (light on black in dark mode), densest at
// the top and gone by the middle of the screen, so the cards stay clean.
// Still for people who ask for less motion. AsciiPicture, further down, draws
// pictures through the same filter.

import { useEffect, useRef } from "react";
import { type Theme, useTheme } from "./theme";
import { cx } from "./ui";

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

/**
 * `theme`: for a page with its own colours (the landing page is always white); otherwise it follows the app.
 * `scrolls`: the field belongs to the top of the page and scrolls away with it, rather than staying behind
 * every section (the landing page, where section titles would otherwise sit in it).
 */
export function AsciiField({ theme: fixed, scrolls }: { theme?: Theme; scrolls?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const current = useTheme();
  const theme = fixed ?? current;

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

  return <canvas ref={ref} aria-hidden className={cx("pointer-events-none -z-10", scrolls ? "absolute inset-x-0 top-0 h-svh w-full" : "fixed inset-0 size-full")} />;
}

/** For pictures: a slightly heavier ramp, so dark and saturated parts read as dense type. */
const PICTURE_RAMP = " .:-=+*#%";

/** One image in a picture: a URL, or an SVG's markup (from `?raw`), and where it goes in the picture's own units. */
export type PictureLayer = { src: string; box: [left: number, top: number, width: number, height: number] };

/** SVG markup becomes an image at a size worth drawing; the files say 1em. */
function imageUrl(src: string, width: number, height: number) {
  if (!src.trimStart().startsWith("<svg")) return src;
  const sized = src.replace(/\swidth="[^"]*"/, ` width="${Math.round(width)}"`).replace(/\sheight="[^"]*"/, ` height="${Math.round(height)}"`);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
}

function load(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * Pictures through the ASCII filter, at low power: the images stay, softened,
 * and every cell gets a character in that cell's own colour, so the agents
 * keep the faces people know them by. The layers are drawn as one scene, so
 * the type lines up across them. On a dark page (`on="dark"`) the black parts
 * are drawn in light grey type instead, or they'd vanish into the page.
 * `strength` 0 is the plain picture, 1 is type only. The characters type
 * themselves in once, then it holds still.
 */
export function AsciiPicture({
  layers,
  size,
  alt,
  on = "light",
  strength = 0.5,
  cell = 6,
  className,
}: {
  layers: PictureLayer[];
  size: [width: number, height: number];
  alt: string;
  on?: "light" | "dark";
  strength?: number;
  cell?: number;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [width, height] = size;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dark = on === "dark";
    let images: HTMLImageElement[] = [];
    const scene = document.createElement("canvas");
    let cells: Uint8ClampedArray | null = null;
    let cols = 0;
    let rows = 0;
    let cw = 0;
    let ch = 0;
    let font = "";

    const size = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = scene.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = scene.height = Math.round(canvas.clientHeight * dpr);
      const scale = canvas.width / width;
      const sctx = scene.getContext("2d")!;
      sctx.clearRect(0, 0, scene.width, scene.height);
      layers.forEach((layer, i) => {
        const [left, top, w, h] = layer.box;
        sctx.drawImage(images[i]!, left * scale, top * scale, w * scale, h * scale);
      });
      // Finer type on a small picture, so it stays a texture rather than taking over.
      const unit = Math.max(3.5, Math.min(cell, canvas.clientWidth / 140));
      cw = unit * dpr;
      ch = unit * 1.6 * dpr;
      cols = Math.ceil(canvas.width / cw);
      rows = Math.ceil(canvas.height / ch);
      // One pixel per cell: the browser averages each cell's colour while it scales down.
      const small = document.createElement("canvas");
      small.width = cols;
      small.height = rows;
      const mctx = small.getContext("2d")!;
      mctx.imageSmoothingQuality = "high";
      mctx.drawImage(scene, 0, 0, cols, rows);
      cells = mctx.getImageData(0, 0, cols, rows).data;
      font = `${unit * 1.5 * dpr}px "Geist Mono Variable", ui-monospace, Menlo, Consolas, monospace`;
    };

    /** `shown`: how far the characters have typed in, 0 to 1. */
    const draw = (shown: number) => {
      if (!cells) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = (1 - 0.75 * strength) * Math.min(1, shown * 1.5);
      ctx.drawImage(scene, 0, 0);
      ctx.globalAlpha = 1;
      ctx.font = font;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const alpha = 0.3 + 0.7 * strength;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          if (shown < 1 && hash(col, row) > shown) continue;
          const i = (row * cols + col) * 4;
          const a = cells[i + 3]! / 255;
          // Cells the picture only half covers would float type past its edge.
          if (a < 0.5) continue;
          let r = cells[i]!;
          let g = cells[i + 1]!;
          let b = cells[i + 2]!;
          const light = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          const vivid = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
          let ink: number;
          if (dark) {
            // Bright and colourful parts in dense type; black parts sparse, in grey.
            ink = a * Math.max(0.5, light * 0.9, vivid);
            const lift = Math.max(0, (0.35 - light) / 0.35) * 0.9;
            r += (176 - r) * lift;
            g += (176 - g) * lift;
            b += (184 - b) * lift;
          } else {
            ink = a * Math.max(1 - light, vivid * 0.9);
            // A shade darker than the picture under it, so the type shows on its own colour.
            r *= 0.8;
            g *= 0.8;
            b *= 0.8;
          }
          const index = Math.round(ink * (PICTURE_RAMP.length - 1));
          if (!index) continue;
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
          ctx.fillText(PICTURE_RAMP[index]!, col * cw + cw / 2, row * ch + ch / 2);
        }
      }
    };

    let frame = 0;
    const typeIn = () => {
      const began = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - began) / 1_100);
        draw(1 - (1 - t) ** 3);
        if (t < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };

    let ready = false;
    let cancelled = false;
    const observer = new ResizeObserver(() => {
      if (!ready) return;
      size();
      draw(1);
    });
    // Drawn big enough for a 2x screen at the widest the picture gets.
    const sharp = 2_000 / width;
    void Promise.all([
      Promise.all(layers.map((layer) => load(imageUrl(layer.src, layer.box[2] * sharp, layer.box[3] * sharp)))),
      Promise.race([document.fonts.load(`${cell * 1.5}px "Geist Mono Variable"`), new Promise((done) => setTimeout(done, 1_500))]),
    ]).then(([loaded]) => {
      if (cancelled) return;
      images = loaded;
      ready = true;
      size();
      if (still) draw(1);
      else typeIn();
    });
    observer.observe(canvas);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [layers, width, on, strength, cell]);

  return <canvas ref={ref} role="img" aria-label={alt} className={className} style={{ display: "block", width: "100%", aspectRatio: `${width} / ${height}` }} />;
}

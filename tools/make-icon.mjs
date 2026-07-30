/**
 * Generates the TeleWire app icon as a 1024x1024 PNG, with no image
 * dependencies — Node's zlib plus a hand-rolled PNG chunk writer.
 *
 * Why generate rather than commit a binary: the mark is the same signal glyph
 * the UI uses (icons.ts `wire`), so it should be derived from the same path
 * data rather than drifting from it. Re-run after changing the glyph:
 *
 *     node tools/make-icon.mjs && npx tauri icon src-tauri/app-icon.png
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SIZE = 1024;
const OUT = "src-tauri/app-icon.png";

/* ---------- palette (must match styles.css tokens) ---------------------- */
const INK = [0x0b, 0x12, 0x20];
const INK_EDGE = [0x16, 0x23, 0x3a];
const AMBER = [0xf2, 0xa9, 0x3b];
const CYAN = [0x43, 0xc6, 0xd8];

/* ---------- geometry ----------------------------------------------------- */

// The `wire` glyph from icons.ts: M2 12 h5 l3-7 l4 14 l3-7 h5, in a 24-unit box.
const GLYPH = [
  [2, 12], [7, 12], [10, 5], [14, 19], [17, 12], [22, 12],
];

const scale = SIZE / 24;
const pad = 0; // the glyph already sits inside a 24-unit box with margin
const pts = GLYPH.map(([x, y]) => [x * scale + pad, y * scale + pad]);

/** Distance from point p to segment ab. */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function distToPolyline(px, py) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distToSegment(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    if (d < best) best = d;
  }
  return best;
}

/** Signed distance to a rounded rectangle, negative inside. */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

const smooth = (edge, d) => Math.max(0, Math.min(1, 0.5 - d / edge));

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/* ---------- render ------------------------------------------------------- */

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
const strokeHalf = SIZE * 0.038;
const radius = SIZE * 0.22;
const cx = SIZE / 2;
const cy = SIZE / 2;
const half = SIZE / 2 - SIZE * 0.02;

for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // PNG filter type 0 (None) for every scanline
  for (let x = 0; x < SIZE; x++) {
    const px = x + 0.5;
    const py = y + 0.5;

    // Body: rounded square, subtly lighter toward the top so it reads as a lit
    // instrument face rather than a flat tile.
    const bodyD = sdRoundRect(px, py, cx, cy, half, half, radius);
    const bodyA = smooth(2, bodyD);
    const vert = y / SIZE;
    let rgb = mix(INK_EDGE, INK, Math.min(1, vert * 1.25));

    // Glyph: amber core with a cyan halo, the app's two signal colours.
    const gd = distToPolyline(px, py);
    const halo = smooth(SIZE * 0.05, gd - strokeHalf - SIZE * 0.022);
    if (halo > 0) rgb = mix(rgb, CYAN, halo * 0.18);
    const core = smooth(2.5, gd - strokeHalf);
    if (core > 0) rgb = mix(rgb, AMBER, core);

    const o = rowStart + 1 + x * 4;
    raw[o] = rgb[0];
    raw[o + 1] = rgb[1];
    raw[o + 2] = rgb[2];
    raw[o + 3] = Math.round(bodyA * 255);
  }
}

/* ---------- PNG container ------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KB)`);

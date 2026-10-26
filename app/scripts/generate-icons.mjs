#!/usr/bin/env node
// Generates the PWA icons in app/public/icons from the same drawing routine.
//
// Everything here is dependency-free and deterministic: the PNG container is
// assembled by hand (node:zlib only) and the artwork is pure math, so running
// this script twice produces byte-identical files. No network, no assets.
//
// Artwork: a minimal two-turn spiral ("🌀" is the app's wordmark) in slate-100
// on the app's outer background (#020617), with a rose accent dot at the
// centre where the spiral starts. The maskable variant is the same drawing
// scaled down so every pixel of ink stays inside the inner ~80% safe circle.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT_DIR = fileURLToPath(new URL('../public/icons/', import.meta.url));

// ── palette (matches the Tailwind shell) ──────────────────────────────
const BACKGROUND = [0x02, 0x06, 0x17]; // slate-950 outer background
const SWIRL = [0xe2, 0xe8, 0xf0]; // slate-100
const ACCENT = [0xf4, 0x3f, 0x5e]; // rose-500 (attack badge accent)

// ── artwork ───────────────────────────────────────────────────────────
const TURNS = 1.75;
const THETA_MAX = TURNS * 2 * Math.PI;
const RADIUS_INNER = 0.1;
const RADIUS_OUTER = 0.335;
const STROKE_HALF_WIDTH = 0.03;
const DOT_RADIUS = 0.06;

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Radius of the spiral centreline at angle theta (radians). */
function spiralRadius(theta) {
  const s = theta / THETA_MAX;
  return RADIUS_INNER + (RADIUS_OUTER - RADIUS_INNER) * Math.pow(s, 0.9);
}

/** Rate of change of the spiral radius with respect to theta. */
function spiralSlope(theta) {
  const s = theta / THETA_MAX;
  return (((RADIUS_OUTER - RADIUS_INNER) * 0.9) / THETA_MAX) * Math.pow(s, -0.1);
}

/** Stroke narrows to a point at both ends (short taper, no blunt caps). */
function strokeTaper(theta) {
  const s = theta / THETA_MAX;
  const f = Math.min(s, 1 - s) / 0.08;
  if (f <= 0) return 0;
  return f >= 1 ? 1 : f * f * (3 - 2 * f);
}

/** Coverage (0..1) of the spiral stroke at normalised point (u, v). */
function spiralCoverage(u, v, scale, aa) {
  const r = Math.hypot(u, v);
  if (r > RADIUS_OUTER * scale + STROKE_HALF_WIDTH * scale + aa) return 0;
  if (r < 1e-6) return 0;

  // Start the spiral at the top and wind clockwise, like the 🌀 glyph.
  let phi = Math.atan2(v, u) + Math.PI / 2;
  if (phi < 0) phi += 2 * Math.PI;
  let best = 0;
  for (let k = 0; k <= 2; k += 1) {
    const theta = phi + 2 * Math.PI * k;
    if (theta > THETA_MAX) break;

    const halfWidth = STROKE_HALF_WIDTH * scale * strokeTaper(theta);
    if (halfWidth <= 0) continue;

    const centre = spiralRadius(theta) * scale;
    // The curve is mostly tangential, so radial offset scaled by the angle
    // between the radius and the curve normal approximates perpendicular
    // distance closely (and exactly at the endpoints of each winding).
    const slope = spiralSlope(theta) * scale;
    const perpendicular = (Math.abs(r - centre) * centre) / Math.hypot(centre, slope);
    best = Math.max(best, 1 - smoothstep(halfWidth - aa, halfWidth + aa, perpendicular));
  }
  return best;
}

function dotCoverage(u, v, scale, aa) {
  const radius = DOT_RADIUS * scale;
  return 1 - smoothstep(radius - aa, radius + aa, Math.hypot(u, v));
}

function blend(pixel, offset, colour, coverage) {
  if (coverage <= 0) return;
  const a = Math.min(1, coverage);
  for (let c = 0; c < 3; c += 1) {
    pixel[offset + c] = Math.round(pixel[offset + c] * (1 - a) + colour[c] * a);
  }
  pixel[offset + 3] = 255;
}

/** Renders one square RGBA icon into a Uint8Array (row-major, 4 bytes/px). */
function renderIcon(size, scale) {
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    const o = i * 4;
    pixels[o] = BACKGROUND[0];
    pixels[o + 1] = BACKGROUND[1];
    pixels[o + 2] = BACKGROUND[2];
    pixels[o + 3] = 255;
  }

  const aa = 1.2 / size; // ~1px soft edge, in normalised units
  for (let y = 0; y < size; y += 1) {
    const v = (y + 0.5) / size - 0.5;
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size - 0.5;
      const o = (y * size + x) * 4;
      blend(pixels, o, SWIRL, spiralCoverage(u, v, scale, aa));
      blend(pixels, o, ACCENT, dotCoverage(u, v, scale, aa));
    }
  }
  return pixels;
}

// ── PNG writer ────────────────────────────────────────────────────────
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Each scanline is prefixed with filter type 0 (none).
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── output ────────────────────────────────────────────────────────────
const ICONS = [
  { file: 'icon-192.png', size: 192, artScale: 1 },
  { file: 'icon-512.png', size: 512, artScale: 1 },
  // Maskable: identical drawing pulled into the inner safe circle so launchers
  // can crop to a circle/squircle without clipping the motif.
  { file: 'icon-maskable-512.png', size: 512, artScale: 0.78 },
];

mkdirSync(OUT_DIR, { recursive: true });
for (const { file, size, artScale } of ICONS) {
  const png = encodePng(size, renderIcon(size, artScale));
  writeFileSync(join(OUT_DIR, file), png);
  console.log(`wrote public/icons/${file} (${size}x${size}, ${png.length} bytes)`);
}

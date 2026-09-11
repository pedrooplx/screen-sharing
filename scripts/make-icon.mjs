// @ts-nocheck -- build-time asset generator, run via `node scripts/make-icon.mjs`
/**
 * Generates build/icon.ico (Windows app icon) from scratch - no image
 * dependencies. Draws a simple "monitor" glyph on the app's accent color
 * (see src/renderer/src/styles.css --accent/--bg), supersampled 4x and
 * box-filtered down per size for clean edges, hand-encodes each size as PNG,
 * and packs them into one multi-resolution .ico (PNG-compressed entries,
 * supported since Windows Vista).
 *
 * Re-run this whenever the icon design changes; it's checked in as source,
 * not generated at build time, so `npm run build:win` doesn't need it.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ACCENT = [0x5b, 0x8c, 0xff];
const WHITE = [0xff, 0xff, 0xff];
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SUPERSAMPLE = 4;

// --- geometry --------------------------------------------------------

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** Renders the icon at `size` (supersampled internally), returns RGBA bytes. */
function renderIcon(size) {
  const S = size * SUPERSAMPLE;
  // premultiplied-alpha accumulator at supersample resolution
  const big = new Float64Array(S * S * 4);

  const paint = (testFn, color) => {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        if (!testFn(x, y)) continue;
        const i = (y * S + x) * 4;
        big[i] = color[0];
        big[i + 1] = color[1];
        big[i + 2] = color[2];
        big[i + 3] = 255;
      }
    }
  };

  // background: rounded square
  paint((x, y) => inRoundedRect(x, y, 0, 0, S, S, S * 0.22), ACCENT);

  // monitor screen: stroked rounded rect
  const ox0 = S * 0.2,
    oy0 = S * 0.2,
    ox1 = S * 0.8,
    oy1 = S * 0.62,
    outerR = S * 0.07,
    sw = S * 0.078;
  paint(
    (x, y) =>
      inRoundedRect(x, y, ox0, oy0, ox1, oy1, outerR) &&
      !inRoundedRect(x, y, ox0 + sw, oy0 + sw, ox1 - sw, oy1 - sw, Math.max(1, outerR - sw)),
    WHITE,
  );

  // stand neck + foot
  paint((x, y) => inRoundedRect(x, y, S * 0.45, S * 0.62, S * 0.55, S * 0.71, S * 0.015), WHITE);
  paint((x, y) => inRoundedRect(x, y, S * 0.32, S * 0.71, S * 0.68, S * 0.78, S * 0.02), WHITE);

  // downsample SUPERSAMPLE x SUPERSAMPLE -> size x size, alpha-correct
  const out = new Uint8ClampedArray(size * size * 4);
  const n = SUPERSAMPLE * SUPERSAMPLE;
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let dy = 0; dy < SUPERSAMPLE; dy++) {
        for (let dx = 0; dx < SUPERSAMPLE; dx++) {
          const i = ((oy * SUPERSAMPLE + dy) * S + (ox * SUPERSAMPLE + dx)) * 4;
          r += big[i];
          g += big[i + 1];
          b += big[i + 2];
          a += big[i + 3];
        }
      }
      const outA = a / n;
      const oi = (oy * size + ox) * 4;
      out[oi] = outA > 0 ? r / n / (outA / 255) : 0;
      out[oi + 1] = outA > 0 ? g / n / (outA / 255) : 0;
      out[oi + 2] = outA > 0 ? b / n / (outA / 255) : 0;
      out[oi + 3] = outA;
    }
  }
  return out;
}

// --- PNG encoding (RGBA8, filter-none) --------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw);

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// --- ICO packing (PNG-compressed entries, Vista+) ---------------------

function packICO(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const entries = [];
  const datas = [];
  let offset = 6 + 16 * count;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    datas.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...datas]);
}

// --- main --------------------------------------------------------------

const images = SIZES.map((size) => ({ size, png: encodePNG(size, renderIcon(size)) }));
const ico = packICO(images);

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = join(here, '..', 'build');
mkdirSync(buildDir, { recursive: true });
writeFileSync(join(buildDir, 'icon.ico'), ico);
writeFileSync(join(buildDir, 'icon.png'), images.at(-1).png); // 256px, for Linux/tray use later

console.log(`wrote build/icon.ico (${SIZES.join(', ')}px) and build/icon.png`);

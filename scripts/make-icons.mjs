// Draws the app icon source (app-icon.png, 1024x1024) and the macOS menu bar template icon
// (src-tauri/icons/tray-template.png) from simple shapes, so the artwork can be rebuilt and tweaked here.
// The mark: two session cards on Claude orange, the front one with a terminal prompt.
//
//   node scripts/make-icons.mjs        then        pnpm tauri icon app-icon.png
//
// (`tauri icon` also writes android/ and ios/ folders; this desktop app does not ship them, delete them.)

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- PNG (RGBA, 8 bit) ----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- shapes as signed distance functions (negative inside), in design units ----

function roundedBox(cx, cy, hw, hh, r) {
  return (x, y) => {
    const qx = Math.abs(x - cx) - hw + r;
    const qy = Math.abs(y - cy) - hh + r;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  };
}

function polyline(points, width) {
  return (x, y) => {
    let d = Infinity;
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      const px = x - ax;
      const py = y - ay;
      const ex = bx - ax;
      const ey = by - ay;
      const t = Math.max(0, Math.min(1, (px * ex + py * ey) / (ex * ex + ey * ey)));
      d = Math.min(d, Math.hypot(px - ex * t, py - ey * t));
    }
    return d - width / 2;
  };
}

function outline(shape, width) {
  return (x, y) => Math.abs(shape(x, y)) - width / 2;
}

/**
 * Renders layers ({ shape, color: [r,g,b,a] | (x,y) => [r,g,b,a] }) drawn in a `design`-unit square
 * into a `size` pixel square, with anti-aliased edges, compositing each layer over the ones below.
 */
export function render(size, design, layers) {
  const scale = design / size;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) * scale;
      const y = (py + 0.5) * scale;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const layer of layers) {
        // distance in pixels: half a pixel either side of the edge is blended
        const cover = Math.max(0, Math.min(1, 0.5 - layer.shape(x, y) / scale));
        if (cover === 0) continue;
        const [lr, lg, lb, la] = typeof layer.color === "function" ? layer.color(x, y) : layer.color;
        const sa = la * cover;
        const na = sa + a * (1 - sa);
        r = (lr * sa + r * a * (1 - sa)) / na;
        g = (lg * sa + g * a * (1 - sa)) / na;
        b = (lb * sa + b * a * (1 - sa)) / na;
        a = na;
      }
      const i = (py * size + px) * 4;
      out[i] = Math.round(r);
      out[i + 1] = Math.round(g);
      out[i + 2] = Math.round(b);
      out[i + 3] = Math.round(a * 255);
    }
  }
  return out;
}

// ---- the artwork ----

const TOP = [227, 137, 106];
const BOTTOM = [196, 94, 62];
const INK = [196, 94, 62, 1];
const WHITE = [255, 255, 255, 1];

/** App icon, 1024 design units: macOS-style rounded square, two cards, a prompt. */
export function appIconLayers() {
  const gradient = (_x, y) => {
    const t = Math.max(0, Math.min(1, (y - 80) / 864));
    return [...TOP.map((c, i) => c + (BOTTOM[i] - c) * t), 1];
  };
  return [
    { shape: roundedBox(512, 512, 432, 432, 194), color: gradient },
    { shape: roundedBox(566, 414, 240, 170, 52), color: [255, 255, 255, 0.45] },
    { shape: roundedBox(468, 572, 272, 196, 60), color: WHITE },
    {
      shape: polyline(
        [
          [340, 498],
          [430, 572],
          [340, 646],
        ],
        46,
      ),
      color: INK,
    },
    {
      shape: polyline(
        [
          [478, 646],
          [600, 646],
        ],
        46,
      ),
      color: INK,
    },
  ];
}

/** Menu bar template icon, 44 design units (22 pt at 2x): black with alpha, macOS tints it. */
export function trayLayers() {
  const black = [0, 0, 0, 1];
  return [
    { shape: outline(roundedBox(22, 22, 17, 13.5, 4), 3.2), color: black },
    {
      shape: polyline(
        [
          [13.5, 16.5],
          [19, 22],
          [13.5, 27.5],
        ],
        3.2,
      ),
      color: black,
    },
    {
      shape: polyline(
        [
          [23, 27.5],
          [30, 27.5],
        ],
        3.2,
      ),
      color: black,
    },
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(join(root, "app-icon.png"), encodePng(1024, render(1024, 1024, appIconLayers())));
  writeFileSync(join(root, "src-tauri/icons/tray-template.png"), encodePng(44, render(44, 44, trayLayers())));
  console.log("wrote app-icon.png and src-tauri/icons/tray-template.png");
}

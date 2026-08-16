// Marketplace 用のアイコン（PNG）を `media/icon.svg` から作る。
//
//   node scripts/buildIcon.mjs
//
// **Marketplace はPNGしか受け付けない。** アクティビティバーのアイコンは
// SVGでよい（VS Codeが1色に塗り直す）が、拡張機能の顔として出るほうは
// 128px以上のPNGが要る。
//
// **SVGを手で描き直さない。** 2つの絵がずれると、同じ拡張機能なのに
// 場所によって違う絵が出る。**同じSVGから起こす。**
//
// SVGを描く道具は入れていないので、この絵が使っている範囲
// （`M/L/H/V/A/Z` と `translate`・`rotate`、`fill-rule="evenodd"`）だけを
// 自前で塗る。凝った絵にするならライブラリを入れること。
import fs from "node:fs";
import path from "path";
import zlib from "node:zlib";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SVG = path.join(root, "media", "icon.svg");
const OUT = path.join(root, "media", "icon.png");

/** 出す大きさ。Marketplace の下限は128px */
const SIZE = 256;
/** 塗りの粗さを消すための重ね取り（1辺あたり） */
const SAMPLES = 4;
/** 元のSVGの座標系 */
const VIEWBOX = 24;

// 背景を付ける。透明のままだと、明るい配色でも暗い配色でも沈む
const BACKGROUND = [0x22, 0x27, 0x33];
const FOREGROUND = [0xf2, 0xf4, 0xf8];
/** 絵の周りの余白（元の座標系での大きさ） */
const PADDING = 2.2;

// ── SVGから、塗る形（多角形の並び）を取り出す ───────────────

const svg = fs.readFileSync(SVG, "utf-8");

/** `d="..."` と、掛かっている変形をすべて集める */
function collectPaths(text) {
  const out = [];
  // `<g transform="...">` の中と外を分けて見る
  const groups = [...text.matchAll(/<g\s+transform="([^"]+)"\s*>([\s\S]*?)<\/g>/g)];
  let rest = text;
  for (const group of groups) {
    rest = rest.replace(group[0], "");
    for (const d of pathData(group[2])) out.push({ d, transform: group[1] });
  }
  for (const d of pathData(rest)) out.push({ d, transform: null });
  return out;
}

function pathData(text) {
  return [...text.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
}

/** `translate(x y) rotate(deg)` を行列にする */
function parseTransform(spec) {
  let matrix = [1, 0, 0, 1, 0, 0];
  if (!spec) return matrix;
  for (const part of spec.matchAll(/(translate|rotate)\(([^)]+)\)/g)) {
    const args = part[2].trim().split(/[\s,]+/).map(Number);
    const next =
      part[1] === "translate"
        ? [1, 0, 0, 1, args[0], args[1] ?? 0]
        : rotation(args[0]);
    matrix = multiply(matrix, next);
  }
  return matrix;
}

function rotation(degrees) {
  const rad = (degrees * Math.PI) / 180;
  return [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];
}

function multiply(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function apply(matrix, x, y) {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5],
  ];
}

/**
 * `d` を多角形の並びにする。
 *
 * 円弧（A）は、この絵では角の丸めにしか使っていないので、
 * 中心角を等分した折れ線で置き換える。
 */
function toPolygons(d, matrix) {
  const tokens = d.match(/[MmLlHhVvAaZz]|-?[\d.]+(?:e-?\d+)?/g) ?? [];
  const polygons = [];
  let current = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let command = "";
  let index = 0;

  const push = () => {
    const [px, py] = apply(matrix, x, y);
    current.push([px, py]);
  };
  const close = () => {
    if (current.length > 2) polygons.push(current);
    current = [];
  };
  const number = () => Number(tokens[index++]);

  while (index < tokens.length) {
    const token = tokens[index];
    if (/[MmLlHhVvAaZz]/.test(token)) {
      command = token;
      index++;
    }

    if (command === "M" || command === "m") {
      close();
      const nx = number();
      const ny = number();
      x = command === "M" ? nx : x + nx;
      y = command === "M" ? ny : y + ny;
      startX = x;
      startY = y;
      push();
      // 続けて座標が並べば、以降は L として扱う（SVGの決まり）
      command = command === "M" ? "L" : "l";
      continue;
    }
    if (command === "L" || command === "l") {
      const nx = number();
      const ny = number();
      x = command === "L" ? nx : x + nx;
      y = command === "L" ? ny : y + ny;
      push();
      continue;
    }
    if (command === "H" || command === "h") {
      const nx = number();
      x = command === "H" ? nx : x + nx;
      push();
      continue;
    }
    if (command === "V" || command === "v") {
      const ny = number();
      y = command === "V" ? ny : y + ny;
      push();
      continue;
    }
    if (command === "A" || command === "a") {
      const rx = number();
      const ry = number();
      number(); // x軸の回転。この絵では0
      const largeArc = number();
      const sweep = number();
      const ex0 = number();
      const ey0 = number();
      const ex = command === "A" ? ex0 : x + ex0;
      const ey = command === "A" ? ey0 : y + ey0;
      for (const [ax, ay] of arcPoints(x, y, ex, ey, rx, ry, largeArc, sweep)) {
        x = ax;
        y = ay;
        push();
      }
      x = ex;
      y = ey;
      push();
      continue;
    }
    if (command === "Z" || command === "z") {
      x = startX;
      y = startY;
      close();
      continue;
    }
    // 知らない命令は打ち切る。黙って変な形を出すより気づけるほうがよい
    throw new Error(`未対応の命令: ${command}`);
  }
  close();
  return polygons;
}

/** 円弧を折れ線にする（SVGの実装ノートの方式） */
function arcPoints(x1, y1, x2, y2, rx, ry, largeArc, sweep) {
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  let rxs = rx * rx;
  let rys = ry * ry;
  const px = dx2 * dx2;
  const py = dy2 * dy2;
  const check = px / rxs + py / rys;
  if (check > 1) {
    rx *= Math.sqrt(check);
    ry *= Math.sqrt(check);
    rxs = rx * rx;
    rys = ry * ry;
  }
  const sign = largeArc === sweep ? -1 : 1;
  const denominator = rxs * py + rys * px;
  const factor =
    denominator === 0
      ? 0
      : sign * Math.sqrt(Math.max(0, (rxs * rys - denominator) / denominator));
  const cxp = (factor * rx * dy2) / ry;
  const cyp = (-factor * ry * dx2) / rx;
  const cx = cxp + (x1 + x2) / 2;
  const cy = cyp + (y1 + y2) / 2;

  const angle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const value = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    return ux * vy - uy * vx < 0 ? -value : value;
  };
  const start = angle(1, 0, (dx2 - cxp) / rx, (dy2 - cyp) / ry);
  let sweepAngle = angle(
    (dx2 - cxp) / rx,
    (dy2 - cyp) / ry,
    (-dx2 - cxp) / rx,
    (-dy2 - cyp) / ry
  );
  if (!sweep && sweepAngle > 0) sweepAngle -= 2 * Math.PI;
  if (sweep && sweepAngle < 0) sweepAngle += 2 * Math.PI;

  const steps = Math.max(4, Math.ceil(Math.abs(sweepAngle) / (Math.PI / 16)));
  const points = [];
  for (let i = 1; i < steps; i++) {
    const theta = start + (sweepAngle * i) / steps;
    points.push([cx + rx * Math.cos(theta), cy + ry * Math.sin(theta)]);
  }
  return points;
}

// ── 塗る ─────────────────────────────────────────────

const polygons = [];
for (const entry of collectPaths(svg)) {
  polygons.push(...toPolygons(entry.d, parseTransform(entry.transform)));
}
if (polygons.length === 0) throw new Error("形が1つも取れませんでした");

/** 元の座標を、余白を入れた出力の座標へ移す */
const scale = SIZE / (VIEWBOX + PADDING * 2);
const toPixel = ([x, y]) => [(x + PADDING) * scale, (y + PADDING) * scale];
const shapes = polygons.map((polygon) => polygon.map(toPixel));

/** 偶奇規則で、その点が塗りの中かを見る */
function inside(px, py) {
  let crossings = 0;
  for (const polygon of shapes) {
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i];
      const [xj, yj] = polygon[j];
      if (yi > py !== yj > py) {
        const at = ((xj - xi) * (py - yi)) / (yj - yi) + xi;
        if (px < at) crossings++;
      }
    }
  }
  return crossings % 2 === 1;
}

const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let hits = 0;
    for (let sy = 0; sy < SAMPLES; sy++) {
      for (let sx = 0; sx < SAMPLES; sx++) {
        const px = x + (sx + 0.5) / SAMPLES;
        const py = y + (sy + 0.5) / SAMPLES;
        if (inside(px, py)) hits++;
      }
    }
    const ratio = hits / (SAMPLES * SAMPLES);
    const at = (y * SIZE + x) * 4;
    for (let channel = 0; channel < 3; channel++) {
      pixels[at + channel] = Math.round(
        BACKGROUND[channel] * (1 - ratio) + FOREGROUND[channel] * ratio
      );
    }
    pixels[at + 3] = 255;
  }
}

// ── PNGにする ────────────────────────────────────────

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, check]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // 1色あたり8ビット
header[9] = 6; // RGBA
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // 行のフィルタは無し
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

fs.writeFileSync(
  OUT,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
);

console.log(
  `${path.relative(root, OUT)} を作りました（${SIZE}×${SIZE}px / ` +
    `${(fs.statSync(OUT).size / 1024).toFixed(1)}KB）`
);

import type { DecodedPng } from "./pngDecode";

/**
 * 焼いた表紙の、題名の墨を測る（実機確認リスト 5488 を機械で言うため。2026-10-15）。
 *
 * 0.107.1 で直した不具合は「題名の字が1字ずつ90度横倒しに焼ける」だった。画面の自動テスト
 * （`test/e2e/epubCoverTitleUpright.test.ts`）は題名を「一」にして、**墨の外接矩形が横長か**で
 * 言い切っている。ここはその物差しを、任意の題名・任意の範囲で使える形にしたもの。
 *
 * - 墨は**題名の色に近い画素**（色ごとの差が許容差以内）。焼いた絵の上で、色だけで拾う
 * - 範囲（region）を渡せば、その中だけを見る。作者名など同じ色の文字を拾わないため。
 *   `run.request` の coverBake の結果にある `titleBlock` をそのまま渡せばよい
 * - 字ごとの矩形は、**字の並ぶ向きへの投影の空き**で割り、1字の大きさ（cellSize）より
 *   小さいまとまりはつなぐ（「二」「い」のように1字の中に空きがある字を2字に数えない）
 *
 * **「立っているか」は、形で決まる字だけで言う。** 「一」「_」は立っていれば必ず横長になる
 * ——ほかの字は、正方形に近い字も縦長の字もあり、縦横比だけでは向きを言えない。そういう
 * 題名では数字だけを返し、判定は `unknown` にする（言えないことを言わない）。
 *
 * AIを呼ばない。本文を読まない。VS Code にも Node にも依存しない（MCP の束から使う）。
 */

export interface InkRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface InkBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  /** 幅÷高さ。1より大きければ横長 */
  aspect: number;
}

export interface InkGlyph extends InkBox {
  /** 題名の何字目か（`text` と字の数が合ったときだけ） */
  char?: string;
  /** 立っていれば横長になる字（「一」「_」）か */
  probe?: "wide";
  /**
   * 立っているか。**probe の字で、しかも形がはっきりしたときだけ**入る
   * （幅が高さの2倍以上なら true、高さが幅の2倍以上なら false）
   */
  upright?: boolean;
}

export type InkAlong = "vertical" | "horizontal";

export interface CoverInkOptions {
  /** 題名の色（#で始まる6桁の16進） */
  color: string;
  /** 色ごとの差の許容（0〜255）。既定 32 */
  tolerance?: number;
  /** 測る範囲（画素）。無ければ絵の全体 */
  region?: InkRegion;
  /** 字の並ぶ向き（縦に並べた題名なら vertical）。無ければ字に割らない */
  along?: InkAlong;
  /** 1字の大きさ（画素）。無ければ墨の、並ぶ向きと直交する幅で見積もる */
  cellSize?: number;
  /** 題名の文字。字の数が合えば、字と矩形を組にする */
  text?: string;
}

export type InkVerdict = "upright" | "rotated" | "mixed" | "unknown";

export interface CoverInkReport {
  image: { width: number; height: number };
  /** 実際に見た範囲（絵の外へはみ出した分は切った） */
  region: InkRegion;
  color: string;
  tolerance: number;
  /** 墨の画素の数 */
  inkPixels: number;
  /** 墨の外接矩形。墨が無ければ null */
  bounds: InkBox | null;
  along?: InkAlong;
  glyphs: InkGlyph[];
  /** `text` の字の数と、割った矩形の数が合ったか */
  paired: boolean;
  verdict: InkVerdict;
  notes: string[];
}

/** 立っていれば横長になる字。**形だけで向きが言える字**に限る */
const WIDE_WHEN_UPRIGHT = new Set(["一", "_", "＿"]);
/** 形がはっきりしたと言える縦横の比 */
const CLEAR_RATIO = 2;
const DEFAULT_TOLERANCE = 32;

export function parseHexColor(color: string): [number, number, number] | undefined {
  // 3桁（#fff）は6桁へ伸ばす。EPUBエディターの画面も同じに読む（expandHex）
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/iu.exec(color.trim());
  const value = short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : color.trim();
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(value);
  if (!match) return undefined;
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}

function box(left: number, top: number, right: number, bottom: number): InkBox {
  const width = right - left + 1;
  const height = bottom - top + 1;
  return { left, top, right, bottom, width, height, aspect: round(width / height) };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clipRegion(image: DecodedPng, region: InkRegion | undefined): InkRegion {
  if (!region) return { left: 0, top: 0, width: image.width, height: image.height };
  const left = Math.max(0, Math.floor(region.left));
  const top = Math.max(0, Math.floor(region.top));
  const right = Math.min(image.width, Math.ceil(region.left + region.width));
  const bottom = Math.min(image.height, Math.ceil(region.top + region.height));
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function measureCoverInk(image: DecodedPng, options: CoverInkOptions): CoverInkReport {
  const color = parseHexColor(options.color);
  if (!color) throw new Error(`題名の色の形が読めません（${options.color.slice(0, 20)}）。#ffffff の形で渡してください。`);
  const tolerance = Math.max(0, Math.min(255, options.tolerance ?? DEFAULT_TOLERANCE));
  const region = clipRegion(image, options.region);
  const notes: string[] = [];

  // 範囲の中の墨の印（1なら墨）
  const mask = new Uint8Array(region.width * region.height);
  let inkPixels = 0;
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) {
      const at = ((region.top + y) * image.width + (region.left + x)) * 4;
      if (image.rgba[at + 3] < 128) continue;
      if (
        Math.abs(image.rgba[at] - color[0]) > tolerance ||
        Math.abs(image.rgba[at + 1] - color[1]) > tolerance ||
        Math.abs(image.rgba[at + 2] - color[2]) > tolerance
      ) {
        continue;
      }
      mask[y * region.width + x] = 1;
      inkPixels++;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  const base = {
    image: { width: image.width, height: image.height },
    region,
    color: options.color,
    tolerance,
    inkPixels,
    ...(options.along ? { along: options.along } : {}),
  };
  if (right < 0) {
    notes.push(
      "範囲の中に題名の色の墨がありません。region（titleBlock）・色・許容差を確かめてください。"
    );
    return { ...base, bounds: null, glyphs: [], paired: false, verdict: "unknown", notes };
  }
  const bounds = box(region.left + left, region.top + top, region.left + right, region.top + bottom);

  if (!options.along) {
    notes.push("along（字の並ぶ向き）が無いので、字には割っていません。");
    return { ...base, bounds, glyphs: [], paired: false, verdict: "unknown", notes };
  }

  const vertical = options.along === "vertical";
  // 並ぶ向きへの投影（縦に並ぶなら行ごと、横に並ぶなら列ごとの墨の数）
  const alongStart = vertical ? top : left;
  const alongEnd = vertical ? bottom : right;
  const has = (index: number): boolean => {
    if (vertical) {
      for (let x = left; x <= right; x++) if (mask[index * region.width + x]) return true;
    } else {
      for (let y = top; y <= bottom; y++) if (mask[y * region.width + index]) return true;
    }
    return false;
  };
  const runs: [number, number][] = [];
  let start = -1;
  for (let index = alongStart; index <= alongEnd + 1; index++) {
    const inked = index <= alongEnd && has(index);
    if (inked && start < 0) start = index;
    if (!inked && start >= 0) {
      runs.push([start, index - 1]);
      start = -1;
    }
  }

  // 1字の中の空きでは割らない：1字の大きさに収まるうちはつなぐ
  const cross = vertical ? right - left + 1 : bottom - top + 1;
  const cell = options.cellSize && options.cellSize > 0 ? options.cellSize : cross;
  if (!(options.cellSize && options.cellSize > 0)) {
    notes.push(
      `1字の大きさ（cellSize）が無いので、墨の幅 ${cross}px で見積もりました（1行・1列の題名を前提）。`
    );
  }
  const merged: [number, number][] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run[1] - last[0] + 1 <= cell) last[1] = run[1];
    else merged.push([run[0], run[1]]);
  }

  const glyphs: InkGlyph[] = merged.map(([from, to]) => {
    // その帯の中の墨だけで、直交する向きの範囲を取り直す
    let crossFrom = Number.POSITIVE_INFINITY;
    let crossTo = -1;
    for (let along = from; along <= to; along++) {
      for (let other = vertical ? left : top; other <= (vertical ? right : bottom); other++) {
        const inked = vertical
          ? mask[along * region.width + other]
          : mask[other * region.width + along];
        if (!inked) continue;
        if (other < crossFrom) crossFrom = other;
        if (other > crossTo) crossTo = other;
      }
    }
    return vertical
      ? box(region.left + crossFrom, region.top + from, region.left + crossTo, region.top + to)
      : box(region.left + from, region.top + crossFrom, region.left + to, region.top + crossTo);
  });

  let paired = false;
  if (options.text !== undefined) {
    const chars = Array.from(options.text).filter((character) => !/\s/u.test(character));
    if (chars.length === glyphs.length) {
      paired = true;
      glyphs.forEach((glyph, index) => {
        const character = chars[index];
        glyph.char = character;
        if (!WIDE_WHEN_UPRIGHT.has(character)) return;
        glyph.probe = "wide";
        if (glyph.width >= glyph.height * CLEAR_RATIO) glyph.upright = true;
        else if (glyph.height >= glyph.width * CLEAR_RATIO) glyph.upright = false;
      });
    } else {
      notes.push(
        `題名は ${chars.length}字ですが、墨は ${glyphs.length}個に割れました。字と組にしていません` +
          "（折り返した題名は1行ずつ region を分けて測る・cellSize を渡す、で合うことがあります）。"
      );
    }
  }

  const judged = glyphs.filter((glyph) => glyph.upright !== undefined);
  let verdict: InkVerdict = "unknown";
  if (judged.length > 0) {
    const up = judged.filter((glyph) => glyph.upright).length;
    verdict = up === judged.length ? "upright" : up === 0 ? "rotated" : "mixed";
  } else {
    notes.push(
      "向きを形で言える字（「一」「_」）が題名に無いので、立っているかは判定していません。" +
        "字ごとの縦横比（aspect）を見てください。"
    );
  }
  return { ...base, bounds, glyphs, paired, verdict, notes };
}

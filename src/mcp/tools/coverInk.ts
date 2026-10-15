import fs from "node:fs";
import nodePath from "node:path";
import { inflateSync } from "node:zlib";
import { z } from "zod";
import { BOOK_DIR, BOOK_FILE } from "../../models/book";
import { DEFAULT_SETTINGS_DIR } from "../../models/types";
import { BAKED_COVER_FILES, type CoverSide } from "../../core/coverBakeFiles";
import { decodePng } from "../../core/pngDecode";
import { measureCoverInk, parseHexColor, type CoverInkReport, type InkAlong } from "../../core/coverInk";
import { checkRunFile } from "../../core/runRequest";
import { McpToolError } from "./shared";

/**
 * 焼いた表紙の題名の墨を測る（`cover.ink`。実機確認リスト 5488。2026-10-15）。
 *
 * `run.request` の `coverBake` で作者の VS Code に焼いてもらった PNG を読み、題名の色の
 * 墨の外接矩形・字ごとの矩形と縦横比・「立っているか」（形で言える字だけ）を返す。
 * 測り方は画面の自動テスト `epubCoverTitleUpright` と同じ考え（題名「一」の墨が横長か）。
 *
 * **読むだけ。** AIを呼ばない。本文を読まない。返すのは数字だけで、画像も返さない。
 * 許可の鍵は `run.request` と同じ（`SHARED_KEY_TOOLS`）——焼く依頼と組で使う道具で、
 * 鍵を分けると作者は1つの確かめのために2回許すことになる。
 */

const REGION = z
  .object({
    left: z.number(),
    top: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    // coverBake の結果の titleBlock をそのまま渡せるように、残りの項目も受ける
    fontSize: z.number().positive().optional(),
    vertical: z.boolean().optional(),
    lines: z.number().int().positive().optional(),
  })
  .passthrough();

export const COVER_INK_INPUT = {
  folder: z.string().describe("作品フォルダーの絶対パス"),
  side: z
    .enum(["front", "back"])
    .optional()
    .describe("front＝表紙（既定）、back＝裏表紙。焼いた画像（設定/書籍/表紙_合成済み.png など）を読む"),
  filePath: z
    .string()
    .optional()
    .describe("別の PNG を測るとき（作品フォルダーからの相対パス。coverBake の結果の filePath）。省略すると side の焼いた画像"),
  region: REGION.optional().describe(
    "測る範囲（画素）。coverBake の結果の titleBlock をそのまま渡すと、題名の範囲だけを測り、" +
      "字の並ぶ向き（vertical）と1字の大きさ（fontSize）もそこから取る。省略すると絵の全体（作者名など同じ色の字も拾う）"
  ),
  along: z
    .enum(["vertical", "horizontal"])
    .optional()
    .describe("字の並ぶ向き。region.vertical があれば省略可。無ければ字に割らない"),
  cellSize: z.number().positive().optional().describe("1字の大きさ（画素）。region.fontSize があれば省略可"),
  color: z
    .string()
    .optional()
    .describe("題名の色（#ffffff の形）。省略すると book.json のその面の題名の色"),
  tolerance: z.number().min(0).max(255).optional().describe("色ごとの差の許容（既定 32）"),
  text: z
    .string()
    .max(200)
    .optional()
    .describe("題名の文字（coverBake の結果の title）。字の数が合えば字と矩形を組にし、「一」「_」で立っているかを言う"),
};

export interface CoverInkInput {
  folder: string;
  side?: "front" | "back";
  filePath?: string;
  region?: z.infer<typeof REGION>;
  along?: InkAlong;
  cellSize?: number;
  color?: string;
  tolerance?: number;
  text?: string;
}

export interface CoverInkOutput extends CoverInkReport {
  /** 測った画像（作品フォルダーからの相対パス） */
  filePath: string;
  /** 測った画像の最終更新（焼いた時刻の目安。ISO） */
  modifiedAt: string;
  /** 色をどこから取ったか */
  colorSource: "argument" | "book.json" | "default";
}

/** 測る PNG の上限（焼いた表紙は数MB。桁違いのものは読まない） */
const MAX_PNG_BYTES = 30 * 1024 * 1024;

export function coverInk(args: CoverInkInput): CoverInkOutput {
  const folder = nodePath.resolve(args.folder);
  if (!fs.existsSync(folder)) {
    throw new McpToolError(`作品フォルダーが見つかりません: ${args.folder}`);
  }
  const side: CoverSide = args.side ?? "front";

  let relative: string;
  if (args.filePath !== undefined) {
    // 作品フォルダーの外を指させない（run.request の file と同じ判定）
    const problem = checkRunFile(args.filePath);
    if (problem) throw new McpToolError(problem.replace(/^file/u, "filePath"));
    if (!/\.png$/iu.test(args.filePath)) {
      throw new McpToolError("filePath は PNG を指してください（焼いた表紙は PNG です）。");
    }
    relative = args.filePath;
  } else {
    relative = [DEFAULT_SETTINGS_DIR, BOOK_DIR, BAKED_COVER_FILES[side]].join("/");
  }
  const target = nodePath.join(folder, relative);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new McpToolError(
      `焼いた画像がありません（${relative}）。run.request の coverBake で焼いてもらってから測ってください。`
    );
  }
  if (stat.size > MAX_PNG_BYTES) {
    throw new McpToolError(`画像が大きすぎます（${Math.round(stat.size / 1024 / 1024)}MB）。`);
  }

  let image;
  try {
    image = decodePng(new Uint8Array(fs.readFileSync(target)), (data) => inflateSync(data));
  } catch (error) {
    throw new McpToolError(
      `焼いた画像を読めませんでした（${error instanceof Error ? error.message : String(error)}）。`
    );
  }

  let color = args.color;
  let colorSource: CoverInkOutput["colorSource"] = "argument";
  if (color === undefined) {
    const fromBook = titleColorOf(folder, side);
    color = fromBook ?? "#ffffff";
    colorSource = fromBook ? "book.json" : "default";
  }
  if (!parseHexColor(color)) {
    throw new McpToolError(`color の形が読めません（${color.slice(0, 20)}）。#ffffff の形で渡してください。`);
  }

  const region = args.region;
  const along: InkAlong | undefined =
    args.along ?? (typeof region?.vertical === "boolean" ? (region.vertical ? "vertical" : "horizontal") : undefined);
  const cellSize = args.cellSize ?? region?.fontSize;
  const report = measureCoverInk(image, {
    color,
    ...(args.tolerance !== undefined ? { tolerance: args.tolerance } : {}),
    ...(region ? { region: { left: region.left, top: region.top, width: region.width, height: region.height } } : {}),
    ...(along ? { along } : {}),
    ...(cellSize !== undefined ? { cellSize } : {}),
    ...(args.text !== undefined ? { text: args.text } : {}),
  });
  if (typeof region?.lines === "number" && region.lines > 1) {
    report.notes.push(
      `題名は ${region.lines}行（列）に折り返されています。字ごとの割り方は1行（1列）を前提にしているので、` +
        "1行ずつ region を分けて測ってください。"
    );
  }
  if (colorSource === "default") {
    report.notes.push("book.json から題名の色を読めなかったので、白（#ffffff）で測りました。");
  }
  return {
    ...report,
    filePath: relative,
    modifiedAt: stat.mtime.toISOString(),
    colorSource,
  };
}

/**
 * book.json のその面の題名の色。**読むだけで、直さない**（壊れていれば undefined）。
 * 書いていなければ既定の白は呼び出し側が補う。
 */
function titleColorOf(folder: string, side: CoverSide): string | undefined {
  try {
    const text = fs.readFileSync(nodePath.join(folder, DEFAULT_SETTINGS_DIR, BOOK_DIR, BOOK_FILE), "utf8");
    const config = JSON.parse(text) as Record<string, unknown>;
    const layout = config[side === "back" ? "backCoverLayout" : "coverLayout"];
    if (typeof layout !== "object" || layout === null) return undefined;
    const title = (layout as Record<string, unknown>).title;
    if (typeof title !== "object" || title === null) return undefined;
    const color = (title as Record<string, unknown>).color;
    return typeof color === "string" && parseHexColor(color) ? color : undefined;
  } catch {
    return undefined;
  }
}

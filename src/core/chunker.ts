import { hashText } from "./textFile";

export interface Chunk {
  /** 元ファイルのパス */
  filePath: string;
  /** ファイル内での連番（0始まり） */
  index: number;
  /** 分割後の本文 */
  text: string;
  /** 元ファイル内での開始行（0始まり） */
  startLine: number;
  /** 話数（分かる場合） */
  chapterStart: number | null;
  chapterEnd: number | null;
  /** チャンク内容のハッシュ。キャッシュのキーに使う */
  hash: string;
}

export interface ChunkOptions {
  /** 1チャンクの目安文字数 */
  maxChars: number;
  /** 前チャンクの末尾を何文字重ねるか（文脈の連続性のため） */
  overlapChars: number;
}

/**
 * モデルのコンテキスト長からチャンクサイズを決める。
 *
 * 日本語はおおむね1文字1トークン前後だが、モデルによって
 * 1.5倍程度になることもある。加えてプロンプト本体・設定情報・
 * 出力領域も同じコンテキストを消費するため、安全側に倒す。
 */
export function decideChunkSize(contextWindow: number): number {
  // 入力本文に割り当てる割合。残りはプロンプト・参照設定・出力に使う
  const usableTokens = Math.floor(contextWindow * 0.35);
  // トークンあたり日本語0.7文字と見積もる（安全側）
  const chars = Math.floor(usableTokens * 0.7);
  // 極端な値を避けるため上下限を設ける
  return Math.max(1500, Math.min(chars, 20000));
}

const DEFAULT_OPTIONS: ChunkOptions = {
  maxChars: 8000,
  overlapChars: 0,
};

/**
 * 本文をチャンクに分割する。
 *
 * 文の途中で切ると解析精度が落ちるため、以下の優先順で区切る。
 *   1. 空行（段落の切れ目）
 *   2. 行末
 *   3. 句点
 * いずれも見つからない場合のみ文字数で強制的に切る。
 */
export function splitIntoChunks(
  filePath: string,
  text: string,
  chapterStart: number | null,
  chapterEnd: number | null,
  options: Partial<ChunkOptions> = {}
): Chunk[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (!Number.isInteger(opts.maxChars) || opts.maxChars < 1) {
    throw new Error("maxChars は1以上の整数にしてください。");
  }
  const normalized = text.replace(/\r\n?/g, "\n");

  if (normalized.length <= opts.maxChars) {
    return [
      {
        filePath,
        index: 0,
        text: normalized,
        startLine: 0,
        chapterStart,
        chapterEnd,
        hash: hashText(normalized),
      },
    ];
  }

  const chunks: Chunk[] = [];
  let cursor = 0;
  let index = 0;

  while (cursor < normalized.length) {
    const hardEnd = Math.min(cursor + opts.maxChars, normalized.length);
    let end = hardEnd;

    if (hardEnd < normalized.length) {
      end = findBreakPoint(normalized, cursor, hardEnd);
    }

    const body = normalized.slice(cursor, end);
    const startLine = countLines(normalized, cursor);

    chunks.push({
      filePath,
      index,
      text: body,
      startLine,
      chapterStart,
      chapterEnd,
      hash: hashText(body),
    });

    index++;
    if (end <= cursor) {
      throw new Error("チャンク分割位置を進められませんでした。");
    }
    cursor = end;
  }

  return chunks;
}

/** 区切りに適した位置を後ろから探す */
function findBreakPoint(text: string, start: number, hardEnd: number): number {
  // 探索範囲は上限の30%手前まで。それより前に戻ると細切れになるため
  const minEnd = start + Math.floor((hardEnd - start) * 0.7);

  // 1. 空行
  const blankLine = text.lastIndexOf("\n\n", hardEnd);
  if (blankLine > minEnd) return blankLine + 2;

  // 2. 行末
  const newline = text.lastIndexOf("\n", hardEnd);
  if (newline > minEnd) return newline + 1;

  // 3. 句点（閉じ括弧が続く場合はその後ろまで含める）
  for (let i = hardEnd; i > minEnd; i--) {
    if (text[i] === "。") {
      let j = i + 1;
      while (j < text.length && /[」』）\)]/.test(text[j])) j++;
      return j;
    }
  }

  return hardEnd;
}

function countLines(text: string, upto: number): number {
  let count = 0;
  for (let i = 0; i < upto; i++) {
    if (text[i] === "\n") count++;
  }
  return count;
}

import { hashText } from "./textFile";

/**
 * チャンクに含まれる話の内訳。
 *
 * 小さいファイルをまとめて1回で送るとき、
 * **どこからどこまでがどの話なのか**が分からなくなると、
 * 抽出した人物の登場話数を正しく付けられない。
 * チャンク本文の中での位置を持たせておき、
 * 抽出後にコード側で照合する（AIに話数を言わせない）。
 */
export interface ChunkSegment {
  filePath: string;
  chapterStart: number | null;
  chapterEnd: number | null;
  /** チャンク本文内での範囲（開始位置と終了位置） */
  start: number;
  end: number;
}

export interface Chunk {
  /** 元ファイルのパス。結合したチャンクでは先頭のファイル */
  filePath: string;
  /** ファイル内での連番（0始まり） */
  index: number;
  /** 分割後の本文 */
  text: string;
  /** 元ファイル内での開始行（0始まり） */
  startLine: number;
  /** 話数（分かる場合）。結合したチャンクでは全体の範囲 */
  chapterStart: number | null;
  chapterEnd: number | null;
  /** チャンク内容のハッシュ。キャッシュのキーに使う */
  hash: string;
  /**
   * 含まれる話の内訳。結合していなければ1件。
   *
   * 省略可能にしてあるのは、**1話1チャンクなら内訳を持たなくても
   * チャンク全体と同じ**だからである。持たないチャンクを渡されても
   * これまでどおり動く（`segmentsOf` が補う）。
   */
  segments?: ChunkSegment[];
  /**
   * 1つのまとまり（1ファイル、または合本の中の1話）が
   * まるごと収まっているか。
   *
   * 分割された断片の1つ目は、位置だけを見ると「先頭から末尾まで」に
   * 見えてしまい、まるごと1ファイルと区別が付かない。
   * 印を持たせないと、続きのある断片を別の話とまとめてしまう。
   * **印が無いチャンクはまとめない**（安全側）。
   */
  wholeFile?: boolean;
}

/** 内訳を取り出す。持っていなければ、チャンク全体を1件とみなす */
export function segmentsOf(chunk: Chunk): ChunkSegment[] {
  if (chunk.segments && chunk.segments.length > 0) return chunk.segments;
  return [
    {
      filePath: chunk.filePath,
      chapterStart: chunk.chapterStart,
      chapterEnd: chunk.chapterEnd,
      start: 0,
      end: chunk.text.length,
    },
  ];
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

/**
 * 本文以外に毎回送っている分の見積り（字）。
 * 抽出の指示が約5,600字、既知の名前リストがそれに乗る。
 */
const PROMPT_OVERHEAD_CHARS = 7000;

/** 日本語1文字あたりのトークン数（安全側）。`decideChunkSize` と同じ換算 */
const TOKENS_PER_CHAR = 1 / 0.7;

/**
 * 実際に確保するコンテキスト長を決める。
 *
 * **チャンクの大きさとコンテキスト長を別々に決めていたのが不具合だった。**
 * `decideChunkSize` はモデルの上限（131,072）から20,000字と決めるのに、
 * コンテキストは 16,384 に固定していた。20,000字の本文だけで
 * およそ28,600トークンあり、指示を足すと36,000トークンを超える。
 * **入力が入り切らず、出力の余地も残らない。**
 * その結果、応答が上限で切り詰められ、そのチャンクは丸ごと捨てられていた
 * （実データで39チャンク中33件）。
 *
 * 送るものから必要量を計算し、モデルの上限で頭打ちにする。
 * 上限をそのまま使わないのは、確保した分だけメモリを消費するためである。
 */
export function decideContextSize(options: {
  /** 1チャンクの本文の文字数 */
  chunkChars: number;
  /** 応答に見込むトークン数 */
  outputTokens: number;
  /** モデルが扱える上限 */
  contextWindow: number;
}): number {
  const inputTokens = Math.ceil(
    (options.chunkChars + PROMPT_OVERHEAD_CHARS) * TOKENS_PER_CHAR
  );
  // 見積りは外れることがあるので1割の余裕を持たせる
  const needed = Math.ceil((inputTokens + options.outputTokens) * 1.1);
  return Math.max(4096, Math.min(options.contextWindow, needed));
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

  const wholeSegment = (text: string): ChunkSegment[] => [
    { filePath, chapterStart, chapterEnd, start: 0, end: text.length },
  ];

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
        segments: wholeSegment(normalized),
        wholeFile: true,
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
      segments: wholeSegment(body),
    });

    index++;
    if (end <= cursor) {
      throw new Error("チャンク分割位置を進められませんでした。");
    }
    cursor = end;
  }

  return chunks;
}

/** 結合したチャンクで、話と話のあいだに入れる区切り */
const JOIN_SEPARATOR = "\n\n";

/**
 * 小さいファイルを隣どうしでまとめる。
 *
 * **1回の呼び出しごとに、本文とは別に約5,600字の指示を必ず送っている。**
 * 1話2,000字の作品では、指示のほうが本文より大きい。19話なら19回ぶん、
 * 同じ指示を送り直していることになる。まとめれば呼び出し回数が減り、
 * 送信量も所要時間も下がる（実データで送信量はおよそ半分、時間は3割減）。
 *
 * **まとめるのは「1ファイルがまるごと1チャンクに収まっているもの」だけ。**
 * 大きいファイルを分割した断片どうしは混ぜない。混ぜると、
 * 本来つながっている前後の文脈が切れた状態で別の話と隣り合ってしまう。
 *
 * 話の切れ目には空行だけを入れ、「第3話」のような目印は**書き足さない**。
 * 本文に無い文字列を混ぜると、AIがそれを引用として返してくることがある。
 */
export function mergeAdjacentChunks(
  chunks: Chunk[],
  options: { maxChars: number }
): Chunk[] {
  if (!Number.isInteger(options.maxChars) || options.maxChars < 1) {
    return [...chunks];
  }

  const merged: Chunk[] = [];
  let pending: Chunk[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    merged.push(pending.length === 1 ? pending[0] : joinChunks(pending));
    pending = [];
  };

  for (const chunk of chunks) {
    // 分割された断片は、そのファイルだけで完結させる
    if (!isWholeFile(chunk)) {
      flush();
      merged.push(chunk);
      continue;
    }
    const width =
      pending.reduce(
        (total, item) => total + item.text.length + JOIN_SEPARATOR.length,
        0
      ) + chunk.text.length;
    if (pending.length > 0 && width > options.maxChars) flush();
    pending.push(chunk);
  }
  flush();
  return merged;
}

/** 1ファイルがまるごと収まっているチャンクか */
function isWholeFile(chunk: Chunk): boolean {
  return chunk.wholeFile === true && segmentsOf(chunk).length === 1;
}

function joinChunks(chunks: Chunk[]): Chunk {
  const segments: ChunkSegment[] = [];
  let text = "";

  for (const chunk of chunks) {
    if (text.length > 0) text += JOIN_SEPARATOR;
    const start = text.length;
    text += chunk.text;
    segments.push({
      filePath: chunk.filePath,
      chapterStart: chunk.chapterStart,
      chapterEnd: chunk.chapterEnd,
      start,
      end: text.length,
    });
  }

  const chapters = chunks
    .flatMap((chunk) => [chunk.chapterStart, chunk.chapterEnd])
    .filter((value): value is number => typeof value === "number");

  return {
    filePath: chunks[0].filePath,
    index: 0,
    text,
    startLine: 0,
    chapterStart: chapters.length > 0 ? Math.min(...chapters) : null,
    chapterEnd: chapters.length > 0 ? Math.max(...chapters) : null,
    hash: hashText(text),
    segments,
  };
}

/**
 * 結合したチャンクを、元の話ごとに戻す。
 *
 * 出力上限で切り詰められると**そのチャンクの結果は丸ごと捨てる**ことになる
 * （部分的なJSONは解析できない）。まとめたせいで失敗したのなら、
 * 元の大きさでやり直せば通る見込みがある。捨てるより試すほうがよい。
 */
export function splitMergedChunk(chunk: Chunk): Chunk[] {
  if (segmentsOf(chunk).length <= 1) return [chunk];

  return segmentsOf(chunk).map((segment) => {
    const text = chunk.text.slice(segment.start, segment.end);
    return {
      // それぞれが1ファイルまるごとなので連番は0。
      // 分割された断片ではないので、ラベルにも「(2)」を出さない
      filePath: segment.filePath,
      index: 0,
      text,
      startLine: 0,
      chapterStart: segment.chapterStart,
      chapterEnd: segment.chapterEnd,
      hash: hashText(text),
      segments: [
        {
          filePath: segment.filePath,
          chapterStart: segment.chapterStart,
          chapterEnd: segment.chapterEnd,
          start: 0,
          end: text.length,
        },
      ],
      // 元はまるごと1ファイルだったもの
      wholeFile: true,
    };
  });
}

/**
 * 切り詰められたチャンクを半分に割る。
 *
 * まとめていないチャンク（大きいファイルを分割した断片）でも、
 * 出力が入り切らないことがある。**捨てると、その呼び出しは丸ごと無駄になる。**
 * 半分にすれば出力も半分で済み、通る見込みがある。
 *
 * 短くなりすぎたら諦める（際限なく割り続けないため）。
 */
export function splitChunkInHalf(
  chunk: Chunk,
  minChars = 1000
): Chunk[] | undefined {
  if (chunk.text.length < minChars * 2) return undefined;

  const middle = Math.floor(chunk.text.length / 2);
  // 文の途中で切ると解析精度が落ちる。段落・行の切れ目を優先する
  const cut = findBreakPoint(chunk.text, 0, middle);
  if (cut <= 0 || cut >= chunk.text.length) return undefined;

  const halves = [chunk.text.slice(0, cut), chunk.text.slice(cut)];
  return halves.map((text, offset) => ({
    filePath: chunk.filePath,
    index: chunk.index + offset,
    text,
    startLine: chunk.startLine,
    chapterStart: chunk.chapterStart,
    chapterEnd: chunk.chapterEnd,
    hash: hashText(text),
    segments: [
      {
        filePath: chunk.filePath,
        chapterStart: chunk.chapterStart,
        chapterEnd: chunk.chapterEnd,
        start: 0,
        end: text.length,
      },
    ],
    // 半分にしたものは、もう1ファイルまるごとではない
    wholeFile: false,
  }));
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

import { hashText } from "./textFile";
import { blankMemoLines } from "./sceneMemo";

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
  /**
   * この内訳が、元ファイルの何行目から始まるか（0始まり）。
   *
   * **まとめたチャンクでは、行番号が元ファイルのものではなくなる。**
   * 誤字脱字はAIに「何行目」を言わせ、その値で本文の位置を決めるので、
   * まとめたあとに元へ戻せないと、別のファイルの別の行を書き換えることになる。
   * 戻すための足がかりとして持つ（locateChunkLine）。
   */
  startLine: number;
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

/**
 * チャンク本文の各行に、元ファイル内での行番号（1始まり）を付ける。
 *
 * 誤字脱字検知・推敲のように「何行目」をAIに言わせて、
 * その値をそのまま該当箇所の特定に使う機能で使う。
 * `chunk.startLine` は0始まりのため、表示・照合に使う行番号は+1する。
 */
export function withLineNumbers(chunk: Chunk): string {
  return chunk.text
    .split("\n")
    .map((line, index) => `${chunk.startLine + index + 1}: ${line}`)
    .join("\n");
}

/**
 * このチャンクが、どの話を含んでいるかを1行で言う（設計書6.23）。
 *
 * **まとめたチャンクでは、話が1つとは限らない。** 矛盾検知はAIへ
 * 「いま見ているのは第何話か」を渡しており、まとめたあとに1つ目の話の
 * 名前だけを渡すと、**2話目以降の本文を1話目だと言って読ませることになる。**
 *
 * @param labelOf ファイルの場所から見出し（「第3話」など）を引く
 */
export function describeChunkScope(
  chunk: Chunk,
  labelOf: (filePath: string) => string | undefined
): string {
  const labels: string[] = [];
  for (const segment of segmentsOf(chunk)) {
    const label = labelOf(segment.filePath);
    if (label && !labels.includes(label)) labels.push(label);
  }
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  // **端どうしを繋ぐ。** 全部並べると、20話まとめたときに読めなくなる
  return `${labels[0]}〜${labels[labels.length - 1]}`;
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
      startLine: chunk.startLine,
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
 * 日本語1文字あたりのトークン数（安全側）。
 *
 * **換算はこの1つだけにする。** 以前は `decideChunkSize` が
 * 「0.7字/トークン」を、`decideContextSize` が「1/0.7 トークン/字」を
 * 別々に書いていた。片方だけ直すと、チャンクの大きさと確保する
 * コンテキスト長が別の前提で決まる（設計書6.27.10）。
 */
export const TOKENS_PER_CHAR = 1 / 0.7;

/**
 * これ以上は小さくしないチャンクの字数。
 *
 * ここを割ると、1文の途中で切れて誤検出のもとになる。
 * 「入らないから小さくする」の底でもあり、底でも入らないなら
 * **そのモデルでは無理**と作者へ言うほうがよい（黙って切り捨てない）。
 */
export const MIN_CHUNK_CHARS = 1500;

/** チャンクの字数の上限。大きすぎると1回の失敗で失うものが大きい */
const MAX_CHUNK_CHARS = 20000;

/**
 * モデルのコンテキスト長からチャンクサイズを決める。
 *
 * 日本語はおおむね1文字1トークン前後だが、モデルによって
 * 1.5倍程度になることもある。加えてプロンプト本体・設定情報・
 * 出力領域も同じコンテキストを消費するため、安全側に倒す。
 *
 * **ここは「指示や資料がどれくらいあるか」を知らない。** 35%という割合で
 * 残りをまとめて見込んでいるだけなので、指示や参照資料が育つと足りなくなる。
 * 実際の固定費を差し引くのは `planChunkBudget` の仕事である（設計書6.27.10）。
 */
export function decideChunkSize(contextWindow: number): number {
  // 入力本文に割り当てる割合。残りはプロンプト・参照設定・出力に使う
  const usableTokens = Math.floor(contextWindow * 0.35);
  const chars = Math.floor(usableTokens * 0.7);
  // 極端な値を避けるため上下限を設ける
  return Math.max(MIN_CHUNK_CHARS, Math.min(chars, MAX_CHUNK_CHARS));
}

/** `planChunkBudget` の結果。なぜその字数になったかを添える */
export interface ChunkBudget {
  chunkChars: number;
  /**
   * どう決まったか。
   * - `requested`  … 望みどおりに取れた（固定費を引いても余裕がある）
   * - `shrunk_to_fit` … 固定費に押されて縮めた
   * - `minimum`   … 縮めても足りず、下限で止めた（**入らない見込み**）
   */
  reason: "requested" | "shrunk_to_fit" | "minimum";
}

/**
 * 固定費（指示＋参照資料）と出力の見込みを差し引いてから、
 * 本文に割り当てる字数を決める（設計書6.27.10）。
 *
 * **本文の量だけが可変で、指示の量は固定、という前提が誤りだった。**
 * 指示（P-04a は約11,000字）も、辞書も、世界観の抜粋も育つ。育った分は
 * どこかが痩せなければ上限を超え、Ollama では**入力が黙って切り捨てられる**。
 * 痩せてよいのは本文だけなので、本文の割当をここで決める。
 *
 * `requestedChars`（設定または `decideChunkSize` の値）は**上限として扱う**。
 * 余裕があるからといって、作者が指定した字数より大きくはしない。
 */
export function planChunkBudget(options: {
  /** モデルが扱える上限（トークン） */
  contextWindow: number;
  /** 本文以外に毎回送る字数（system＋本文を空にした user の実測） */
  overheadChars: number;
  /** 応答に見込むトークン数 */
  outputTokens: number;
  /** 望みの字数（設定またはモデルからの自動） */
  requestedChars: number;
}): ChunkBudget {
  const overheadTokens = Math.ceil(options.overheadChars * TOKENS_PER_CHAR);
  const forBody = options.contextWindow - overheadTokens - options.outputTokens;
  // 見積りは外れることがあるので1割の余裕を持たせる（`contextSizeForPrompt` と同じ）
  const usableTokens = Math.floor(forBody / 1.1);
  const fits = Math.floor(usableTokens * 0.7);

  if (fits >= options.requestedChars) {
    return { chunkChars: options.requestedChars, reason: "requested" };
  }
  if (fits >= MIN_CHUNK_CHARS) {
    return { chunkChars: fits, reason: "shrunk_to_fit" };
  }
  // 下限でも入らない見込み。**ここでは止めない**——実際に入るかどうかは
  // 送る直前の関所（`ai/contextGuard.ts`）が実測で判断する。
  // 見込みだけで作者の実行を断ると、見込みが外れているときに手が無くなる。
  //
  // **下限へ「上げ」ない。** 作者が1,000字と指定しているのに1,500字にすると、
  // 入らないのを直そうとして送る量を増やすことになる（この関数は本文を
  // 痩せさせるためのもので、太らせるためのものではない）
  return {
    chunkChars: Math.min(MIN_CHUNK_CHARS, options.requestedChars),
    reason: "minimum",
  };
}

/** チャンクの大きさの決め方（設計書6.23） */
export type ChunkSizeMode =
  /** モデルのコンテキスト長から決める（既定） */
  | "auto"
  /** 作者が字数を指定する */
  | "manual";

/** 設定に書く言葉。**画面にそのまま出る**ので、機械語にしない */
export const CHUNK_SIZE_MODE_AUTO = "モデルによって可変";
export const CHUNK_SIZE_MODE_MANUAL = "文字数を指定する";

export function parseChunkSizeMode(value: string | undefined): ChunkSizeMode {
  return value === CHUNK_SIZE_MODE_MANUAL ? "manual" : "auto";
}

export interface ResolvedChunkSize {
  chars: number;
  /** 何を根拠に決めたか。ログと画面の説明に使う */
  from: "model" | "setting" | "fallback";
}

/**
 * 1チャンクの字数を決める（設計書6.23）。
 *
 * **既定は「モデルによって可変」。** モデルのコンテキスト長が取れるなら、
 * そこから決めるのがいちばん無駄がない。131,072のモデルへ2,000字ずつ
 * 送るのは、指示の使い回しという意味でも呼び出し回数という意味でも損である。
 *
 * **決め方を1か所に集める。** 以前は誤字脱字と設定資料の抽出だけが
 * `novelai.chunkChars` を見ており、**推敲と矛盾検知は設定を無視して
 * いつも自動だった**（2026-08-23に判明）。同じ設定が機能によって効いたり
 * 効かなかったりするのは、作者から見て理由が無い。
 *
 * @param configured `novelai.chunkChars` の値（0や未設定は「指定なし」）
 */
export function resolveChunkChars(options: {
  mode: ChunkSizeMode;
  configured: number | undefined;
  contextWindow: number;
}): ResolvedChunkSize {
  const fromModel = decideChunkSize(options.contextWindow);
  if (options.mode === "auto") return { chars: fromModel, from: "model" };

  const configured = options.configured;
  if (Number.isInteger(configured) && (configured as number) >= 1) {
    return { chars: configured as number, from: "setting" };
  }
  // **「指定する」を選んだのに字数が空、は起こりうる。** そこで止めるより、
  // モデルから決めて進めるほうがよい（作者は検知をしたくて押している）
  return { chars: fromModel, from: "fallback" };
}

/**
 * まとめて送るときの1回ぶんの字数を決める（設計書6.23）。
 *
 * **1話ずつ送ると、指示のほうが本文より大きい。** 1話2,000字の作品で
 * 指示が約5,600字。19話なら19回ぶん同じ指示を送り直すことになる。
 *
 * **自動のときは、チャンクの大きさまで詰める。** モデルが受けられる量を
 * 使い切るのが、呼び出し回数をいちばん減らす。手で指定しているときは、
 * その値を尊重する（ただしチャンクより大きくはしない）。
 */
export function resolveMergeChars(options: {
  mode: ChunkSizeMode;
  configured: number | undefined;
  chunkChars: number;
}): number {
  if (options.mode === "auto") return options.chunkChars;
  const configured = options.configured;
  if (Number.isInteger(configured) && (configured as number) >= 1) {
    return Math.min(configured as number, options.chunkChars);
  }
  return 0;
}

/**
 * 実際に送るプロンプトから、確保するコンテキスト長を決める。
 *
 * **本来は呼び出し側が `numCtx` を渡すべきで、これはその受け皿である。**
 * `generate` の呼び出し15か所のうち、渡していたのは4か所だけで、
 * 残る11か所（矛盾検知・推敲・逸脱検知・あらすじ・紹介文・プロット・
 * 設定パネル・AI相談）は既定の 8192 のまま送っていた（0.22.14で判明）。
 * チャンクがモデル可変になって20,000字（≒28,600トークン）を送るように
 * なったため、**固定の既定では入力が黙って切り捨てられる。**
 *
 * 実物の文字数から見積もれば、渡し忘れても切り捨ては起きない。
 *
 * **いまは全機能がこの道を通る**（設計書6.27.10）。以前は誤字脱字・抽出・
 * 設定パネルだけが `decideContextSize` という別の道を持ち、本文以外の量を
 * 固定12,000字と見込んでいた。固定である限り、指示や辞書が育てば必ず
 * 追い越される——実際に7,000字が実測の半分になっていた。
 * **送る文字列そのものが手元にあるのだから、見込む必要が無い。**
 */
export function contextSizeForPrompt(options: {
  /** 実際に送るプロンプトの文字数（system＋user） */
  promptChars: number;
  /** 応答に見込むトークン数 */
  outputTokens: number;
  /** モデルが扱える上限 */
  contextWindow: number;
}): number {
  const inputTokens = Math.ceil(options.promptChars * TOKENS_PER_CHAR);
  // 見積りは外れることがあるので1割の余裕を持たせる（`planChunkBudget` と同じ）
  const needed = Math.ceil((inputTokens + options.outputTokens) * 1.1);
  // **段に丸めて、チャンクごとに値が動かないようにする**（設計書6.52）。
  //
  // Ollama は `num_ctx` が変わるとモデルを読み込み直す。チャンクの長さは
  // 1つずつ違うので、丸めないと**毎回読み込み直しになる**——作者の報告
  // 「設定資料抽出中、一瞬CLの画面が複数回立ち上がる。チャンクの度に」
  // （2026-08-30）はこれで、内部の runner が起動し直すたびにコンソールが
  // 一瞬見えていた。読み込み直しは遅いので、時間切れの一因にもなる。
  const stepped = Math.ceil(needed / CONTEXT_STEP) * CONTEXT_STEP;
  return Math.max(4096, Math.min(options.contextWindow, stepped));
}

/**
 * `num_ctx` を丸める段。
 *
 * **小さすぎると丸める意味が無く、大きすぎると要らないメモリを確保する。**
 * 4096 なら、20,000字と18,000字のチャンク（約28,600と約25,700トークン）が
 * 同じ 32768 に収まる。確保が増えるのは最大でこの段のぶんだけである。
 */
const CONTEXT_STEP = 4096;

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
 *
 * ## シーンメモは、ここで消す（設計書6.40.2）
 *
 * **AIへ渡す本文が通る道はここ1本である。** 誤字脱字・推敲・矛盾・伏線・
 * 抽出は、どれも本文をこの関数へ入れてからAIへ送る。読み込み（`readTextFile`）
 * の側で落とすと、同じ関数を使っている原稿エディタからもメモが消えてしまう
 * ので、**チャンクへ入る直前**に1回だけ掛ける。
 *
 * 落とすのではなく**空行にする**（`blankMemoLines`）。誤字脱字と推敲は
 * AIに「何行目」を言わせ、その値で本文の位置を決めるので、行が減ると
 * **別の行を書き換える**ことになる。行数が変わらなければ `startLine` も
 * 指摘の行番号も、元の本文と一致したままである。
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
  const normalized = blankMemoLines(text.replace(/\r\n?/g, "\n"));

  const wholeSegment = (text: string, startLine: number): ChunkSegment[] => [
    { filePath, chapterStart, chapterEnd, start: 0, end: text.length, startLine },
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
        segments: wholeSegment(normalized, 0),
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
      segments: wholeSegment(body, startLine),
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
      // **元ファイルの何行目からかを控える。** これが無いと、まとめた
      // チャンクで返ってきた行番号を元のファイルへ戻せない
      startLine: chunk.startLine,
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
      // **0に戻さない。** まとめる前の行番号へ戻す。誤字脱字は
      // ここで返した行番号をそのまま本文の位置に使うので、0にすると
      // 話の途中を先頭と見なして別の行を書き換える
      startLine: segment.startLine,
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
          startLine: segment.startLine,
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
  return halves.map((text, offset) => {
    // **後半は、割った位置の行数だけ後ろから始まる。** 両方に同じ
    // 開始行を入れると、後半の指摘がすべて前半の行を指す
    const startLine =
      offset === 0
        ? chunk.startLine
        : chunk.startLine + countLines(chunk.text, cut);
    return {
      filePath: chunk.filePath,
      index: chunk.index + offset,
      text,
      startLine,
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
          startLine,
        },
      ],
      // 半分にしたものは、もう1ファイルまるごとではない
      wholeFile: false,
    };
  });
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

/** 行番号の戻り先 */
export interface ChunkLineLocation {
  filePath: string;
  /** 元ファイル内での行番号（1始まり） */
  line: number;
}

/**
 * `withLineNumbers` が振った行番号を、元のファイルと行へ戻す。
 *
 * **まとめていないチャンクでは、振った番号がそのまま元ファイルの行番号である**
 * （`chunk.startLine + index + 1`）。何もしなくてよい。
 *
 * **まとめたチャンクでは違う。** `startLine` が0になり、番号は
 * まとめた本文の中での通し番号になる。どの内訳に入るかを位置から割り出し、
 * その内訳の開始行を足して元へ戻す。
 *
 * ここを通さずに `chunk.filePath` と行番号をそのまま使うと、
 * **2話目以降の指摘が1話目のファイルの、まったく違う行を書き換える。**
 * 誤字脱字は本文を書き換えるので、取り違えは原稿の破壊になる。
 *
 * 範囲の外を指していれば `undefined` を返す。AIは平気で範囲外の行を返す。
 */
export function locateChunkLine(
  chunk: Chunk,
  line: number
): ChunkLineLocation | undefined {
  if (!Number.isInteger(line) || line < 1) return undefined;
  const segments = segmentsOf(chunk);

  // まとめていないチャンク。番号は既に元ファイルのもの
  if (segments.length === 1) {
    const lineCount = chunk.text.split("\n").length;
    const first = chunk.startLine + 1;
    if (line < first || line > chunk.startLine + lineCount) return undefined;
    return { filePath: segments[0].filePath, line };
  }

  const lineCount = chunk.text.split("\n").length;
  if (line > lineCount) return undefined;

  // 0始まりに直してから、内訳の行範囲と突き合わせる
  const target = line - 1;
  for (const segment of segments) {
    const firstLine = countLines(chunk.text, segment.start);
    // 内訳の末尾の1文字ぶん手前を見る。`end` は次の内訳の直前を指すため
    const lastLine = countLines(
      chunk.text,
      Math.max(segment.start, segment.end - 1)
    );
    if (target < firstLine || target > lastLine) continue;
    return {
      filePath: segment.filePath,
      line: target - firstLine + segment.startLine + 1,
    };
  }
  return undefined;
}

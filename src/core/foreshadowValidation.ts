import type { Chunk } from "./chunker";
import { segmentsOf } from "./chunker";
import { normalizeForComparison } from "./groundedEvidence";
import { isPlaceholderText } from "./placeholderText";
import { sha256Text } from "./hash";
import {
  FORESHADOW_DETECT_HINTS,
  FORESHADOW_LABEL_MAX_CHARS,
} from "../prompts/foreshadowDetect";
import { FORESHADOW_RESOLVE_HINTS } from "../prompts/foreshadowResolve";

/**
 * 伏線の検知（P-25 / P-26）の応答の検証（設計書6.35.2・6.35.3）。
 *
 * **AIの出力を信用しない。** ここで見るのは4つ。
 *
 *   1. **引用が本文に逐語で在るか**（`groundedEvidence` の流儀）。
 *      無い引用は、材料側の文を写したか、作り出したかのどちらかである
 *   2. **指示の言葉が中身として返っていないか**（`placeholderText`）。
 *      「該当なし」「短い名」がそのまま名前や引用として返る
 *   3. **既に台帳にあるものと重なっていないか**（設計書6.35.2）。
 *      **まとめはコードで行う。** AIに「既存と同じか」を判断させると、
 *      別の伏線を1つに畳んでくる
 *   4. **P-26では、返ってきた `id` が実在するか。** 一覧に無い番号を
 *      返してくるので、それで台帳を書き換えては困る
 *
 * VS Code APIに依存しない（`Chunk` は型としてだけ使う）。
 */

/** 本文と照合できた配置の候補 */
export interface AcceptedForeshadowCandidate {
  label: string;
  note: string;
  quote: string;
  /** 引用が実在したファイル。まとめたチャンクでは、その話のファイル */
  filePath: string;
  /** 張った話数。読み取れなければ null（**推測で埋めない**） */
  chapter: number | null;
  chunkHash: string;
}

export type ForeshadowRejectReason =
  /** 形が違う（項目が無い・文字列でない） */
  | "shape"
  /** 指示の言葉がそのまま返ってきた */
  | "placeholder"
  /** 引用が本文に無い */
  | "quote_not_found"
  /** 既に台帳にある、または同じ回で二重に出た */
  | "duplicate";

export interface RejectedForeshadow {
  raw: unknown;
  reason: ForeshadowRejectReason;
}

/** 重なりを見るために要る、台帳側の1件 */
export interface KnownForeshadow {
  label: string;
  plantedQuote: string;
}

/**
 * 構造化出力でも前後に説明やコードフェンスが付くモデルがあるため、
 * 生のJSON、コードフェンス除去、最外の波括弧抽出の順で解析する
 * （矛盾検知と同じ手順）。
 */
export function parseForeshadowDetectResult(
  text: string
): { foreshadows: unknown[] } | null {
  const parsed = parseObject(text);
  if (!parsed || !Array.isArray(parsed.foreshadows)) return null;
  return { foreshadows: parsed.foreshadows };
}

export function parseForeshadowResolveResult(
  text: string
): { resolutions: unknown[] } | null {
  const parsed = parseObject(text);
  if (!parsed || !Array.isArray(parsed.resolutions)) return null;
  return { resolutions: parsed.resolutions };
}

/**
 * 配置の候補（P-25）を検証する。
 *
 * @param known 既に台帳にある伏線。**重なるものは出さない**（設計書6.35.2）
 */
export function validateForeshadowCandidates(
  raw: unknown,
  chunk: Chunk,
  known: readonly KnownForeshadow[] = []
): {
  accepted: AcceptedForeshadowCandidate[];
  rejected: RejectedForeshadow[];
} {
  const accepted: AcceptedForeshadowCandidate[] = [];
  const rejected: RejectedForeshadow[] = [];

  const list =
    isRecord(raw) && Array.isArray(raw.foreshadows) ? raw.foreshadows : [];

  // 既存との照合は、名前と引用の**どちらか**が一致すれば重なりとみなす。
  // 同じ伏線を別の言葉で名付けてくることも、同じ箇所を引くこともある
  const knownLabels = new Set(
    known.map((entry) => normalizeForComparison(entry.label)).filter(Boolean)
  );
  const knownQuotes = new Set(
    known
      .map((entry) => normalizeForComparison(entry.plantedQuote))
      .filter(Boolean)
  );

  for (const item of list) {
    if (!isRecord(item)) {
      rejected.push({ raw: item, reason: "shape" });
      continue;
    }

    const label = asString(item.label);
    const quote = asString(item.quote);
    if (!label || !quote) {
      rejected.push({ raw: item, reason: "shape" });
      continue;
    }

    // **指示の言葉がそのまま返ってくる**（この作品で繰り返し起きた失敗3）
    if (isEmptyAnswer(label, FORESHADOW_DETECT_HINTS)) {
      rejected.push({ raw: item, reason: "placeholder" });
      continue;
    }
    // **引用は「本文に在るか」で決める。** ヒント語を含むかは見ない——
    // 指示語をなぞっただけの引用は、このあとの逐語照合で落ちる。
    // 逆に、ヒント語（「何を示唆しているか」など日本語として自然な句）が
    // たまたま入った**本物の引用**を、ここで捨ててはいけない
    if (isPlaceholderText(quote)) {
      rejected.push({ raw: item, reason: "placeholder" });
      continue;
    }

    // **引用が本文に実在するかを見る。** 実在しなければ、その候補が
    // 何を指しているのか作者には確かめようがない
    const at = locateQuoteInChunk(chunk, quote);
    if (!at) {
      rejected.push({ raw: item, reason: "quote_not_found" });
      continue;
    }

    const shortLabel = shortenLabel(label);
    const normalizedLabel = normalizeForComparison(shortLabel);
    const normalizedQuote = normalizeForComparison(quote);
    if (knownLabels.has(normalizedLabel) || knownQuotes.has(normalizedQuote)) {
      rejected.push({ raw: item, reason: "duplicate" });
      continue;
    }
    // **同じ回の中でも重なる。** チャンクが重なる範囲を持つため、
    // 隣り合うチャンクが同じ記述を拾うことがある
    knownLabels.add(normalizedLabel);
    knownQuotes.add(normalizedQuote);

    accepted.push({
      label: shortLabel,
      // 示唆は補足なので、中身が無ければ空にするだけで候補は残す
      note: usableNote(asString(item.note), FORESHADOW_DETECT_HINTS),
      quote,
      filePath: at.filePath,
      chapter: at.chapter,
      chunkHash: chunk.hash,
    });
  }

  return { accepted, rejected };
}

/** 本文と照合できた回収の候補 */
export interface AcceptedForeshadowResolution {
  /** どの伏線か。**一覧に実在するものだけ** */
  id: string;
  quote: string;
  note: string;
  filePath: string;
  /** 回収した話数。読み取れなければ null */
  chapter: number | null;
  chunkHash: string;
}

export type ResolutionRejectReason =
  | "shape"
  | "placeholder"
  | "quote_not_found"
  /** 一覧に無い id を返してきた */
  | "unknown_id"
  /** 張った箇所そのものを「回収」と言い張ってきた */
  | "planted_echo"
  | "duplicate";

export interface RejectedResolution {
  raw: unknown;
  reason: ResolutionRejectReason;
}

/**
 * 回収の候補（P-26）を検証する。
 *
 * @param open いま未回収の伏線（idと張った引用と張った話数）。**ここに無い id は捨てる。**
 *   張った引用は「張った箇所そのものを回収と言い張る」候補を弾くのに使う
 *   ——同じ話の中での回収も検知の対象にしたので（0.24.10）、張った文が
 *   同じチャンクに居る。それを回収と誤認されると台帳が誤って閉じる。
 *   張った話数は「チャンクの中のどこが張った箇所か」を決めるのに使う
 *   （`plantedEchoFree`）。無ければ、張った文の出てくる所をすべて張った箇所とみなす
 */
export function validateForeshadowResolutions(
  raw: unknown,
  chunk: Chunk,
  open: ReadonlyArray<{
    id: string;
    plantedQuote: string;
    plantedChapter?: number | null;
  }>
): {
  accepted: AcceptedForeshadowResolution[];
  rejected: RejectedResolution[];
} {
  const accepted: AcceptedForeshadowResolution[] = [];
  const rejected: RejectedResolution[] = [];

  const list =
    isRecord(raw) && Array.isArray(raw.resolutions) ? raw.resolutions : [];
  const known = new Map(open.map((entry) => [entry.id, entry] as const));
  const seen = new Set<string>();

  for (const item of list) {
    if (!isRecord(item)) {
      rejected.push({ raw: item, reason: "shape" });
      continue;
    }

    const id = asString(item.id);
    const quote = asString(item.quote);
    if (!id || !quote) {
      rejected.push({ raw: item, reason: "shape" });
      continue;
    }
    // **番号を作ってくる。** 実在しない伏線を「回収済み」にはできない
    if (!known.has(id)) {
      rejected.push({ raw: item, reason: "unknown_id" });
      continue;
    }
    // **引用は「本文に在るか」で決める**（配置の検知と同じ理由）。
    // 指示語をなぞっただけの引用は、このあとの逐語照合で落ちる
    if (isPlaceholderText(quote)) {
      rejected.push({ raw: item, reason: "placeholder" });
      continue;
    }
    // **回収の根拠こそ照合する**（設計書6.35.3）。誤って回収済みの印が
    // 付くと、作者は安心して回収を忘れる
    const at = locateQuoteInChunk(chunk, quote);
    if (!at) {
      rejected.push({ raw: item, reason: "quote_not_found" });
      continue;
    }
    // 張った箇所そのものは回収ではない。同じ話も検知の対象にしたので、
    // 張った文が同じチャンクに居る——AIがそれを指してくることがある。
    // **文字列の一致ではなく、本文の中の位置で見る**（`plantedEchoFree`）
    const entry = known.get(id);
    const place = entry
      ? plantedEchoFree(chunk, quote, entry.plantedQuote, entry.plantedChapter ?? null)
      : at;
    if (!place) {
      rejected.push({ raw: item, reason: "planted_echo" });
      continue;
    }
    if (seen.has(id)) {
      rejected.push({ raw: item, reason: "duplicate" });
      continue;
    }
    seen.add(id);

    accepted.push({
      id,
      quote,
      note: usableNote(asString(item.note), FORESHADOW_RESOLVE_HINTS),
      // 付ける話数は、張った箇所から離れた出どころのもの（同じ台詞が
      // 張った話と回収の話の両方にあるとき、先に見つかる張った話を付けない）
      filePath: place.filePath,
      chapter: place.chapter,
      chunkHash: chunk.hash,
    });
  }

  return { accepted, rejected };
}

/**
 * 回収の引用が、張った箇所から離れた所にもあるか。あればその出どころを返す。
 *
 * **張った箇所そのものを「回収」と言い張る答えを、位置で見分ける。**
 * 2026-09-25 まで、弾くのは「引用が張った引用と丸ごと同じ」ときだけだった。
 * 実機確認（gemma4:e4b、第8話）で、**張った台詞を含む1行まるごと**
 * （「ちょっと訳ありでね。**こちらのエルシーさんを冒険者登録したいんだけど**」）や、
 * **張った台詞と同じ行の前半**（「帝都近郊で…観測されたんだ。」の後ろに
 * 張った文が続く）を返され、どちらも回収として通っていた。
 *
 * 文字列の包含だけで落とさないのは、**同じ言い回しが本当に回収の場面で
 * 繰り返される**ことがあるから（あの時の台詞を、あとの話でもう一度言う）。
 * そこで「張った箇所」を本文の中の**位置**として決め、引用の出てくる所が
 * **どれもその位置と同じ行に掛かる**ときだけ落とす。
 *
 * - 張った箇所：チャンクの中で張った文が出てくる所。張った話数が分かれば、
 *   **その話の内訳の中**に出てくる所だけ（あとの話での繰り返しは張った箇所ではない）。
 *   話数が分からなければ、出てくる所をすべて張った箇所とみなす
 *   （取り違えて台帳を閉じるより、回収を1回見送るほうが害が小さい）
 * - 近すぎる：張った箇所と**同じ行**（改行から改行まで。小説では1段落）に掛かる。
 *   行が違えば、同じ話の中の回収として通す（短い話では同じ話の中で張って回収する）
 * - 張った文がこのチャンクに無ければ（あとの話だけのチャンク）、位置では落とさない
 *
 * @returns 張った箇所から離れた出どころ。すべて張った箇所に掛かるなら undefined
 */
function plantedEchoFree(
  chunk: Chunk,
  quote: string,
  plantedQuote: string,
  plantedChapter: number | null
): { filePath: string; chapter: number | null } | undefined {
  const text = chunk.text;
  const index = normalizedWithPositions(text);
  const segments = segmentsOf(chunk);

  const plantedLines = findSpans(index, plantedQuote)
    .filter(
      (span) =>
        plantedChapter === null ||
        segments.some(
          (segment) =>
            span.start >= segment.start &&
            span.start < segment.end &&
            coversChapter(segment, plantedChapter)
        )
    )
    .map((span) => lineRange(text, span));

  for (const span of findSpans(index, quote)) {
    const near = plantedLines.some(
      (line) => span.start < line.end && span.end > line.start
    );
    if (near) continue;
    // 離れた所にある。**その出どころの話数を付ける**（内訳をまたぐなら話数は付けない。
    // `locateQuoteInChunk` と同じ扱い）
    const segment = segments.find(
      (candidate) => span.start >= candidate.start && span.end <= candidate.end
    );
    return segment
      ? { filePath: segment.filePath, chapter: segment.chapterStart }
      : { filePath: chunk.filePath, chapter: null };
  }
  return undefined;
}

/** 内訳が、その話数を含むか。話数の分からない内訳は「含むかもしれない」とみなす */
function coversChapter(
  segment: { chapterStart: number | null; chapterEnd: number | null },
  chapter: number
): boolean {
  if (segment.chapterStart === null) return true;
  const end = segment.chapterEnd ?? segment.chapterStart;
  return chapter >= segment.chapterStart && chapter <= end;
}

/**
 * `normalizeForComparison` と同じ落とし方で正規化し、正規化後の各文字が
 * 元の本文の何文字目だったかを控える。
 *
 * 照合は正規化した形で行う（gemma系は全角スペースやバイト表記の揺れを
 * 返す）が、**行を決めるには元の本文の位置が要る**（改行も空白として
 * 落ちるため、正規化後の文字列には行の切れ目が残らない）。
 */
function normalizedWithPositions(text: string): {
  normalized: string;
  positions: number[];
} {
  let normalized = "";
  const positions: number[] = [];
  let i = 0;
  while (i < text.length) {
    // バイト表記（<0xE3>）は6文字まとめて落とす（`normalizeForComparison` と同じ）
    if (/^<0x[0-9A-Fa-f]{2}>/u.test(text.slice(i, i + 6))) {
      i += 6;
      continue;
    }
    const ch = text[i];
    if (/[\s　]/u.test(ch)) {
      i++;
      continue;
    }
    normalized += ch;
    positions.push(i);
    i++;
  }
  return { normalized, positions };
}

/** 引用が本文に出てくる所を、元の本文の位置（開始・終了）ですべて返す */
function findSpans(
  index: { normalized: string; positions: number[] },
  quote: string
): Array<{ start: number; end: number }> {
  const needle = normalizeForComparison(quote);
  if (!needle) return [];
  const spans: Array<{ start: number; end: number }> = [];
  let from = 0;
  for (;;) {
    const at = index.normalized.indexOf(needle, from);
    if (at < 0) break;
    spans.push({
      start: index.positions[at],
      end: index.positions[at + needle.length - 1] + 1,
    });
    from = at + 1;
  }
  return spans;
}

/** 範囲が掛かる行（改行の次から、次の改行まで）の範囲 */
function lineRange(
  text: string,
  span: { start: number; end: number }
): { start: number; end: number } {
  const start = text.lastIndexOf("\n", span.start - 1) + 1;
  const next = text.indexOf("\n", span.end);
  return { start, end: next < 0 ? text.length : next };
}

/**
 * 引用が本文のどこに在るかを探す。
 *
 * **まとめたチャンクは、話が1つとは限らない。** チャンク全体の話数を
 * そのまま付けると、第5話にしか無い記述が「第3話で張った」になる。
 * 引用が入っている内訳（`ChunkSegment`）を探して、その話数を返す。
 *
 * 照合は `normalizeForComparison`（空白とバイト表記の揺れを落とす）で行う。
 * gemma系は全角スペースをバイト表記のまま返すことがあり、素の比較では
 * 逐語一致に失敗する。
 *
 * @returns 実在しなければ undefined（**その候補は捨てる**）
 */
export function locateQuoteInChunk(
  chunk: Chunk,
  quote: string
): { filePath: string; chapter: number | null } | undefined {
  const needle = normalizeForComparison(quote);
  if (!needle) return undefined;

  for (const segment of segmentsOf(chunk)) {
    const text = normalizeForComparison(
      chunk.text.slice(segment.start, segment.end)
    );
    if (!text.includes(needle)) continue;
    return { filePath: segment.filePath, chapter: segment.chapterStart };
  }

  // 内訳の切れ目をまたぐ引用（重なり部分など）は、内訳では見つからない。
  // チャンク全体には在るのなら捏造ではないので、**話数は付けずに**通す
  if (normalizeForComparison(chunk.text).includes(needle)) {
    return { filePath: chunk.filePath, chapter: null };
  }
  return undefined;
}

/**
 * 未回収の伏線の集合を短い指紋にする（設計書6.35.3）。
 *
 * **台帳が変われば、同じ本文でも判定が変わる。** キャッシュの鍵へ入れないと、
 * 伏線を1件足したのに「前回と同じ結果」が返り続ける。
 *
 * 見るのは**IDと更新時刻に加えて、AIへ渡す中身そのもの**である。
 * 時刻だけでは、作者がJSONを手で直して時刻を書き換えなかったときに
 * 変化を拾えない。中身も混ぜておけば、その場合も鍵が変わる。
 */
export function openForeshadowsFingerprint(
  records: ReadonlyArray<{
    id: string;
    updatedAt: string;
    label: string;
    note: string;
    plantedQuote: string;
    plantedChapter: number | null;
  }>
): string {
  return sha256Text(
    JSON.stringify(
      records.map((record) => [
        record.id,
        record.updatedAt,
        record.label,
        record.note,
        record.plantedQuote,
        record.plantedChapter,
      ])
    )
  ).slice(0, 16);
}

/**
 * 長すぎる名前を切り詰める。
 *
 * **候補ごと捨てない。** 名前が長いだけで落とすと、引用と示唆まで
 * 一緒に消える。作者は一覧で名前を見て判断するので、読める長さにする。
 */
function shortenLabel(label: string): string {
  const body = label.trim();
  return body.length > FORESHADOW_LABEL_MAX_CHARS
    ? `${body.slice(0, FORESHADOW_LABEL_MAX_CHARS)}…`
    : body;
}

/**
 * 句読点・かっこを落とす（ヒント語との照合用）。
 *
 * AIは指示の言葉を返すとき、かっこや読点を添えてくる
 * （`（何を示唆しているか）`）。**言葉そのものは同じ**なので、
 * これらを落としてから比べる。
 */
function normalizeForHintMatch(text: string): string {
  return normalizeForComparison(text).replace(
    /[、。，．,.:：;；!！?？「」『』（）()〔〕【】《》〈〉[\]{}｛｝“”"'’‘]/gu,
    ""
  );
}

/**
 * 中身のつもりで書かれた「中身が無い」言葉か。
 *
 * 2種類ある。**どちらも実データで返ってきた形である。**
 *
 *   1. 「該当なし」「空文字」のような、中身が無いことを表す言葉
 *      （`placeholderText.ts`）
 *   2. **プロンプトの出力例に書いた言い換えそのもの**
 *      （「一覧の見出しにする名前」など）。指示の言葉は、そのまま
 *      答えとして返ってくる（`CLAUDE.md` の繰り返し起きた失敗3）
 *
 * **2は「丸ごと同じ」ときだけ弾く。** 以前は部分一致で見ていたため、
 * 「この時計が**何を示唆しているか**は第3話ではまだ明かされない」のような
 * 正当な説明まで空扱いになっていた。ヒント語は「何を示唆しているか」など
 * 日本語として自然な言い回しなので、本物の説明の中にも普通に現れる。
 */
function isEmptyAnswer(text: string, hints: readonly string[]): boolean {
  if (isPlaceholderText(text)) return true;
  const body = normalizeForHintMatch(text);
  if (!body) return true;
  return hints.some((hint) => body === normalizeForHintMatch(hint));
}

/** 中身の無い言葉が来たら、空にする（書いてあることにしない） */
function usableNote(note: string, hints: readonly string[]): string {
  return isEmptyAnswer(note, hints) ? "" : note;
}

function asString(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(text: string): Record<string, unknown> | null {
  const attempts = [
    text,
    text.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/, ""),
    extractBraces(text),
  ];

  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (isRecord(parsed)) return parsed;
    } catch {
      // 次の候補を試す
    }
  }
  return null;
}

function extractBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

/** 却下の理由を、作者が読める日本語にする */
const REJECT_REASON_LABELS: Record<string, string> = {
  shape: "形が違う",
  placeholder: "中身の無い言葉",
  quote_not_found: "引用が本文に無い",
  unknown_id: "実在しない伏線番号",
  planted_echo: "張った箇所そのもの",
  duplicate: "既にあるものと重なり",
};

/**
 * 却下の内訳を、ログ向けの1行にする（設計書6.35.7）。
 *
 * **「本文と合わない N件」だけでは、次に何をすればよいか分からない。**
 * 実データで、伏線の回収の確認が「候補0件 / 本文と合わない10件」——
 * つまり検出率0%——になったことがあるが、10件がどの理由で落ちたのかが
 * 残っていないため、**プロンプトの問題なのか照合が厳しすぎるのかを
 * 切り分けられなかった**（作者のログ、2026-08-29）。
 *
 * 理由ごとに次の手がまるで違う：
 * - `unknown_id`／`quote_not_found` が多い → AIが番号や引用を作っている（プロンプト）
 * - `planted_echo` が多い → 「回収を探せ」が伝わっていない（プロンプト）
 * - `shape` が多い → スキーマの与え方（プロバイダの方言）
 *
 * 件数が0なら空文字を返す（成功した回のログを汚さない）。
 */
export function describeRejectReasons(
  rejected: ReadonlyArray<{ reason: string }>
): string {
  if (rejected.length === 0) return "";
  const counts = new Map<string, number>();
  for (const entry of rejected) {
    counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  }
  // 多い順に出す。同数なら理由の名前で並べて、実行ごとに順が揺れないようにする
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${REJECT_REASON_LABELS[reason] ?? reason} ${count}件`);
  return parts.join("、");
}

import { PHOTO_EXAMPLE_CHARS, PHOTO_TRANSCRIBE_HINTS, UNREADABLE_MARK } from "../prompts/photoTranscribe";
import { cutAtInlineRepetition } from "./inlineRepetition";
import { closeTruncatedJson } from "./truncatedResponse";

/**
 * 写真の書き起こし（P-48、設計書6.117.7）の答えの検算。VS Code に依存しない。
 *
 * **AIの出力を信用しない**（規則3）。ただし書き起こしは**本文に照らせない**
 * （正しい字は写真の中にしかない）ので、ここで直しはしない。捨てるのは
 * 中身の無い行と指示の言葉の返りだけで、怪しい所（〓・ラテン文字の連なり・
 * 写真の説明らしい行）は**数えて画面で目立たせ**、作者が写真と見比べて直す。
 */

export interface PhotoTranscription {
  /** 書き起こした文（行を改行でつないだもの。LF） */
  readonly text: string;
  /** 読めない字の印（〓）の数 */
  readonly unreadable: number;
  /**
   * ラテン文字が3字以上続く所（行は1始まり）。測定で、手書きの日本語の中に
   * 英語の1語（wider）が混じった。昔の原稿に英字が出ることもあるので捨てない
   */
  readonly latinRuns: readonly { readonly line: number; readonly text: string }[];
  /** 写真の説明らしい行（行は1始まり）。測定で、逆さの写真に紙の説明を返したモデルがあった */
  readonly descriptiveLines: readonly number[];
  /** 指示の言葉がそのまま返って捨てた行の数 */
  readonly droppedEchoes: number;
  /**
   * 原則2に例として挙げた字（國・學・體・ゝ・ゞ。`PHOTO_EXAMPLE_CHARS`）の数。
   * **捨てない**——写真に本当にある字かもしれず、正しい字は写真の中にしかない。
   * 指示の例が写真に無いのに混じっていないか、作者に見比べてもらう（失敗3）
   */
  readonly exampleChars: number;
}

export interface PhotoTranscribeParseOptions {
  /**
   * 作者からの頼みの各行（`photoRequestEchoes`）。行の全体がこれと同じものは、
   * 指示の言葉の返りとして捨てる
   */
  readonly requestEchoes?: readonly string[];
}

export type PhotoTranscribeParse =
  | { readonly ok: true; readonly value: PhotoTranscription }
  | { readonly ok: false; readonly reason: string };

const LATIN_RUN = /[A-Za-zＡ-Ｚａ-ｚ]{3,}/gu;

/**
 * 写真の説明らしい行。**捨てない**（本文に「この写真には」と書く小説もある）。
 * 目立たせて、作者に見てもらう
 */
const DESCRIPTIVE_PATTERNS: readonly RegExp[] = [
  /^(この|その)?(写真|画像)(に|は|には|では)/u,
  /^(この|その)(ページ|ノート|紙)(に|は|には)/u,
  /(と|が)書かれて(い|お)(ます|ります)。?$/u,
  /^手書きの(文字|文章|原稿|メモ)/u,
];

/** 行の全体が指示の言葉と同じか（前後の約物と空白を落として比べる） */
function isEcho(line: string, extra: readonly string[]): boolean {
  // 括弧ごとの言葉（「（読めない）」）もあるので、外側の空白と句点だけを落とした形と、
  // 括弧まで落とした形の両方で比べる
  let form = line.replace(/^[\s　]+|[\s　。、:：]+$/gu, "");
  for (;;) {
    if (form === "") return false;
    if (PHOTO_TRANSCRIBE_HINTS.includes(form) || extra.includes(form)) return true;
    // 外側の括弧を1組ずつ外して比べ直す
    const inner = form.replace(/^[「『（(【](.*)[」』）)】]$/u, "$1");
    if (inner === form) return false;
    form = inner;
  }
}

export function parsePhotoTranscription(
  raw: string,
  options: PhotoTranscribeParseOptions = {}
): PhotoTranscribeParse {
  // 頼みの行も、比べる形（外側の空白と句点を落とした形）に揃えておく
  const extra = (options.requestEchoes ?? [])
    .map((one) => one.replace(/^[\s　]+|[\s　。、:：]+$/gu, ""))
    .filter((one) => one !== "");
  const parsed = parseObject(raw);
  if (!parsed) return { ok: false, reason: "AIの答えを読み取れませんでした（JSONの形ではありません）。" };
  if (!Array.isArray(parsed.lines)) {
    return { ok: false, reason: "AIの答えに行の並び（lines）がありません。" };
  }

  const kept: string[] = [];
  let droppedEchoes = 0;
  for (const item of parsed.lines) {
    const text =
      typeof item === "string"
        ? item
        : typeof item === "object" && item !== null && typeof (item as { text?: unknown }).text === "string"
          ? (item as { text: string }).text
          : undefined;
    if (text === undefined) continue;
    // 改行を含めて返すモデルがある。行として並べ直す（中の空の行は落とす）
    for (const piece of text.replace(/\r\n?/g, "\n").split("\n")) {
      // 行頭の全角空白（字下げ）は残す。行末の空白だけ落とす
      const line = piece.replace(/[\s　]+$/u, "");
      if (line.trim() === "") continue;
      if (isEcho(line, extra)) {
        droppedEchoes += 1;
        continue;
      }
      kept.push(line);
    }
  }

  if (kept.length === 0) {
    return {
      ok: false,
      reason:
        droppedEchoes > 0
          ? "AIが指示の言葉だけを返しました。写真の向きを直すか、別のAIでお試しください。"
          : "AIが1行も書き起こしませんでした。写真の向きを直すか、別のAIでお試しください。",
    };
  }

  const latinRuns: { line: number; text: string }[] = [];
  const descriptiveLines: number[] = [];
  let unreadable = 0;
  let exampleChars = 0;
  kept.forEach((line, index) => {
    unreadable += countMark(line);
    for (const char of line) if (PHOTO_EXAMPLE_CHARS.includes(char)) exampleChars += 1;
    for (const match of line.matchAll(LATIN_RUN)) {
      latinRuns.push({ line: index + 1, text: match[0] });
    }
    const trimmed = line.trim();
    if (DESCRIPTIVE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      descriptiveLines.push(index + 1);
    }
  });

  return {
    ok: true,
    value: {
      text: kept.join("\n"),
      unreadable,
      latinRuns,
      descriptiveLines,
      droppedEchoes,
      exampleChars,
    },
  };
}

/** 1行の中の繰り返しで止めたときに、そのページへ出す言葉（A17） */
export const INLINE_REPEAT_STOP_NOTE =
  "同じ字が続いたので止めました。写真の向きをお確かめください。";

/**
 * 答えを読む。**1行の中で同じ並びが続いていたら、1つ目の並びで切ってから読む**
 * （残課題 A17、2026-10-11。`core/inlineRepetition.ts`）。
 *
 * 流して受け取る道では途中で止まり、流さないAIでは上限まで書いた答えが届く。
 * どちらも閉じていない JSON なので、切ったあと `closeTruncatedJson` で閉じる。
 * 読めなければ、止めたことだけを理由にして返す（作者の次の一手は向きの確認）。
 */
export function parsePhotoTranscriptionStoppingRepeats(
  raw: string,
  options: PhotoTranscribeParseOptions = {}
): {
  readonly parse: PhotoTranscribeParse;
  /** 1行の中の繰り返しで切ったか */
  readonly repeatStopped: boolean;
} {
  const head = cutAtInlineRepetition(raw);
  if (head === undefined) {
    return { parse: parsePhotoTranscription(raw, options), repeatStopped: false };
  }
  for (const candidate of closeTruncatedJson(head)) {
    const parse = parsePhotoTranscription(candidate, options);
    if (parse.ok) return { parse, repeatStopped: true };
  }
  return {
    parse: { ok: false, reason: INLINE_REPEAT_STOP_NOTE },
    repeatStopped: true,
  };
}

/** 〓の数（作者が直したあとの文でも数え直すので、外へ出す） */
export function countMark(text: string): number {
  let count = 0;
  for (const char of text) if (char === UNREADABLE_MARK) count += 1;
  return count;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(body.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

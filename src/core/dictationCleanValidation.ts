import { stripCodeFence } from "./synopsisValidation";

/**
 * 口述筆記の整文（P-35）の応答を検証する（設計書6.83）。
 *
 * **AIの出力を信用しない。** 整文は、返ってきた文字列を**そのまま本文へ
 * 置き換える**数少ない機能である（誤字脱字や推敲は1件ずつ作者が確認する）。
 * だから、置き換える前にここで止める。
 *
 * ## なぜ「内容に踏み込まない物差し」なのか
 *
 * 「書き直していないか」をコードで判定するのは、突き詰めれば人間の読解で
 * ある。ここで狙うのは**明らかな事故だけを止めること**——空を返した、
 * 半分に要約した、勝手に台詞を作った、といったものである。
 *
 * - **長さの比**（0.6〜1.5倍）: 句読点と改行が入るぶん少し伸び、
 *   言いよどみが取れるぶん少し縮む。桁で変わるなら整文ではない
 * - **鍵括弧の増減**: 会話をくくるのは正しい仕事なので増えてよいが、
 *   何十組も増えるのは、地の文を台詞に作り替えたということ。
 *   **許す組数は長さに比例させる**（100字につき1組、最低3組）——
 *   固定の3組では、会話の多い長い口述を1回で整えたときに必ず引っかかる
 * - **空でない**: 空文字を本文へ書き込むと、口述した分が丸ごと消える
 *
 * **AIの言葉そのもの（「えーと」など）で判断しない。** プロンプトに書いた
 * 指示語はそのまま返ってくるうえ、本文の言葉としても現れるので、
 * 語の有無は何の証拠にもならない。
 *
 * VS Code APIに依存しない（純粋関数）。
 */

/** 整えた本文の長さの下限（元に対する比） */
export const DICTATION_MIN_LENGTH_RATIO = 0.6;
/** 整えた本文の長さの上限（元に対する比） */
export const DICTATION_MAX_LENGTH_RATIO = 1.5;
/**
 * 鍵括弧（「」）の増減として許す組数の下限。
 *
 * 短い口述でも、会話がいくつか入ることはある。ここを下回らせない。
 */
export const DICTATION_MIN_QUOTE_ALLOWANCE = 3;
/** 何字につき1組ぶん許すか */
export const DICTATION_QUOTE_ALLOWANCE_PER_CHARS = 100;

/**
 * その長さの口述で、鍵括弧が何組まで増減してよいか。
 *
 * **長さに比例させる**（本体の裁定、2026-09-06）。会話の多い場面を
 * まとめて口述すると、正しく整えただけで「」は何組も増える。
 */
export function dictationQuoteAllowance(chars: number): number {
  return Math.max(
    DICTATION_MIN_QUOTE_ALLOWANCE,
    Math.ceil(chars / DICTATION_QUOTE_ALLOWANCE_PER_CHARS)
  );
}
/** 通知に出す「直した点」の件数 */
export const DICTATION_NOTES_SHOWN = 3;

export interface DictationCleanResult {
  text: string;
  notes: string[];
}

/**
 * 応答のJSONを、この機能が扱う形に整える。読めなければ null。
 *
 * `notes` は**無くても失敗にしない**（空配列にする）。直した点の一覧は
 * 添え物であって、本文が正しく返っていれば置き換えられる。
 */
export function parseDictationCleanResult(
  text: string
): DictationCleanResult | null {
  let value: unknown;
  try {
    value = JSON.parse(stripCodeFence(text));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  if (typeof raw.text !== "string") return null;

  const notes = Array.isArray(raw.notes)
    ? raw.notes
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];

  return { text: raw.text, notes };
}

export type DictationCleanCheck =
  | { ok: true; text: string; notes: string[] }
  /** 置き換えない理由。**作者にそのまま見せる文言**にしてある */
  | { ok: false; reason: string };

/**
 * 会話の組数。会話を作り替えていないかを見るのに使う。
 *
 * **開きと閉じの多いほうを組数とする。** 片方だけ増えるのは組み損ねで
 * あって、数え落とすと「地の文を台詞に作り替えた」を見逃す。
 */
function countDialogues(text: string): number {
  let open = 0;
  let close = 0;
  for (const character of text) {
    if (character === "「") open++;
    else if (character === "」") close++;
  }
  return Math.max(open, close);
}

/**
 * 整えた本文を、本文へ置き換えてよいかを見る。
 *
 * **外れたら本文には触らない。** 直しようのある失敗ではないので、
 * 部分的に採り入れるようなことはしない（作者がもう一度押せばよい）。
 */
export function validateDictationClean(
  original: string,
  result: DictationCleanResult
): DictationCleanCheck {
  const cleaned = result.text.trim();
  if (cleaned.length === 0) {
    return { ok: false, reason: "整えた本文が空でした。" };
  }

  const before = original.trim().length;
  // 元が空のときは比を取れない。呼ぶ側が下限（DICTATION_MIN_CHARS）で
  // 弾いているので通常は起きないが、0除算で NaN を返さないようにしておく
  if (before === 0) {
    return { ok: false, reason: "整える範囲が空でした。" };
  }

  const ratio = cleaned.length / before;
  if (ratio < DICTATION_MIN_LENGTH_RATIO) {
    return {
      ok: false,
      reason:
        `整えた本文が短すぎます（${before}字 → ${cleaned.length}字）。` +
        "要約された可能性があるため、置き換えませんでした。",
    };
  }
  if (ratio > DICTATION_MAX_LENGTH_RATIO) {
    return {
      ok: false,
      reason:
        `整えた本文が長すぎます（${before}字 → ${cleaned.length}字）。` +
        "書き足された可能性があるため、置き換えませんでした。",
    };
  }

  const dialogueDelta = countDialogues(cleaned) - countDialogues(original);
  if (Math.abs(dialogueDelta) > dictationQuoteAllowance(before)) {
    return {
      ok: false,
      reason:
        `会話の鍵括弧が${Math.abs(dialogueDelta)}組${dialogueDelta > 0 ? "増え" : "減り"}ました。` +
        "地の文と会話が作り替えられた可能性があるため、置き換えませんでした。",
    };
  }

  return { ok: true, text: cleaned, notes: result.notes };
}

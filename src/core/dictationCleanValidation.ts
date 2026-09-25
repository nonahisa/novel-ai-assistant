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
 * - **中の言葉が変わった会話の組数**（`countChangedDialogues`）: 会話を
 *   「」でくくるのは正しい仕事なので、**括っただけ・閉じただけの組は数えない**
 *   （作者の裁定、2026-09-26 朝。それまでは組数の増減を数えていて、正しく
 *   括るほど止まっていた）。中の言葉が元に無い組は、会話を作った・言い換えた
 *   ということなので数える。**許す組数は長さに比例させる**（100字につき1組、
 *   最低3組）——誤変換を会話の中で直すことはあるので、0組にはしない
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
 * 中の言葉が変わった会話（`countChangedDialogues`）として許す組数の下限。
 *
 * 短い口述でも、会話の中の誤変換を直すことはある。ここを下回らせない。
 */
export const DICTATION_MIN_QUOTE_ALLOWANCE = 3;
/** 何字につき1組ぶん許すか */
export const DICTATION_QUOTE_ALLOWANCE_PER_CHARS = 100;

/**
 * その長さの口述で、中の言葉が変わった会話を何組まで許すか。
 *
 * **長さに比例させる**（本体の裁定、2026-09-06）。会話の多い場面を
 * まとめて口述すると、会話の中の誤変換の直しも増える。括っただけの組は
 * そもそも数えない（R18、2026-09-26）。
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

/** 開き括弧 → 対になる閉じ括弧。会話の「」と、書名や会話の中の会話の『』 */
const BRACKET_PAIRS: Readonly<Record<string, string>> = { "「": "」", "『": "』" };
const CLOSING_BRACKETS = new Set(Object.values(BRACKET_PAIRS));

/** 括弧の中身をくらべる前に落とす字（括弧・句読点・空白・改行） */
const IGNORED_IN_COMPARISON = /[「」『』、。，．,.！？!?…‥―—・\s　]/gu;

/**
 * くらべるための形。**括弧・句読点・空白を落とす。**
 *
 * 整文がしてよいのは句読点と改行を入れることなので、それらの違いは
 * 「言葉が変わった」に数えない。
 */
function comparable(text: string): string {
  return text.replace(IGNORED_IN_COMPARISON, "");
}

interface BracketScan {
  /** 対になった括弧の中身（入れ子なら内側も外側も） */
  contents: string[];
  /** 対にならなかった括弧の数（開いたまま・閉じだけ・種類違い） */
  unmatched: number;
}

/** 本文の括弧を、対になったものと、ならなかったものに分ける */
function scanBrackets(text: string): BracketScan {
  const contents: string[] = [];
  const stack: Array<{ open: string; at: number }> = [];
  let unmatched = 0;

  for (let at = 0; at < text.length; at++) {
    const character = text[at];
    if (character in BRACKET_PAIRS) {
      stack.push({ open: character, at });
      continue;
    }
    if (!CLOSING_BRACKETS.has(character)) continue;
    const top = stack[stack.length - 1];
    if (top && BRACKET_PAIRS[top.open] === character) {
      stack.pop();
      contents.push(text.slice(top.at + 1, at));
    } else {
      unmatched++;
    }
  }

  return { contents, unmatched: unmatched + stack.length };
}

/**
 * **括弧の中の言葉が、元に無い**組の数（作者の裁定、2026-09-26 朝。精査の粗 R18）。
 *
 * これまでは「」の**組数の増減**を数えていた。会話の多い場面を口述して正しく
 * 整えると、「」は会話の数だけ増える——**正しく括るほど「変えすぎ」になって
 * 置き換えが止まっていた。**
 *
 * 裁定は「**「」を足した・閉じただけの違いは数えない。語の増減は今までどおり
 * 見張る**」。そこで組ごとに中身を見る。
 *
 * - **整えた側の組**：中身（括弧・句読点・空白を落とした形）が元の本文に
 *   そのまま入っていれば、元の言葉を括っただけである。入っていなければ、
 *   会話の言葉を作った・言い換えたので数える
 * - **元の側の組**：中身が整えた本文にそのまま残っていれば数えない。
 *   残っていなければ、会話の言葉を消した・言い換えたので数える
 * - **対にならない括弧**：元より増えた分だけ数える（開いたままの「を
 *   ばらまくのは括ったことにならない）。閉じ忘れを閉じた分は減るので数えない
 *
 * **両側の多いほうを取る。** 会話を1つ言い換えると、整えた側にも元の側にも
 * 「無い」組が1つずつ出る。足すと1か所の直しを2組と数えてしまう。
 *
 * 語の増減そのもの（地の文を足した・削った）は、長さの比が見張る。
 */
export function countChangedDialogues(original: string, cleaned: string): number {
  const before = scanBrackets(original);
  const after = scanBrackets(cleaned);
  const originalFlat = comparable(original);
  const cleanedFlat = comparable(cleaned);

  const invented = after.contents.filter(
    (content) => !originalFlat.includes(comparable(content))
  ).length;
  const lost = before.contents.filter(
    (content) => !cleanedFlat.includes(comparable(content))
  ).length;
  const strayBrackets = Math.max(0, after.unmatched - before.unmatched);

  return Math.max(invented, lost) + strayBrackets;
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

  // 括っただけの組は数えない（R18）。数えるのは中の言葉が変わった組
  const changedDialogues = countChangedDialogues(original, cleaned);
  if (changedDialogues > dictationQuoteAllowance(before)) {
    return {
      ok: false,
      reason:
        `鍵括弧の中の言葉が元と違う会話が${changedDialogues}組ありました。` +
        "会話が作り替えられた可能性があるため、置き換えませんでした。",
    };
  }

  return { ok: true, text: cleaned, notes: result.notes };
}

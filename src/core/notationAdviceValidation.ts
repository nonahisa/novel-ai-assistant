import { isPlaceholderText } from "./placeholderText";
import {
  NOTATION_ADVICE_HINTS,
  NOTATION_ADVICE_NO_UNIFY,
} from "../prompts/notationAdvice";

/**
 * 表記ゆれのAI問い合わせ（P-33、設計書6.73）の応答の検証。
 *
 * **AIの出力を信用しない。** 見るのは2つ。
 *
 *   1. `choice` が**渡した表記のどれか**、または「揃えない」か。
 *      選択肢に無い表記（言い換え・新しい書き方）は捨てる。そのまま出すと、
 *      **本文に一度も出ていない書き方へ揃えるよう勧める**ことになる
 *   2. `reason` に**指示の言葉がそのまま返っていないか**（`placeholderText` と
 *      プロンプト側の `NOTATION_ADVICE_HINTS`）。理由が無いことと、答えが
 *      無いことは違うので、**理由だけを空にして答えは残す**
 *
 * 読めなければ undefined を返す。**勝手にどちらかへ倒さない**——揃える先を
 * 取り違えると、作者は本文全体を間違ったほうへ直すことになる。
 *
 * VS Code APIに依存しない（単体テストの対象）。
 */

export interface NotationAdvice {
  /**
   * 揃える先の表記。渡した表記のどれか、または `NOTATION_ADVICE_NO_UNIFY`。
   * **必ず選択肢の中の文字列**（AIが書いた文字列をそのまま入れない）
   */
  choice: string;
  /** 「揃えない」と答えたか。画面の文言を分けるために持つ */
  noUnify: boolean;
  /** そう判断した理由。中身の無い言葉なら空 */
  reason: string;
}

/**
 * 応答を読む。
 *
 * @param surfaces その組に実在する表記（この中からしか選ばせない）
 */
export function parseNotationAdvice(
  text: string,
  surfaces: readonly string[]
): NotationAdvice | undefined {
  const parsed = parseObject(text);
  if (!parsed) return undefined;

  const raw = typeof parsed.choice === "string" ? parsed.choice : "";
  const choice = matchChoice(raw, surfaces);
  if (!choice) return undefined;

  const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
  return {
    choice,
    noUnify: choice === NOTATION_ADVICE_NO_UNIFY,
    reason: isEmptyAnswer(reason) ? "" : reason,
  };
}

/**
 * 答えを選択肢へ突き合わせる。
 *
 * 鉤括弧や句点が付いて返ることがあるので、そこだけは落として比べる。
 * **それ以上は寄せない**——「引っ越」のような似た文字列を近いほうへ
 * 丸めると、作者には確かめようがないまま別の表記を勧めることになる。
 *
 * 「揃えない」だけは言い足し（「揃えないほうがよい」）を許す。
 * 言い足されても指すものが1つしかなく、取り違えようがないためである。
 */
function matchChoice(
  raw: string,
  surfaces: readonly string[]
): string | undefined {
  const body = normalize(raw);
  if (!body) return undefined;

  const found = surfaces.find((surface) => normalize(surface) === body);
  if (found) return found;

  const noUnify = normalize(NOTATION_ADVICE_NO_UNIFY);
  if (body === noUnify || body.startsWith(noUnify)) {
    return NOTATION_ADVICE_NO_UNIFY;
  }
  // ひらがなで書いてくることがある（こちらが指示に使っている語である）
  if (body.startsWith("そろえない")) return NOTATION_ADVICE_NO_UNIFY;

  return undefined;
}

/** 前後の括弧・引用符・句読点を落とす（中身は変えない） */
function normalize(text: string): string {
  return text
    .trim()
    .replace(/^[「『"'“”‘’（(\[【\s]+|[」』"'“”‘’）)\]】。、\s]+$/gu, "")
    .trim();
}

/**
 * 中身のつもりで書かれた「中身が無い」言葉か。
 *
 * 2種類ある。**どちらも実データで返ってきた形である**（CLAUDE.md）。
 *
 *   1. 「特になし」「該当なし」のような、中身が無いことを表す言葉
 *   2. **プロンプトに書いた項目名そのもの**（「そう判断した理由」）
 */
function isEmptyAnswer(text: string): boolean {
  if (!text) return true;
  // 理由はまるごと置き換わる文なので、広いほう（「なし」も落とす）で見る
  if (isPlaceholderText(text, true)) return true;
  const body = normalizeForHintMatch(text);
  if (!body) return true;
  return NOTATION_ADVICE_HINTS.some(
    (hint) => body === normalizeForHintMatch(hint)
  );
}

/** 指示語との突き合わせ用。約物と空白の違いで取り逃がさないようにする */
function normalizeForHintMatch(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, "")
    .replace(
      /[、。，．,.:：;；!！?？「」『』（）()〔〕【】《》〈〉[\]{}｛｝“”"'’‘]/gu,
      ""
    );
}

/**
 * 応答からJSONの本体を切り出して読む。
 *
 * 構造化出力に対応していないモデルは、前置きやコードフェンスを付けてくる
 * （`openingCheck.ts` と同じ手順）。
 */
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

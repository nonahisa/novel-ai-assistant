/**
 * 2つの診断にまたがる「似た1問」の答えを共有する（作者の裁定、2026-09-23）。
 *
 * 作家タイプ診断に入口をまとめたとき（書き方5問・助言の受け方9問・
 * 読者としての好み9問）、次の2問がほぼ同じことを聞いていた。
 *
 * - 助言の受け方 Z3（嗜好志向）「同じ題材の他作品を熱心に読みますか」
 *   あまり読まない／ときどき／かなり読む
 * - 読者としての好み A3（読み慣れ）「いま好きな題材について、似た作品を
 *   どれくらい読んできましたか」
 *   ほとんど読んでいない／人並みには読んでいる／かなり読んでいる
 *
 * **全部やると、同じことを2度答えさせることになる。** そこで、片方で
 * 答えたら、もう片方ではその答えを選んだ状態で出す。
 *
 * ## 選択肢の対応は、添字そのまま（0↔0・1↔1・2↔2）
 *
 * どちらも「読んだ量が少ない → 多い」の順に0・1・2点で並んでおり、
 * 点の向きも同じ（Z3 は多いほど嗜好志向が高い、A3 は多いほど読み慣れが
 * 高い）。**向きが逆なら写し替えで反転させる必要がある**ので、対応は
 * 下の表に書いて、試験（`sharedDiagnosisQuestion.test.ts`）で両方の
 * 並びと点を突き合わせる。問いの文面や点を変えたら、そこで気づける。
 *
 * **答えは写すだけで、採点には手を入れない。** それぞれの9問の採点は
 * いままでどおり自分の答えだけで行う（共有された答えも、作者がそこで
 * Enter を押して選び直した「自分の答え」として入る）。
 *
 * VS Code にも AI にも依存しない。
 */

import { ADVICE_QUESTIONS } from "./advicePolicy";
import { AUTHOR_READER_QUESTIONS } from "./authorReaderType";

/** 共有する問いの呼び名（それぞれの問いの `id`） */
export const SHARED_ADVICE_QUESTION_ID = "Z3";
export const SHARED_READER_QUESTION_ID = "A3";

/**
 * 選択肢の対応（助言の受け方の添字 → 読者としての好みの添字）。
 *
 * **表にして持つ。** 「同じ並びだから添字をそのまま渡す」をコードに
 * 埋めると、片方の並びを変えた日に黙って逆の答えを写す。
 */
const ADVICE_TO_READER_CHOICE: readonly number[] = [0, 1, 2];

/** 共有する問いの、それぞれの9問の中での位置 */
export function sharedAdviceIndex(): number {
  return ADVICE_QUESTIONS.findIndex(
    (question) => question.id === SHARED_ADVICE_QUESTION_ID
  );
}

export function sharedReaderIndex(): number {
  return AUTHOR_READER_QUESTIONS.findIndex(
    (question) => question.id === SHARED_READER_QUESTION_ID
  );
}

/** 助言の受け方で選んだ選択肢を、読者としての好みの選択肢へ写す */
export function readerChoiceFromAdvice(choice: number): number | undefined {
  return ADVICE_TO_READER_CHOICE[choice];
}

/** 読者としての好みで選んだ選択肢を、助言の受け方の選択肢へ写す */
export function adviceChoiceFromReader(choice: number): number | undefined {
  const found = ADVICE_TO_READER_CHOICE.indexOf(choice);
  return found < 0 ? undefined : found;
}

/**
 * 問いの画面へ渡す「もう片方で答えたもの」。
 *
 * `index` の問いでは、`choice` の選択肢を選んだ状態（いちばん上）で出し、
 * `from` をその行の補足に書く。
 */
export interface SharedAnswer {
  readonly index: number;
  readonly choice: number;
  /** どちらの診断で答えたか（画面の補足に出す） */
  readonly from: string;
}

/** 画面の補足に出す、それぞれの診断の呼び名 */
export const ADVICE_PART_LABEL = "助言の受け方";
export const READER_PART_LABEL = "読者としての好み";

/** 答えを持っている記録の形（細い口にする） */
interface AnsweredRecord {
  readonly answers?: readonly number[];
  /** いつの答えか（ISO）。新しいほうを写す */
  readonly updatedAt: string;
}

/**
 * 助言の受け方を聞くときに写す答え。
 *
 * **写すのは、もう片方のほうが新しいときだけ。** 助言の受け方を自分で
 * 答え直した直後に、古い読者の答えで上書きした状態を出すと、作者が
 * いま選んだものが画面で消えて見える。自分の側に答えが無ければ写す。
 */
export function sharedForAdvice(
  reader: AnsweredRecord | undefined,
  advice: AnsweredRecord | undefined
): SharedAnswer | undefined {
  const readerAnswer = reader?.answers?.[sharedReaderIndex()];
  if (readerAnswer === undefined || !reader) return undefined;
  if (!isNewer(reader, advice, sharedAdviceIndex())) return undefined;
  const choice = adviceChoiceFromReader(readerAnswer);
  if (choice === undefined) return undefined;
  return { index: sharedAdviceIndex(), choice, from: READER_PART_LABEL };
}

/** 読者としての好みを聞くときに写す答え（`sharedForAdvice` の逆向き） */
export function sharedForReader(
  advice: AnsweredRecord | undefined,
  reader: AnsweredRecord | undefined
): SharedAnswer | undefined {
  const adviceAnswer = advice?.answers?.[sharedAdviceIndex()];
  if (adviceAnswer === undefined || !advice) return undefined;
  if (!isNewer(advice, reader, sharedReaderIndex())) return undefined;
  const choice = readerChoiceFromAdvice(adviceAnswer);
  if (choice === undefined) return undefined;
  return { index: sharedReaderIndex(), choice, from: ADVICE_PART_LABEL };
}

/**
 * いま答えたばかりの答えから写す（「全部やる」の途中）。
 *
 * 日付を比べる必要は無い——たった今、作者が選んだものである。
 */
export function sharedFromJustAnsweredAdvice(
  answers: readonly number[]
): SharedAnswer | undefined {
  const adviceAnswer = answers[sharedAdviceIndex()];
  if (adviceAnswer === undefined) return undefined;
  const choice = readerChoiceFromAdvice(adviceAnswer);
  if (choice === undefined) return undefined;
  return { index: sharedReaderIndex(), choice, from: ADVICE_PART_LABEL };
}

/** 写し元のほうが新しいか。写し先がその問いに答えていなければ、写してよい */
function isNewer(
  source: AnsweredRecord,
  target: AnsweredRecord | undefined,
  targetIndex: number
): boolean {
  if (target?.answers?.[targetIndex] === undefined) return true;
  // ISO の日時どうしは、文字列のまま比べて前後が分かる
  return source.updatedAt > target.updatedAt;
}

/**
 * 選択肢の並びを、共有された答えを先頭にして組み直す。
 *
 * **選んだ状態で出す**＝画面を開いたときにその行に光が当たっていて、
 * Enter だけで進める。VS Code の選択画面（`showQuickPick`）は、最初の
 * 行に光を当てて開くので、その行を先頭へ移す。ほかの行の並びは変えない。
 *
 * @returns 画面に並べる順の、元の添字
 */
export function orderWithShared(
  choiceCount: number,
  sharedChoice: number | undefined
): number[] {
  const order = Array.from({ length: choiceCount }, (_, index) => index);
  if (
    sharedChoice === undefined ||
    sharedChoice < 0 ||
    sharedChoice >= choiceCount
  ) {
    return order;
  }
  return [sharedChoice, ...order.filter((index) => index !== sharedChoice)];
}

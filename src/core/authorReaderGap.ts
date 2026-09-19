import {
  chatReaderBasis,
  READER_AXIS_ORDER,
  READER_GAP_THRESHOLD,
  READER_TYPES,
  resolveReaderType,
  type ReaderChatSource,
  type ReaderTypeId,
} from "./readerTarget";
import type { AuthorReaderProfile } from "./authorReaderType";
import type { ReaderProfile } from "../models/readerProfile";

/**
 * 作者自身の読者タイプと、その作品のターゲット読者を突き合わせる
 * （設計書6.101、実装の順「2」）。
 *
 * ## 既にある `readerGaps` とは別のズレである
 *
 * あちらは同じ作品の中の「作者の宣言 vs 本文の実像」。こちらは
 * 「**作者自身の読み方 vs この作品の宛先**」で、比べているものが違う。
 * 流用はしないが、**作法は揃える**——2点未満は言わないことと、
 * どちらが正しいとも言わないこと。
 *
 * ## なぜこれが効くのか
 *
 * 「読者が読みたいもの」は作者が直接観測できないので、作者は無意識に
 * **自分の読み癖で代用する**。その代用が何であるかを名指しできれば、
 * ズレがそのまま「作者が気づけない場所」になる。
 *
 * `READER_TYPES` が両方の `works`（効くこと）と `loses`（離れるところ）を
 * 既に持っているので、**突き合わせるだけで具体になる**（抽象論にならない）。
 *
 * ## 絶対に上下を作らない
 *
 * 「あなたの読み癖は的外れ」と読まれたら終わりである。製品は一貫して
 * 上下を作らない書き方をしているので、ここだけ格付けになると壊れる。
 * **「どちらも正しい。効く相手が違うだけ」**の形を崩さない。
 *
 * **決めつけもしない。** 「あなたはこう読む人だから、こう書きがちです」は
 * 一歩で決めつけになる。**読み方の違いを並べるに留める。**
 *
 * ## 文にMarkdownの記号を混ぜない
 *
 * ここで作る行は、ダイアログ（プレーンテキスト）と紙（Markdown）の
 * **両方で同じものを使う**。強調は紙の側の見出しだけで付ける
 * （`plainTextUi.test.ts`）。
 *
 * VS Code APIにも AI にも依存しない。
 */

export type AuthorReaderComparisonKind = "overlap" | "gap";

export interface AuthorReaderComparison {
  /** 重なっているか、離れているか */
  kind: AuthorReaderComparisonKind;
  /** 作者自身の層 */
  authorType: ReaderTypeId;
  /** この作品が向いている層 */
  workType: ReaderTypeId;
  /** 作品側の点数の出どころ（宣言／実像） */
  workSource: ReaderChatSource;
  /** そのまま画面にも紙にも出せる行 */
  lines: string[];
}

/** 作品側の出どころの言い方（作者向けの呼び名） */
const WORK_SOURCE_PHRASES: Record<ReaderChatSource, string> = {
  declared: "向けているつもり",
  actual: "書けているもの",
};

/**
 * 突き合わせる。**材料が無ければ `undefined`**（推測で埋めない）。
 *
 * 黙るのは3つの場合。
 *
 * 1. 作者自身の読者タイプが未診断
 * 2. 作品のターゲットが未診断（宣言も実像も無い）
 * 3. **層の名前は違うが、どの軸も2点未満しか離れていない**——
 *    1点は選択肢1つぶんで、問いの読み方の差で動く。そこを
 *    「ズレています」と言うと、当たらない指摘で信用を失う
 *    （`READER_GAP_THRESHOLD` の考え方をそのまま借りる）
 */
export function compareAuthorReader(
  author: AuthorReaderProfile | undefined,
  work: ReaderProfile | undefined
): AuthorReaderComparison | undefined {
  if (!author) return undefined;
  const basis = chatReaderBasis(work);
  if (!basis) return undefined;

  const authorType = resolveReaderType(author.scores);
  const workType = resolveReaderType(basis.scores);

  if (authorType === workType) {
    return {
      kind: "overlap",
      authorType,
      workType,
      workSource: basis.source,
      lines: overlapLines(authorType),
    };
  }

  const apart = READER_AXIS_ORDER.some(
    (axis) =>
      Math.abs(author.scores[axis] - basis.scores[axis]) >= READER_GAP_THRESHOLD
  );
  if (!apart) return undefined;

  return {
    kind: "gap",
    authorType,
    workType,
    workSource: basis.source,
    lines: gapLines(authorType, workType, basis.source),
  };
}

/**
 * 重なっているときの言い方。
 *
 * **重なっていることも必ず言う。** 珍しくて値打ちのある状態で、
 * 「あなたが読みたいものを書けば当たる」と言える機会は多くない。
 * 黙って飛ばすと、突き合わせたのかどうかも作者に分からない。
 */
function overlapLines(type: ReaderTypeId): string[] {
  const info = READER_TYPES[type];
  return [
    `あなたが読みたいものと、この作品の読者が読みたいものが同じです（どちらも「${info.label}」）。`,
    "あなたの直感がそのまま使えます。読んでいて面白いと思ったところを、そのまま信じてかまいません。",
    `この層に効くのは、${info.works}　離れるのは、${info.loses}`,
  ];
}

/**
 * 離れているときの言い方。
 *
 * **並べるだけにする。** どちらの読み方にも効く相手がいて、
 * 上下は無い。作者の書き方については何も言わない
 * （読み癖から書き方を言い当てにいくと、一歩で決めつけになる）。
 */
function gapLines(
  authorType: ReaderTypeId,
  workType: ReaderTypeId,
  source: ReaderChatSource
): string[] {
  const mine = READER_TYPES[authorType];
  const theirs = READER_TYPES[workType];
  return [
    `あなたは読者としては「${mine.label}」です。あなたに効くのは、${mine.works}`,
    `この作品が向いている「${theirs.label}」に効くのは、${theirs.works}` +
      `　この層が離れるのは、${theirs.loses}`,
    "どちらの読み方も正しく、効く相手が違うだけです。" +
      "読み手としてのあなたの手応えと、この作品の読者の手応えは、別々に動きます。",
    `（この作品の側は「${WORK_SOURCE_PHRASES[source]}」から見ています。` +
      "そちらを答え直したり読み直したりすると、この見方も変わります）",
  ];
}

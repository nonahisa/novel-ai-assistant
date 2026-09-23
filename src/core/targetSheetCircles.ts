import {
  READER_AXIS_LABELS,
  READER_TYPES,
  resolveReaderType,
  type ReaderTypeId,
} from "./readerTarget";
import { compareAuthorReader } from "./authorReaderGap";
import { readerTypeAffinityOf, readerTypeGaps } from "./targetSheet";
import {
  READER_PROFILE_SCHEMA_VERSION,
  type ReaderActual,
  type ReaderScores,
} from "../models/readerProfile";

/**
 * ターゲットシートの中の3つの輪（設計書6.108.6）。
 *
 * 作者の指摘②（2026-09-22 未明）：ターゲット読者診断・ターゲットシート・
 * 3つの輪は統合する。統合した1枚では、3つの輪を
 *
 * | 輪 | 中身 | どこから |
 * |---|---|---|
 * | 書きたいもの | 読者としてのあなた | 作者自身の読者タイプ（6.101の1） |
 * | 読んでもらいたい読者 | 狙い | 「ターゲット読者」の1段目 |
 * | 書けているもの | 本文の実像 | 「ターゲット読者」の3段目（P-38） |
 *
 * で突き合わせる。6.101 の紙（`threeCirclesSheet.ts`）は「読者が読みたい
 * もの」を**宣言の点数**で見ていたが、統合では1段目で聞いた**狙い**が
 * その輪になる（宣言は2段目の「書き方の判断」で、狙いとは別の欄）。
 *
 * ## 物差しを新しく作らない
 *
 * - 作者 ↔ 実像は `compareAuthorReader`（6.101）をそのまま通す
 * - 狙いは点数を持たない（層の名前だけ）ので、**その層の中心**
 *   （`READER_TYPE_CENTERS`）と比べる。ずれの幅は `readerTypeGaps`
 *   （2点未満は言わない）、一致度は `readerTypeAffinityOf`——シートの
 *   「一致とずれ」と同じ道具である
 *
 * ## 上下を作らない・推測で埋めない
 *
 * どの行も「どちらが正しいとも言わない」形で書く。材料の無い輪は
 * 辺ごと出さず、`missing` に**埋め方**を1行で残す。
 *
 * 行にMarkdownの強調を混ぜない（`compareAuthorReader` の行と並べるため。
 * 強調は紙の見出しの側で付ける）。
 *
 * VS Code API にも AI にも依存しない。
 */

export type TargetSheetCircleEdgeKey =
  | "author-aim"
  | "aim-actual"
  | "author-actual";

export interface TargetSheetCircleEdge {
  readonly key: TargetSheetCircleEdgeKey;
  readonly heading: string;
  readonly lines: readonly string[];
  /** 離れているか（2点以上ずれている軸があるか） */
  readonly apart: boolean;
}

export interface TargetSheetCircles {
  readonly edges: readonly TargetSheetCircleEdge[];
  /** 足りない輪と、その埋め方（1行ずつ） */
  readonly missing: readonly string[];
}

export interface TargetSheetCirclesInput {
  /** 作者自身の読者タイプ（6.101の1）。**未診断なら渡さない** */
  readonly authorReader?: { readonly scores: ReaderScores };
  /** 狙い（作者の欄の1行目） */
  readonly aim: readonly ReaderTypeId[];
  /** 本文の実像（3段目）。**宣言では代えない**——輪の中身が違う */
  readonly actual?: ReaderActual;
}

export function targetSheetCircles(
  input: TargetSheetCirclesInput
): TargetSheetCircles {
  const { authorReader, aim, actual } = input;
  const edges: TargetSheetCircleEdge[] = [];
  const missing: string[] = [];

  if (!authorReader) {
    missing.push(
      "書きたいもの（読者としてのあなた）：「あなた自身の読者タイプ」に答えると出ます。"
    );
  }
  if (aim.length === 0) {
    missing.push(
      "読んでもらいたい読者（狙い）：「ターゲット読者」の1段目で選ぶと出ます。"
    );
  }
  if (!actual) {
    missing.push(
      "書けているもの（本文の実像）：「ターゲット読者」の3段目でAIが本文を読むと出ます。"
    );
  }

  if (authorReader) {
    for (const type of aim) edges.push(authorAimEdge(authorReader.scores, type));
  }
  if (actual) {
    for (const type of aim) edges.push(aimActualEdge(type, actual.scores));
  }
  if (authorReader && actual) {
    edges.push(authorActualEdge(authorReader.scores, actual));
  }

  return { edges, missing };
}

/** 書きたいもの ↔ 読んでもらいたい読者 */
function authorAimEdge(
  author: ReaderScores,
  aim: ReaderTypeId
): TargetSheetCircleEdge {
  const authorType = resolveReaderType(author);
  const aimInfo = READER_TYPES[aim];
  const heading = `書きたいもの ↔ 読んでもらいたい読者（${aimInfo.label}）`;

  if (authorType === aim) {
    return {
      key: "author-aim",
      heading,
      apart: false,
      lines: [
        `読者としてのあなたも、狙いの読者も「${aimInfo.label}」で、重なっています。`,
        "あなたが読んで面白いと思うところが、そのまま狙いの読者に効きます。",
      ],
    };
  }

  const gaps = readerTypeGaps(author, aim);
  const authorLabel = READER_TYPES[authorType].label;
  if (gaps.length === 0) {
    return {
      key: "author-aim",
      heading,
      apart: false,
      lines: [
        `読者としてのあなたは「${authorLabel}」、狙いは「${aimInfo.label}」です。` +
          "名前は違いますが、3つの軸はどれも選択肢1つぶんしか離れていません。",
        "この幅は問いの読み方でも動くので、離れているとは見ていません。",
      ],
    };
  }

  return {
    key: "author-aim",
    heading,
    apart: true,
    lines: [
      `読者としてのあなたは「${authorLabel}」、狙いは「${aimInfo.label}」です。`,
      ...gaps.map(
        (gap) =>
          `- ${READER_AXIS_LABELS[gap.axis]}：あなたは${gap.scored}、` +
          `狙いの層の中心は${gap.center}。`
      ),
      "どちらが正しいとも言いません。あなたが読んで面白いところと、" +
        "狙いの読者に効くところが、別の場所になりやすいというだけです。",
      `狙いの読者に効くのは、${aimInfo.works}`,
    ],
  };
}

/** 読んでもらいたい読者 ↔ 書けているもの */
function aimActualEdge(
  aim: ReaderTypeId,
  actual: ReaderScores
): TargetSheetCircleEdge {
  const aimInfo = READER_TYPES[aim];
  const actualType = resolveReaderType(actual);
  const affinity = readerTypeAffinityOf(actual, aim);
  const heading = `読んでもらいたい読者（${aimInfo.label}） ↔ 書けているもの`;

  if (actualType === aim) {
    return {
      key: "aim-actual",
      heading,
      apart: false,
      lines: [
        `書けているものは、狙いの「${aimInfo.label}」にいちばん近い位置にあります（一致度 ${affinity}）。`,
      ],
    };
  }

  const gaps = readerTypeGaps(actual, aim);
  return {
    key: "aim-actual",
    heading,
    apart: gaps.length > 0,
    lines: [
      `狙いの「${aimInfo.label}」との一致度 ${affinity}。` +
        `書けているものにいちばん近いのは「${READER_TYPES[actualType].label}」です。`,
      gaps.length > 0
        ? "どの軸がずれているかは、上の「一致とずれ」にあります。"
        : "3つの軸はどれも選択肢1つぶんしか離れていません。",
    ],
  };
}

/** 書きたいもの ↔ 書けているもの（6.101 の突き合わせをそのまま使う） */
function authorActualEdge(
  author: ReaderScores,
  actual: ReaderActual
): TargetSheetCircleEdge {
  const heading = "書きたいもの ↔ 書けているもの";
  /*
    `compareAuthorReader` は宣言を優先して読む（`chatReaderBasis`）。
    **実像だけを入れた台帳**を渡す——宣言が混ざると、この辺が
    「書きたいもの ↔ 向けているつもり」にすり替わる（`threeCirclesSheet.ts`
    の `actualOnly` と同じ理由）。
  */
  // 突き合わせが見るのは点数だけ（出どころと日時は使わない）
  const comparison = compareAuthorReader(
    { scores: author, source: "diagnosis", updatedAt: "" },
    { schemaVersion: READER_PROFILE_SCHEMA_VERSION, actual }
  );
  if (comparison) {
    return {
      key: "author-actual",
      heading,
      apart: comparison.kind === "gap",
      lines: comparison.lines,
    };
  }

  const authorLabel = READER_TYPES[resolveReaderType(author)].label;
  const actualLabel = READER_TYPES[resolveReaderType(actual.scores)].label;
  return {
    key: "author-actual",
    heading,
    apart: false,
    lines: [
      `読者としてのあなたは「${authorLabel}」、書けているものの向き先は「${actualLabel}」です。` +
        "名前は違いますが、3つの軸はどれも選択肢1つぶんしか離れていません。",
      "この幅は問いの読み方でも動くので、離れているとは見ていません。",
    ],
  };
}

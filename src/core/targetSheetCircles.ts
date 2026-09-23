import {
  READER_AXIS_LABELS,
  READER_TYPES,
  resolveReaderType,
  type ReaderTypeId,
} from "./readerTarget";
import { compareAuthorReader } from "./authorReaderGap";
import { neighborToward, readerTypeNeighbors } from "./readerTypeNeighbors";
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
 * で突き合わせる。6.101 の紙（0.82.2 まで在った単独の3つの輪の紙）は
 * 「読者が読みたいもの」を**宣言の点数**で見ていたが、統合では1段目で聞いた
 * **狙い**がその輪になる（宣言は2段目の「書き方の判断」で、狙いとは別の欄）。
 *
 * **3つの輪はこの節だけになった**（作者の裁定、2026-09-23「ターゲット
 * シートと3つの輪は完全統合」）。単独の紙を作る道は無くした。
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
  /**
   * 近づける道。**出す条件を満たさなければ `undefined`**
   * （`needsBridge`。紙の側は節ごと出さない）。
   */
  readonly bridge?: TargetSheetBridge;
}

/** 近づける道の1つ（どの輪を動かすか） */
export interface TargetSheetBridgeRoute {
  /** 動かす輪。aim＝読んでもらいたい読者、actual＝書けているもの、author＝書きたいもの */
  readonly circle: "aim" | "actual" | "author";
  /** 「読んでもらいたい読者を動かす（狙いを寄せる）」など。強調は紙の側で付ける */
  readonly label: string;
  readonly text: string;
}

export interface TargetSheetBridge {
  /** 突き合わせられた辺の数（どれも離れている） */
  readonly edgeCount: number;
  readonly routes: readonly TargetSheetBridgeRoute[];
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

  const bridge = needsBridge(edges)
    ? targetSheetBridge(input, edges.length)
    : undefined;
  return bridge ? { edges, missing, bridge } : { edges, missing };
}

/**
 * 「近づける道」を出す条件（設計書6.101、実装の順「4」。6.108.6 でシートへ移した）。
 *
 * **突き合わせられた辺が2本以上あり、そのすべてが離れているとき。**
 * 1本しか出せないときは出さない——**「重なりが空」と言い切れない**
 * からである。1本の食い違いだけで3つの輪の置き直しを勧めるのは、
 * 判定として重すぎる。
 *
 * 狙いが2つのときも同じ物差しで見る。片方の狙いで1本でも重なって
 * いれば、重なりは空ではない（その狙いが重なりの場所である）。
 */
export const TARGET_SHEET_BRIDGE_MIN_EDGES = 2;

export function needsBridge(edges: readonly TargetSheetCircleEdge[]): boolean {
  return (
    edges.length >= TARGET_SHEET_BRIDGE_MIN_EDGES &&
    edges.every((edge) => edge.apart)
  );
}

/**
 * 近づける道（0.82.2 まで在った単独の3つの輪の紙から移した。
 * 作者の裁定、2026-09-23）。
 *
 * **「重なっていません」とは書かない**（作者の裁定、2026-09-19）。
 * 空だと告げるのは酷だが、重なっていないのに「ここが狙い目」と言うのは
 * 嘘である。**判定ではなく手段を渡す形**なら、どちらも避けられる。
 *
 * 前の紙は「読者が読みたいもの」を**宣言の点数**で見ていたが、シートでは
 * その輪が**狙い**になった（冒頭の表）。道の組み方は同じで、宛先を狙いに
 * 置き換えてある。狙いが2つなら狙いごとに道を出し、輪の種類の順に並べる。
 *
 * **名指しできない手段は、その項目ごと落とす。** 材料が無いまま
 * 「隣へ寄せましょう」とだけ言っても、どこへ寄せるのか分からない。
 */
function targetSheetBridge(
  input: TargetSheetCirclesInput,
  edgeCount: number
): TargetSheetBridge | undefined {
  const authorType = input.authorReader
    ? resolveReaderType(input.authorReader.scores)
    : undefined;
  const actualType = input.actual
    ? resolveReaderType(input.actual.scores)
    : undefined;

  const aimRoutes: TargetSheetBridgeRoute[] = [];
  const actualRoutes: TargetSheetBridgeRoute[] = [];
  const authorRoutes: TargetSheetBridgeRoute[] = [];

  for (const aim of input.aim) {
    const aimInfo = READER_TYPES[aim];

    // ① 読んでもらいたい読者を動かす（狙いを寄せる）
    const neighbors = readerTypeNeighbors(aim);
    if (authorType && neighbors.length > 0) {
      const names = neighbors
        .map((id) => `「${READER_TYPES[id].label}」`)
        .join("・");
      const nearest = neighborToward(aim, authorType);
      const detail = nearest
        ? `そのうち、読者としてのあなた（「${READER_TYPES[authorType].label}」）に` +
          `いちばん近いのは「${READER_TYPES[nearest].label}」です。` +
          `この層に効くのは、${READER_TYPES[nearest].works}`
        : "";
      aimRoutes.push({
        circle: "aim",
        label: "読んでもらいたい読者を動かす（狙いを寄せる）",
        text: `いまの狙い「${aimInfo.label}」の隣は、${names}です。${detail}`,
      });
    }

    // ② 書けているものを動かす（書ける範囲を広げる）。**いきなり飛ばさない**
    const step = actualType ? neighborToward(actualType, aim) : undefined;
    if (actualType && step) {
      // 狙いがすでに隣にあるなら一歩で着く（「狙いへいきなり寄せず、
      // 隣の狙いまで一歩」という、同じ層を2度呼ぶ言い方にしない）
      const how =
        step === aim
          ? `狙いの「${aimInfo.label}」は、その隣です。一歩で届きます。`
          : `狙いの「${aimInfo.label}」へいきなり寄せず、` +
            `隣の「${READER_TYPES[step].label}」まで一歩。`;
      actualRoutes.push({
        circle: "actual",
        label: "書けているものを動かす（書ける範囲を広げる）",
        text:
          `書けているものは「${READER_TYPES[actualType].label}」に向いています。${how}` +
          `この層に効くのは、${READER_TYPES[step].works}`,
      });
    }

    // ③ 書きたいものを動かす（題材を選び直す）
    authorRoutes.push({
      circle: "author",
      label: "書きたいものを動かす（題材を選び直す）",
      text:
        `狙いの「${aimInfo.label}」に効くのは、${aimInfo.works}` +
        `　離れるのは、${aimInfo.loses}` +
        "　書きたいものの中で、これに当たる題材を選び直す道があります。",
    });
  }

  const routes = [...aimRoutes, ...actualRoutes, ...authorRoutes];
  return routes.length === 0 ? undefined : { edgeCount, routes };
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
    「書きたいもの ↔ 向けているつもり」にすり替わる（かつての単独の
    3つの輪の紙が `actualOnly` で避けていたのと同じ理由）。
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

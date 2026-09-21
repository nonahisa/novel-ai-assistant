import {
  READER_AXIS_ENDS,
  READER_AXIS_LABELS,
  READER_AXIS_ORDER,
  READER_GAP_THRESHOLD,
  READER_QUESTIONS,
  READER_TYPES,
  READER_TYPE_TABLE,
  resolveReaderType,
  type ReaderAxis,
  type ReaderTypeId,
} from "./readerTarget";
import { READER_TYPE_IDS, readerTypeNeighbors } from "./readerTypeNeighbors";
import { threeAxisLevel, type ThreeAxisLevel } from "./threeAxis";
import type { ReaderScores } from "../models/readerProfile";

/**
 * ターゲットシート——狙いと実態を突き合わせる（設計書6.108、第1段と第2段）。
 *
 * 作者の言葉（2026-09-21）：「作者が希望するターゲット層と作品を分析して
 * 一致やズレを判定し、アドバイスができるターゲットシートみたいなものが
 * あれば良いですね。各読者層との一致度、読者層の拡大や収束の方向性も
 * あるといいですね」。
 *
 * ## AI に数字を言わせない（実装ルール3）
 *
 * 一致度は**点数から機械で出す**。AI に「何%くらいですか」と聞くと
 * 同じ作品で毎回違う数字が返り、作者が前回と比べられない。点数は既に
 * ターゲット読者診断（6.91）が持っているので、ここは計算するだけである。
 *
 * ## 一致度は「段階」で測る（低・中・高）
 *
 * 11型の中心までの距離で出すのだが、**点数（0〜6）のままでは測れない。**
 * 型を決めているのは `resolveReaderType` で、それは点数そのものではなく
 * **段階**（低0〜1／中2〜4／高5〜6）を見ているからである。点数の距離で
 * 測ると、たとえば（読み慣れ1・読む姿勢1・求めるもの2）は原点にいちばん
 * 近いので「すきま層」がいちばん高くなるが、診断の答えは「刺激層」である
 * ——**シートの表といちばん上の行が食い違う。**
 *
 * 段階で測れば食い違わない。343通り（7×7×7）すべてで、
 * **`resolveReaderType` が返す型の一致度が最大になる**ことを
 * `targetSheet.test.ts` が総当たりで見張っている。
 *
 * そのぶん一致度は**7段階**（100・83・67・50・33・17・0）しか取らない。
 * これは粗さではなく**歯止め**である——1問の答え方の差で順位が入れ替わる
 * 数字を出すと、当たらない指摘になる（`READER_GAP_THRESHOLD` が2点未満を
 * 言わないのと同じ考え方）。
 *
 * ## 表を2つ持たない
 *
 * 11型の中心は `READER_TYPE_TABLE`（主軸と副軸の組み合わせ）から**導く**。
 * 手書きの中心の一覧をもう1つ置くと、軸の組み合わせを変えたときに片方だけ
 * 直る日が来る（`readerTypeNeighbors.ts` が隣り合いを導いているのと同じ）。
 *
 * VS Code API にも AI にも依存しない。
 */

/** 中心の点数。**主軸＝上限・副軸＝中ほど・残り＝下限** */
const CENTER_HIGH = 6;
const CENTER_MID = 3;
const CENTER_LOW = 0;

/** 段階の重み。距離を測るためだけの数 */
const LEVEL_RANK: Record<ThreeAxisLevel, number> = { low: 0, mid: 1, high: 2 };

/**
 * 11型の中心（軸の空間での位置）。
 *
 * - 主軸と副軸を持つ型：主軸＝6・副軸＝3・残り＝0
 * - **すきま層は全部0**（どの軸も立っていない）
 * - **雑食層は全部3**（どの軸も中ほど）。`resolveReaderType` が雑食層を
 *   返すのは3軸がそろって「中」のときだけなので、**上限ではなく中ほど**である
 *
 * 中心そのものを `resolveReaderType` に掛けると、必ずその型が返る
 * （テストで見張っている）。**中心が型の外にあると、一致度100の点が
 * 別の型に分類される**という、説明のつかない状態になる。
 */
export const READER_TYPE_CENTERS: Readonly<Record<ReaderTypeId, ReaderScores>> =
  (() => {
    const centers = {} as Record<ReaderTypeId, ReaderScores>;

    for (const [key, typeId] of Object.entries(READER_TYPE_TABLE)) {
      const [mainKey, subKey] = key.split(":");
      const scores = {} as ReaderScores;
      for (const axis of READER_AXIS_ORDER) {
        // 副軸が無い型の鍵は `...:none` で、軸の名前と一致しない。
        // そのまま比べれば、残りの軸と同じ「下限」に落ちる
        scores[axis] =
          axis === mainKey
            ? CENTER_HIGH
            : axis === subKey
              ? CENTER_MID
              : CENTER_LOW;
      }
      centers[typeId] = scores;
    }

    centers.light = flatScores(CENTER_LOW);
    centers.omnivore = flatScores(CENTER_MID);
    return centers;
  })();

function flatScores(value: number): ReaderScores {
  const scores = {} as ReaderScores;
  for (const axis of READER_AXIS_ORDER) scores[axis] = value;
  return scores;
}

/** 段階の差の和で測れる、いちばん遠い距離（軸3本 × 段階2つぶん） */
const MAX_DISTANCE = READER_AXIS_ORDER.length * 2;

function levelRank(score: number): number {
  return LEVEL_RANK[threeAxisLevel(score)];
}

/**
 * 1つの型との一致度（0〜100の整数）。
 *
 * 軸ごとに段階の差の絶対値を足し、いちばん遠い距離（6）で割って裏返す。
 * **中心と同じ段階なら100**、3軸とも正反対の端なら0。
 */
export function readerTypeAffinityOf(
  scores: ReaderScores,
  type: ReaderTypeId
): number {
  const center = READER_TYPE_CENTERS[type];
  const distance = READER_AXIS_ORDER.reduce(
    (total, axis) =>
      total + Math.abs(levelRank(scores[axis]) - levelRank(center[axis])),
    0
  );
  return Math.round((100 * (MAX_DISTANCE - distance)) / MAX_DISTANCE);
}

/** 11型すべての一致度 */
export function readerTypeAffinity(
  scores: ReaderScores
): Record<ReaderTypeId, number> {
  const found = {} as Record<ReaderTypeId, number>;
  for (const type of READER_TYPE_IDS) {
    found[type] = readerTypeAffinityOf(scores, type);
  }
  return found;
}

export interface ReaderTypeAffinityEntry {
  readonly type: ReaderTypeId;
  readonly affinity: number;
}

/**
 * 一致度の高い順。**同率は `READER_TYPE_IDS` の並び**で決める。
 *
 * 一致度は7段階しか取らないので同率がよく出る。並べ直すたびに順が
 * 変わると、作者が前回のシートと見比べられない。
 */
export function rankReaderTypes(
  scores: ReaderScores
): ReaderTypeAffinityEntry[] {
  const affinity = readerTypeAffinity(scores);
  return [...READER_TYPE_IDS]
    .map((type) => ({ type, affinity: affinity[type] }))
    .sort(
      (left, right) =>
        right.affinity - left.affinity ||
        READER_TYPE_IDS.indexOf(left.type) - READER_TYPE_IDS.indexOf(right.type)
    );
}

/** 型の中心から、軸1本ぶん離れていること */
export interface TargetSheetGap {
  readonly axis: ReaderAxis;
  /** いまの点 */
  readonly scored: number;
  /** その型の中心の点 */
  readonly center: number;
  /** いま − 中心。正なら「その型より上に寄っている」 */
  readonly diff: number;
}

/**
 * ある型の中心とのずれ。**幅の大きい順**に返す。
 *
 * **2点未満は言わない**（`READER_GAP_THRESHOLD`）。1点は選択肢1つぶんで、
 * 問いの読み方の差で動く。そこを「ずれています」と言うと、当たらない
 * 指摘で信用を失う——6.101（`authorReaderGap.ts`）と同じ流儀である。
 */
export function readerTypeGaps(
  scores: ReaderScores,
  type: ReaderTypeId
): TargetSheetGap[] {
  const center = READER_TYPE_CENTERS[type];
  return READER_AXIS_ORDER.map((axis) => ({
    axis,
    scored: scores[axis],
    center: center[axis],
    diff: scores[axis] - center[axis],
  }))
    .filter((gap) => Math.abs(gap.diff) >= READER_GAP_THRESHOLD)
    .sort((left, right) => Math.abs(right.diff) - Math.abs(left.diff));
}

/** 軸を1本、どちらへ動かすか */
export interface ReaderAxisMove {
  readonly axis: ReaderAxis;
  /** いまの点 */
  readonly from: number;
  /** 行き先の点（その型の中心） */
  readonly to: number;
  readonly direction: "up" | "down";
  /** そのまま画面にも紙にも出せる一行 */
  readonly summary: string;
  /**
   * 具体の手。**診断の設問の選択肢をそのまま引く**（写しを書かない）。
   * 「1話の長さを短く」のような言い方は、もともと設問の側にある。
   */
  readonly examples: readonly string[];
}

function axisMove(gap: TargetSheetGap): ReaderAxisMove {
  // 中心より上にいるなら下げる。下にいるなら上げる
  const direction = gap.diff > 0 ? "down" : "up";
  const ends = READER_AXIS_ENDS[gap.axis];
  const toward = direction === "up" ? ends.high : ends.low;
  const wanted = direction === "up" ? 2 : 0;

  return {
    axis: gap.axis,
    from: gap.scored,
    to: gap.center,
    direction,
    summary:
      `${READER_AXIS_LABELS[gap.axis]}を` +
      `${direction === "up" ? "上げる" : "下げる"}` +
      `（${gap.scored} → ${gap.center}）。「${toward}」の側へ寄せます。`,
    examples: READER_QUESTIONS.filter(
      (question) => question.axis === gap.axis
    ).flatMap((question) => {
      const choice = question.choices.find((entry) => entry.score === wanted);
      return choice ? [choice.label] : [];
    }),
  };
}

export type TargetSheetDirectionKind = "expand" | "converge";

/** 向かう先ひとつ（拡大か収束か） */
export interface TargetSheetDirection {
  readonly kind: TargetSheetDirectionKind;
  /** どの型へ向かうか */
  readonly toward: ReaderTypeId;
  /**
   * 動かす軸。**多くても1本**（設計書6.108.3）。
   *
   * 3本同時に動かす助言は、作品を別物にしてしまう。
   */
  readonly move?: ReaderAxisMove;
  /** 動かす軸が無かったときの理由。**黙って空欄にしない** */
  readonly note?: string;
}

/** 狙いの型ひとつぶんの突き合わせ */
export interface TargetSheetAim {
  readonly type: ReaderTypeId;
  readonly affinity: number;
  /** いちばん高い型と同じか */
  readonly isTop: boolean;
  /** ずれている軸（2点以上） */
  readonly gaps: readonly TargetSheetGap[];
}

/** 実態の欄。**点数が無ければ、この欄ごと出さない** */
export interface TargetSheetActual {
  readonly scores: ReaderScores;
  /**
   * いちばん高い型。
   *
   * **`resolveReaderType` の答えをそのまま使う。** 一致度から選び直すと、
   * 同率のときに診断と違う型が出かねない（診断が本家である）。
   */
  readonly top: ReaderTypeId;
  /** 11型の一致度（高い順） */
  readonly ranking: readonly ReaderTypeAffinityEntry[];
}

export interface TargetSheetInput {
  /** 作者が狙う読者型（0〜2つ）。**作者の欄から読む。診断は上書きしない** */
  readonly aim: readonly ReaderTypeId[];
  /** 診断の点数。**無ければ実態の欄は空**（推測で埋めない） */
  readonly scores?: ReaderScores;
}

export interface TargetSheet {
  readonly aim: readonly ReaderTypeId[];
  readonly actual?: TargetSheetActual;
  readonly aims: readonly TargetSheetAim[];
  /** 拡大——いまの読者を保ったまま、隣の型も取る */
  readonly expand?: TargetSheetDirection;
  /** 収束——狙いの型へ寄せる */
  readonly converge?: TargetSheetDirection;
}

/**
 * シートの中身を組む。**AI を1度も呼ばない。**
 *
 * 点数が無ければ、実態・一致・向かう先はまるごと空になる（狙いだけが
 * 残る）。**「まだ測っていない」と「一致度0」は別物**なので、
 * 0で埋めない。
 */
export function targetSheetFor(input: TargetSheetInput): TargetSheet {
  // 同じ型を2度書かれても1つに畳む（作者が手で書く欄から来るため）
  const aim = [...new Set(input.aim)];
  const { scores } = input;
  if (!scores) return { aim, aims: [] };

  const top = resolveReaderType(scores);
  const ranking = rankReaderTypes(scores);
  const affinity = readerTypeAffinity(scores);

  const aims = aim.map((type) => ({
    type,
    affinity: affinity[type],
    isTop: type === top,
    gaps: readerTypeGaps(scores, type),
  }));

  return {
    aim,
    actual: { scores, top, ranking },
    aims,
    expand: expandDirection(scores, top),
    converge: convergeDirection(scores, convergeTarget(aims, top), top),
  };
}

/**
 * 収束の行き先を、狙いの中から1つ選ぶ。
 *
 * **一致度がいちばん低い狙い**を採る（同率なら作者が先に書いたほう）。
 * 狙いを2つ書ける以上、片方はもう届いていることがある——そちらへ
 * 「寄せましょう」と言っても空振りで、**まだ届いていない狙いこそが、
 * 絞るという言葉の中身**である。
 *
 * 狙いが無ければ、いちばん高い型そのもの（＝動かす必要が無いので、
 * 「すでに寄っています」と出る）。
 */
function convergeTarget(
  aims: readonly TargetSheetAim[],
  top: ReaderTypeId
): ReaderTypeId {
  if (aims.length === 0) return top;
  return aims.reduce((lowest, aim) =>
    aim.affinity < lowest.affinity ? aim : lowest
  ).type;
}

/**
 * 拡大の向かう先。
 *
 * **隣（`readerTypeNeighbors`）のうち、一致度がいちばん高いものを採る。**
 *
 * 「2番目に高い型」をそのまま採らないのは、11型を一致度だけで並べると、
 * **軸を1本動かしても着かない型が2番目に来ることがある**ためである
 * （343通りのうち8通りで実際に起きる。たとえば読み慣れ5・読む姿勢2・
 * 求めるもの6 のとき、2番目は「常連層」だが、そこは隣ではない）。
 * 隣り合いの定義は6.101が既に持っているので、そちらへ預ける。
 *
 * 動かす軸は、**差がいちばん小さいもの**を1本。いまの読者を保ったまま
 * 隣も取るのだから、いちばん安い一歩を選ぶ。
 */
function expandDirection(
  scores: ReaderScores,
  top: ReaderTypeId
): TargetSheetDirection {
  const affinity = readerTypeAffinity(scores);
  const neighbors = readerTypeNeighbors(top);
  const toward = [...neighbors].sort(
    (left, right) =>
      affinity[right] - affinity[left] ||
      READER_TYPE_IDS.indexOf(left) - READER_TYPE_IDS.indexOf(right)
  )[0];

  if (!toward) {
    return {
      kind: "expand",
      toward: top,
      note: `「${READER_TYPES[top].label}」の隣が見つかりませんでした。`,
    };
  }

  const gaps = readerTypeGaps(scores, toward);
  if (gaps.length === 0) {
    return {
      kind: "expand",
      toward,
      note:
        `「${READER_TYPES[toward].label}」とは、どの軸も${READER_GAP_THRESHOLD}点未満しか違いません。` +
        "動かさなくても届く位置にいます。",
    };
  }

  // 幅の小さい順に見たいので、いちばん後ろ（`readerTypeGaps` は大きい順）
  return { kind: "expand", toward, move: axisMove(gaps[gaps.length - 1]) };
}

/**
 * 収束の向かう先。
 *
 * 狙いの型（無ければいちばん高い型）との差が**いちばん大きい軸**を1本。
 * 寄せるのだから、いちばん離れているところから直す。
 */
function convergeDirection(
  scores: ReaderScores,
  toward: ReaderTypeId,
  top: ReaderTypeId
): TargetSheetDirection {
  const gaps = readerTypeGaps(scores, toward);
  if (gaps.length === 0) {
    return {
      kind: "converge",
      toward,
      note:
        toward === top
          ? `いまの「${READER_TYPES[toward].label}」に、すでに寄っています。`
          : `「${READER_TYPES[toward].label}」とは、どの軸も${READER_GAP_THRESHOLD}点未満しか違いません。`,
    };
  }
  return { kind: "converge", toward, move: axisMove(gaps[0]) };
}

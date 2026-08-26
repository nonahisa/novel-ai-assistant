import type { Character } from "../models/character";
import type { RecordChange } from "../models/jsonValidation";
import { changedFields, changesOfField, sortChanges } from "./recordChanges";

/**
 * 作中での変化が、物語の筋にどれだけ食い込んでいるかを数値にする（設計書6.18）。
 *
 * **なぜ数値が要るのか。** 紹介（`summary`）は一覧で名前の下に並ぶ短い1行で、
 * 80字しかない。変化の記録には「課長になった」も「髪を切った」も同じ形で並ぶので、
 * そのまま材料として渡すと、AIは書きやすいほう（外見）から埋める。
 * **紙幅を何に使うかを、AIに渡す前にコード側で決める。**
 *
 * **判定はコードで行い、AIにはさせない。** 変化の記録そのものが「AIには書かせない」
 * ものであり（`RecordChange` の注釈）、その重み付けまでAIに任せると、
 * 同じ人物でも呼ぶたびに紹介の中身が変わる。同じ入力なら同じ点になるようにしてある。
 *
 * **測っているのは「関与度」であって「重要度」ではない。** 作者にとって大事な変化を
 * 機械が決めることはできない。ここで測るのは「物語の筋（誰が何者で、どう変わったか）に
 * どれだけ食い込む項目か」だけである。**低いと判定した変化も、資料の「変化」欄には
 * 今までどおり全部載る。紹介に書かないだけである。**
 */

export type InvolvementLevel = "high" | "medium" | "low";

export const INVOLVEMENT_LABELS: Record<InvolvementLevel, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

/** これ以上なら紹介に必ず書く */
export const HIGH_INVOLVEMENT = 60;
/** これ以上なら、字数が余ったときに書く */
export const MEDIUM_INVOLVEMENT = 35;

export interface ChangeSignificance {
  /** どの項目の変化か（"appearance" など） */
  field: string;
  /** 0〜100。大きいほど物語の筋に関わる */
  score: number;
  level: InvolvementLevel;
  /** 点の内訳。作者に「なぜその点なのか」を示せるように残す */
  reasons: string[];
}

/**
 * 項目ごとの基礎点。
 *
 * **順番の根拠は「その項目が変わると、話の筋が動くか」である。**
 *   - 役割・所属・性別が変われば、その人物の立ち位置そのものが変わる。
 *     性別を高く置くのは、この作者の作品に転生・転性があるためで
 *     （`world_012_転生と転性`）、起きたときは筋の中心にある
 *   - 性格の変化は物語の芯だが、AIの言い換えでも動きやすい。中ほどに置く
 *   - 外見は「髪を切った」で動く。読者に見える変化だが、筋には関わらないことが多い
 *   - 紹介（summary）は紹介そのものなので0。紹介に「紹介が変わった」とは書けない
 *   - 読み仮名は作中で変わらない項目（`recordChanges.ts` の `UNCHANGING_FIELDS`）。
 *     違う値が出たらAIの読み違いなので、紹介へ持ち込まない
 */
const FIELD_WEIGHTS: Record<string, number> = {
  role: 55,
  gender: 50,
  affiliation: 50,
  personality: 35,
  appearance: 20,
  summary: 0,
  reading: 0,
};

/**
 * 表に無い項目の点。
 *
 * 作者が足した項目（`custom_fields.json`）が変化として記録されうる。
 * 何が来るか分からないので、真ん中より少し下に置く——
 * 高く置くと知らない項目が紹介を占め、0に置くと作者が足した項目だけが
 * 黙って無視される。
 */
const DEFAULT_WEIGHT = 30;

/** その項目の変化が、物語にどれだけ関わるか */
export function scoreFieldChange(
  changes: readonly RecordChange[],
  field: string,
  appearedChapters: readonly number[] = []
): ChangeSignificance {
  const entries = changesOfField([...changes], field);
  const weight = FIELD_WEIGHTS[field] ?? DEFAULT_WEIGHT;

  // 0の項目は、何段変わっていても紹介には書かない。
  // 加点で押し上げられないよう、ここで打ち切る
  if (weight === 0) {
    return {
      field,
      score: 0,
      level: "low",
      reasons: [
        field === "summary"
          ? "紹介そのものの変化なので、紹介には書かない"
          : "作中で変わらない項目なので、紹介には書かない",
      ],
    };
  }

  const reasons = [`項目「${field}」の基礎点 ${weight}`];
  let score = weight;

  // **作者が手をかけた変化は上げる。** 食い違いを自分で昇格させた、
  // あるいは補足を書いたということは、作者がその変化を見て
  // 「これは作中で起きたことだ」と判断している
  if (hasAuthorTouch(entries)) {
    score += 20;
    reasons.push("作者が確定させた、または補足を書いている +20");
  }

  // 何度も変わっている項目は、その人物を語るうえで外せない
  const steps = Math.min((entries.length - 2) * 5, 10);
  if (steps > 0) {
    score += steps;
    reasons.push(`${entries.length}段に変わっている +${steps}`);
  }

  const settlement = settlementPoints(entries, appearedChapters);
  if (settlement.points > 0) {
    score += settlement.points;
    reasons.push(`${settlement.reason} +${settlement.points}`);
  }

  const capped = Math.min(score, 100);
  return { field, score: capped, level: levelOf(capped), reasons };
}

/**
 * 変化のある項目を、関与度の高い順に並べて返す。
 *
 * **並べ替えるのは、AIが先に読んだものを重く扱うためである。**
 * 材料の順番がそのまま紹介の書き出しに出る。
 */
export function scoreChanges(
  changes: readonly RecordChange[],
  appearedChapters: readonly number[] = []
): ChangeSignificance[] {
  return changedFields([...changes])
    .map((field) => scoreFieldChange(changes, field, appearedChapters))
    .sort((left, right) => right.score - left.score || left.field.localeCompare(right.field));
}

/** 人物の変化を関与度の高い順に返す */
export function scoreCharacterChanges(
  character: Character
): ChangeSignificance[] {
  return scoreChanges(character.changes, character.appearedChapters);
}

/** 「関与度 65（高）」。画面にもAIへの材料にも、同じ書き方で出す */
export function describeInvolvement(significance: ChangeSignificance): string {
  return `関与度 ${significance.score}（${INVOLVEMENT_LABELS[significance.level]}）`;
}

function levelOf(score: number): InvolvementLevel {
  if (score >= HIGH_INVOLVEMENT) return "high";
  if (score >= MEDIUM_INVOLVEMENT) return "medium";
  return "low";
}

function hasAuthorTouch(entries: readonly RecordChange[]): boolean {
  return entries.some(
    (entry) => entry.source === "author" || Boolean(entry.note?.trim())
  );
}

/**
 * 変化した後の姿が、作中に根を張っているか。
 *
 * **1話だけの変化は、その場限りかもしれない**（変装、一時的な立場）。
 * 2話以上に渡って書かれていれば、それがその人物の「今」である。
 *
 * 最新の登場話で変わったばかりのものは、まだ2話ぶん書かれていない。
 * これを0にすると、いま起きたばかりの変化が紹介から落ちるので、半分だけ足す。
 */
function settlementPoints(
  entries: readonly RecordChange[],
  appearedChapters: readonly number[]
): { points: number; reason: string } {
  const latest = sortChanges([...entries]).at(-1);
  if (!latest) return { points: 0, reason: "" };

  if (latest.chapters.length >= 2) {
    return { points: 10, reason: "変化した後の姿が2話以上続いている" };
  }

  const lastAppeared =
    appearedChapters.length > 0 ? Math.max(...appearedChapters) : undefined;
  if (
    lastAppeared !== undefined &&
    latest.chapters.length === 1 &&
    latest.chapters[0] === lastAppeared
  ) {
    return { points: 5, reason: "いちばん新しい登場話で変わったばかり" };
  }

  return { points: 0, reason: "" };
}

/**
 * AIが材料の注釈を、そのまま値として書き写してきたときに落とす。
 *
 * **この作品で繰り返し起きている失敗である。** プロンプトに書いた指示語が
 * そのまま答えの中身として返ってくる（`"suggestion": "空文字"`、
 * `"category": "人物|状態|時系列"`。`placeholderText.ts`）。
 * 関与度は材料の側に［関与度 65（高）］の形で書いてあるので、
 * 紹介の末尾に付いて返る可能性がある。**紹介は資料にそのまま載るので、
 * 書き込む手前で必ず落とす。**
 */
export function stripInvolvementNote(value: string): string {
  return value
    .replace(/[［[]\s*関与度[^］\]]*[］\]]/gu, "")
    .replace(/（?\s*関与度\s*\d+\s*(?:[（(][高中低][）)])?\s*）?/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

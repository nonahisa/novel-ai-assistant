/**
 * 作品の形式（設計書6.4.4）。
 *
 * 短編と大長編では、プロットに書くべきことも、あらすじの作り方も、
 * 話数の扱いも違う。**同じ「作品」として一括りにすると、
 * どの機能も長編向けの前提で動く。**
 *
 * ここでは形式を**名前として持つだけ**にしてある。機能の分岐は
 * まだ入れていない（引継ぎ書に残した）。先に作者が書けるようにする。
 *
 * VS Code APIに依存しない。
 */

export type WorkFormatKey =
  | "short"
  | "shortCollection"
  | "long"
  | "epic"
  | "sns";

export interface WorkFormatDef {
  key: WorkFormatKey;
  /** プロットに書く名前。これがそのまま `## 形式` の中身になる */
  label: string;
  /** 選ぶときの説明 */
  description: string;
  /**
   * 目安の字数の下限。**決まりではない。**
   * 作者へ「いまの字数ならこれでは」と勧めるためだけに使う
   */
  fromChars?: number;
}

/** この順に選択肢へ出す */
export const WORK_FORMATS: readonly WorkFormatDef[] = [
  {
    key: "short",
    label: "短編",
    description: "1話で完結する作品",
    fromChars: 0,
  },
  {
    key: "shortCollection",
    label: "短編集",
    description: "独立した短編を1つの作品としてまとめたもの。話どうしが続かない",
  },
  {
    key: "long",
    label: "長編",
    description: "続きもの。話を追って読む",
    fromChars: 30_000,
  },
  {
    key: "epic",
    label: "大長編",
    description: "長期の連載。登場人物も舞台も増え続ける",
    fromChars: 300_000,
  },
  {
    key: "sns",
    label: "SNS記事",
    description:
      "同じアカウントの投稿を1つのフォルダーにまとめたもの。" +
      "話数ではなく投稿の並びとして扱う",
  },
];

export function workFormatLabels(): string[] {
  return WORK_FORMATS.map((format) => format.label);
}

/**
 * いまの分量から、当てはまりそうな形式を1つ挙げる。
 *
 * **決めつけない。** 選択肢の既定として出すだけで、作者が選び直せる。
 * 短編集とSNS記事は分量から判らない（短編集は短編と、SNS記事は
 * どの形式とも字数で区別が付かない）ので、ここからは出さない。
 */
export function suggestWorkFormat(
  totalChars: number,
  episodeCount: number
): WorkFormatDef {
  // 1話しかないなら、字数が多くても短編と見るのが自然
  if (episodeCount <= 1) return byKey("short");

  const candidates = WORK_FORMATS.filter(
    (format) => format.fromChars !== undefined
  );
  let picked = candidates[0];
  for (const format of candidates) {
    if (totalChars >= (format.fromChars ?? 0)) picked = format;
  }
  return picked;
}

function byKey(key: WorkFormatKey): WorkFormatDef {
  const found = WORK_FORMATS.find((format) => format.key === key);
  if (!found) throw new Error(`未知の形式: ${key}`);
  return found;
}

import type { WorkFormatKey } from "./workFormat";

/**
 * その機能が、その形式の作品に合うか（設計書6.4.5）。
 *
 * **止めない。断りを入れるだけである。** 形式はプロットに書かれた
 * 作者の申告で、実際の中身とずれていることがある。合わないから
 * 実行させない作りにすると、**書き途中の作品で機能が使えなくなる。**
 *
 * 何を言うかだけをここに置き、VS Code APIには依存させない。
 * 「うるさくないか」を試験で確かめたいのは独り言と同じである。
 */

export type FormatSensitiveFeature =
  /** 各話あらすじの生成（P-07） */
  | "episodeSynopses"
  /** 感情曲線 */
  | "emotionCurve"
  /** プロット逆算（P-02） */
  | "plotReverse";

export interface FormatWarning {
  /** 見出しに出す一文 */
  message: string;
  /** なぜ合わないか。確認ダイアログの本文に出す */
  detail: string;
}

/**
 * 合わないときだけ理由を返す。合う・分からないときは undefined。
 *
 * **形式が書かれていない作品では何も言わない。** 「決めていない」を
 * 「合わない」と読み替えると、プロットを書いていない作者に
 * 毎回ダイアログを出すことになる。
 */
export function formatWarningFor(
  feature: FormatSensitiveFeature,
  format: WorkFormatKey | undefined
): FormatWarning | undefined {
  if (!format) return undefined;

  if (feature === "episodeSynopses" || feature === "emotionCurve") {
    // 短編は1話で完結する。1話ぶんのあらすじは作品紹介文とほぼ同じものになり、
    // 感情曲線は点が1つでは線にならない
    if (format === "short") {
      return {
        message: "短編では、各話あらすじと感情曲線はあまり役に立ちません。",
        detail:
          "1話で完結する作品なので、あらすじは1件だけになります。" +
          "感情曲線も点が1つでは線になりません。" +
          "作品全体の紹介は「作品紹介文を生成」のほうが向いています。",
      };
    }
    return undefined;
  }

  // プロット逆算は、各話あらすじを時系列に並べて筋を組み立てる。
  // **話が続かない作品では、その前提が成り立たない。**
  if (format === "shortCollection") {
    return {
      message: "短編集では、本文からプロットを起こす前提が合いません。",
      detail:
        "話どうしが続かないため、あらすじを時系列に並べても1本の筋になりません。" +
        "別々の短編を1つのログラインにまとめた、実際には無い話が出てきます。",
    };
  }
  if (format === "sns") {
    return {
      message: "SNS記事では、本文からプロットを起こす前提が合いません。",
      detail:
        "投稿は連続した物語ではないため、あらすじを並べても筋になりません。" +
        "投稿どうしを繋いだ、実際には無い話が出てきます。",
    };
  }
  return undefined;
}

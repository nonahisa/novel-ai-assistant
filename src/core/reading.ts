/**
 * 読み仮名の自動生成。
 *
 * 辞書登録や五十音順の並べ替えに読みが要るが、
 * 抽出しただけでは空のままになる。
 *
 * **カタカナの名前はコード側で確実に作る。** この作品の登場人物は
 * ほとんどがカタカナで、機械的に変換すれば正しい読みになる。
 * AIに書かせると、正しく作れるものまで間違える余地を残すことになる。
 *
 * 漢字を含む名前は読みを一意に決められない（「灯」は「あかり」とも「ともし」とも読む）。
 * こちらはAIの推定に委ね、作者がパネルで直せるようにする。
 */

/** 全角カタカナの範囲。ひらがなとの差は0x60 */
const KATAKANA_START = 0x30a1; // ァ
const KATAKANA_END = 0x30f6; // ヶ

/**
 * カタカナだけで書かれた名前から読みを作る。
 * 漢字・ラテン文字などが混ざる場合は undefined（推定に委ねる）。
 */
export function deriveReading(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;

  let reading = "";
  for (const char of trimmed) {
    const code = char.codePointAt(0);
    if (code === undefined) return undefined;

    // 区切り記号は読みに含めない。「リンセップ・アウクト」→「りんせっぷあうくと」
    if (/[・･\s　=＝]/u.test(char)) continue;

    // 長音符はひらがなの読みでもそのまま使う（「ホンゴー」→「ほんごー」）
    if (char === "ー") {
      reading += char;
      continue;
    }

    if (code >= KATAKANA_START && code <= KATAKANA_END) {
      reading += String.fromCodePoint(code - 0x60);
      continue;
    }

    // ひらがなが混ざっていてもそのまま通す
    if (code >= 0x3041 && code <= 0x3096) {
      reading += char;
      continue;
    }

    // それ以外（漢字・英字・記号）が混ざるなら機械的には決められない
    return undefined;
  }

  return reading || undefined;
}

/**
 * 読みが空なら埋める。既にあれば触らない。
 * 作者やAIが入れた読みを、機械的な変換で上書きしない。
 */
export function fillReading(
  current: string | null,
  name: string
): string | null {
  if (current && current.trim()) return current;
  return deriveReading(name) ?? current;
}

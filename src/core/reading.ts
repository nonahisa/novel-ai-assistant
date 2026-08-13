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
 * 読みをIME辞書に使える形（ひらがな）へ直す。
 *
 * **AIはひらがなを指示してもカタカナで返すことがある。**
 * IMEの辞書は読みがひらがなでないと取り込めないので、
 * 書き出す前にコード側で直す（文字数制限などと同じ扱い）。
 *
 * 漢字や英字が混ざっていて機械的に直せない場合は undefined を返す。
 * 推測で書き出すと、その行が取り込みで弾かれる。
 */
export function toDictionaryReading(reading: string): string | undefined {
  const trimmed = reading.trim();
  if (!trimmed) return undefined;

  let result = "";
  for (const char of trimmed) {
    const code = char.codePointAt(0);
    if (code === undefined) return undefined;

    // 区切り記号は読みに含めない（`deriveReading` と同じ扱い）
    if (/[・･\s　=＝]/u.test(char)) continue;
    // 長音符と繰り返し記号はひらがなの読みでもそのまま使う
    if (char === "ー" || char === "ゝ" || char === "ゞ") {
      result += char;
      continue;
    }
    // カタカナはひらがなへ
    if (code >= KATAKANA_START && code <= KATAKANA_END) {
      result += String.fromCodePoint(code - 0x60);
      continue;
    }
    // ひらがなはそのまま
    if (code >= 0x3041 && code <= 0x3096) {
      result += char;
      continue;
    }
    return undefined;
  }

  return result || undefined;
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

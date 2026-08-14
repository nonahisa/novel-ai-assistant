/**
 * 表記ゆれ検知（P-13）の判定部分。
 *
 * **AIを使わない。** プロンプト設計書P-13は「ルールベースを主とし、AIは補助」
 * としている。v1はルールベースだけで完結させ、機械では決められない組
 * （「振り返る／振りかえる」のような送り仮名ゆれ）は扱わない。
 *
 * 誤字脱字検知（P-09）との違いは**作品全体を一度に見る**ことである。
 * 「良い」が12回・「よい」が3回、と数えて初めて「揃っていない」と言えるので、
 * チャンク単位では判定できない。
 *
 * VS Code APIに依存しない。
 */

/** 走査する1ファイル分の材料 */
export interface NotationSource {
  filePath: string;
  /** 本文（投稿サイトのメタデータヘッダーを除いたもの） */
  body: string;
  /**
   * `body` の1行目が元ファイルの何行目か（1始まり）。
   *
   * 指摘の適用は元ファイルの行番号で行うため、ヘッダーを剥がした分を
   * ここで戻す。誤字脱字検知で行番号がずれた事故と同じ落とし穴。
   */
  startLine: number;
}

export interface NotationOccurrence {
  filePath: string;
  /** 元ファイル基準の行番号（1始まり） */
  line: number;
  lineText: string;
  /** 行内の開始位置（0始まり） */
  column: number;
}

export interface NotationVariantForm {
  surface: string;
  occurrences: NotationOccurrence[];
}

export interface NotationVariantGroup {
  /** 何を手掛かりに見つけた組か */
  kind: "proper_noun" | "kana_kanji";
  /** 組を一意に識別するキー。無視の記録に使う */
  key: string;
  /** 画面に出す見出し（例:「良い ↔ よい」） */
  label: string;
  /** 出現の多い順。先頭が「揃える先」の既定になる */
  forms: NotationVariantForm[];
}

/**
 * かな⇔漢字の表記ゆれとして扱う組。
 *
 * **網羅より精度を採る。** 「事／こと」「時／とき」「為／ため」のような
 * 頻出語は、漢字側が熟語の一部（事件・時間・行為）に紛れるため、
 * 形態素解析なしでは正しく拾えない。誤検出は作者の時間を奪うので入れない。
 *
 * `exclude` は、かな側がより長い語の一部になる場合に外すためのもの。
 * 「よい」は「つよい（強い）」「こころよい（快い）」の一部になる。
 */
interface KanaKanjiPair {
  kanji: string;
  kana: string;
  exclude?: string[];
}

export const KANA_KANJI_PAIRS: readonly KanaKanjiPair[] = [
  { kanji: "良い", kana: "よい", exclude: ["つよい", "こころよい"] },
  { kanji: "出来る", kana: "できる" },
  { kanji: "下さい", kana: "ください" },
  { kanji: "全て", kana: "すべて" },
  { kanji: "様々", kana: "さまざま" },
  { kanji: "色々", kana: "いろいろ" },
  { kanji: "沢山", kana: "たくさん" },
  { kanji: "殆ど", kana: "ほとんど" },
  { kanji: "是非", kana: "ぜひ" },
  { kanji: "何故", kana: "なぜ" },
  { kanji: "或いは", kana: "あるいは" },
  { kanji: "直ぐ", kana: "すぐ" },
  { kanji: "丁度", kana: "ちょうど" },
  { kanji: "折角", kana: "せっかく" },
  { kanji: "頑張る", kana: "がんばる" },
  { kanji: "大丈夫", kana: "だいじょうぶ" },
  { kanji: "綺麗", kana: "きれい" },
  { kanji: "素敵", kana: "すてき" },
  { kanji: "呟く", kana: "つぶやく" },
  { kanji: "微笑む", kana: "ほほえむ" },
  { kanji: "貴方", kana: "あなた" },
  { kanji: "尚", kana: "なお", exclude: ["なおさら", "なおも"] },
];

export interface DetectNotationOptions {
  /** 登録済みの固有名詞（人物・場所・能力・組織の name + aliases） */
  properNouns: string[];
}

/**
 * 作品全体から表記ゆれの組を集める。
 *
 * **2つ以上の表記が実際に本文へ出ている組だけを返す。** 片方しか
 * 使われていなければ、それは揺れていない。この条件だけで誤検出の
 * 大半が落ちる（たまたま拾った1件が単独で報告されることがなくなる）。
 */
export function detectNotationVariants(
  sources: NotationSource[],
  options: DetectNotationOptions
): NotationVariantGroup[] {
  const groups: NotationVariantGroup[] = [
    ...detectProperNounVariants(sources, options.properNouns),
    ...detectKanaKanjiVariants(sources),
  ];

  // 揺れの大きい（出現数の多い）組から見せる。作者は上から片付けられる
  return groups.sort((left, right) => total(right) - total(left));
}

function total(group: NotationVariantGroup): number {
  return group.forms.reduce((sum, form) => sum + form.occurrences.length, 0);
}

/**
 * 固有名詞のひらがな・カタカナ揺れ。
 *
 * 作品固有の造語ほど揺れやすく、しかも辞書があるので機械的に確かめられる。
 * 漢字を含む名前は、かなへ開いた形を機械では作れないため対象外
 * （読み仮名を使う手はあるが、姓名の一部だけが一致して誤検出になる）。
 */
function detectProperNounVariants(
  sources: NotationSource[],
  properNouns: string[]
): NotationVariantGroup[] {
  const registered = new Set(
    properNouns.map((name) => name.trim()).filter(Boolean)
  );
  const groups: NotationVariantGroup[] = [];
  const seen = new Set<string>();

  for (const name of registered) {
    const other = switchKanaScript(name);
    if (!other || other === name) continue;

    // 両方が登録済みなら、作者が意図して使い分けている（別名として登録済み）
    if (registered.has(other)) continue;

    // 短い名前は、別の語の一部にたまたま一致しやすい（「シル」→「しる」）
    if (other.length < 3) continue;

    const key = [name, other].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);

    const forms = collectForms(sources, [
      { surface: name },
      { surface: other },
    ]);
    if (forms.length < 2) continue;

    groups.push({
      kind: "proper_noun",
      key: `proper_noun:${key}`,
      label: forms.map((form) => form.surface).join(" ↔ "),
      forms,
    });
  }

  return groups;
}

function detectKanaKanjiVariants(
  sources: NotationSource[]
): NotationVariantGroup[] {
  const groups: NotationVariantGroup[] = [];

  for (const pair of KANA_KANJI_PAIRS) {
    const forms = collectForms(sources, [
      { surface: pair.kanji },
      { surface: pair.kana, exclude: pair.exclude },
    ]);
    if (forms.length < 2) continue;

    groups.push({
      kind: "kana_kanji",
      key: `kana_kanji:${pair.kanji}|${pair.kana}`,
      label: forms.map((form) => form.surface).join(" ↔ "),
      forms,
    });
  }

  return groups;
}

/** 出現のあった表記だけを、多い順に返す */
function collectForms(
  sources: NotationSource[],
  candidates: Array<{ surface: string; exclude?: string[] }>
): NotationVariantForm[] {
  return candidates
    .map((candidate) => ({
      surface: candidate.surface,
      occurrences: findOccurrences(
        sources,
        candidate.surface,
        candidate.exclude
      ),
    }))
    .filter((form) => form.occurrences.length > 0)
    .sort((left, right) => right.occurrences.length - left.occurrences.length);
}

/** 本文から、その表記が出てくる場所をすべて拾う */
export function findOccurrences(
  sources: NotationSource[],
  surface: string,
  exclude?: string[]
): NotationOccurrence[] {
  const found: NotationOccurrence[] = [];
  if (!surface) return found;

  for (const source of sources) {
    const lines = source.body.split("\n");
    lines.forEach((lineText, index) => {
      const blocked = exclude?.length
        ? blockedRanges(lineText, exclude)
        : undefined;

      let from = 0;
      for (;;) {
        const column = lineText.indexOf(surface, from);
        if (column === -1) break;
        from = column + 1;
        if (blocked && overlaps(blocked, column, surface.length)) continue;
        found.push({
          filePath: source.filePath,
          line: source.startLine + index,
          lineText,
          column,
        });
      }
    });
  }

  return found;
}

/** 除外語が占めている範囲。ここに重なる一致は数えない */
function blockedRanges(
  lineText: string,
  exclude: string[]
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const word of exclude) {
    if (!word) continue;
    let from = 0;
    for (;;) {
      const at = lineText.indexOf(word, from);
      if (at === -1) break;
      ranges.push([at, at + word.length]);
      from = at + 1;
    }
  }
  return ranges;
}

function overlaps(
  ranges: Array<[number, number]>,
  start: number,
  length: number
): boolean {
  const end = start + length;
  return ranges.some(([from, to]) => start < to && from < end);
}

const KATAKANA_START = 0x30a1;
const KATAKANA_END = 0x30f6;
const HIRAGANA_START = 0x3041;
const HIRAGANA_END = 0x3096;
const SCRIPT_GAP = 0x60;

/**
 * ひらがなとカタカナを入れ替える。
 *
 * かなだけで書かれた語にしか使わない。漢字や記号が混ざっていたら
 * `undefined` を返す（「ハルト君」のような形を変換しても意味がない）。
 * 長音符（ー）はどちらの表記でも同じ形なので、そのまま通す。
 */
export function switchKanaScript(value: string): string | undefined {
  let hasKatakana = false;
  let hasHiragana = false;
  let converted = "";

  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code >= KATAKANA_START && code <= KATAKANA_END) {
      hasKatakana = true;
      converted += String.fromCodePoint(code - SCRIPT_GAP);
      continue;
    }
    if (code >= HIRAGANA_START && code <= HIRAGANA_END) {
      hasHiragana = true;
      converted += String.fromCodePoint(code + SCRIPT_GAP);
      continue;
    }
    if (char === "ー" || char === "ゝ" || char === "ヽ") {
      converted += char;
      continue;
    }
    return undefined;
  }

  // 両方が混ざった語（「ハルとくん」等）は、揃えた形を機械では決められない
  if (hasKatakana === hasHiragana) return undefined;
  return converted;
}

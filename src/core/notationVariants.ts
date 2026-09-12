import { OKURIGANA_GROUPS } from "./okuriganaVariants";
import { tcyRuns } from "./tateChuYoko";
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
  kind: "proper_noun" | "kana_kanji" | "okurigana" | "digit_width";
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
 *
 * **例外は半角数字の組（`digit_width`）だけ**である。あちらは「揺れを
 * 揃える」のではなく「半角のままなら全角にするよう促す」ためにあるので、
 * 全角が1度も出ていなくても組を返す（理由は `detectDigitWidthVariants`）。
 */
export function detectNotationVariants(
  sources: NotationSource[],
  options: DetectNotationOptions
): NotationVariantGroup[] {
  const groups: NotationVariantGroup[] = [
    ...detectProperNounVariants(sources, options.properNouns),
    ...detectKanaKanjiVariants(sources),
    ...detectOkuriganaVariants(sources),
    ...detectDigitWidthVariants(sources),
  ];

  // 揺れの大きい（出現数の多い）組から見せる。作者は上から片付けられる
  return foldSubsumedGroups(groups).sort(
    (left, right) => total(right) - total(left)
  );
}

/**
 * 短いほうが長いほうに含まれる組を、長いほうへ畳む（作者の実機報告、2026-09-06）。
 *
 * 「おばあさん」の一部を「オバアサン」に変えた本文を検知すると、
 * **「ばあさん ↔ バアサン」（73回/2回）と「おばあさん ↔ オバアサン」（8回/2回）が
 * 別々の組として並んだ。** 同じ書き換えなのに2行あるので、作者には
 * 「どちらを選べばよいのか」が分からない。
 *
 * **消すのではなく、重なりを除いてから数え直す。** 「ばあさん」が
 * 「おばあさん」と関係なく単独で出ている作品もあり、その分は本物の揺れ
 * である。長いほうの出現と位置が重なる分だけを短いほうから引き、
 * 残りが揺れ（2表記以上）でなくなったときだけ組ごと落とす。
 */
export function foldSubsumedGroups(
  groups: readonly NotationVariantGroup[]
): NotationVariantGroup[] {
  const result: NotationVariantGroup[] = [];

  for (const group of groups) {
    const covering = groups.filter(
      (other) => other !== group && subsumes(other, group)
    );
    if (covering.length === 0) {
      result.push(group);
      continue;
    }

    const covered = coveredRanges(covering);
    const forms = group.forms
      .map((form) => ({
        surface: form.surface,
        occurrences: form.occurrences.filter(
          (occurrence) => !isCovered(covered, occurrence, form.surface.length)
        ),
      }))
      .filter((form) => form.occurrences.length > 0)
      .sort((left, right) => right.occurrences.length - left.occurrences.length);

    // 重なりを除くと1表記しか残らない＝この組の揺れは長いほうで説明できる
    if (forms.length < 2) continue;

    result.push({
      ...group,
      label: forms.map((form) => form.surface).join(" ↔ "),
      forms,
    });
  }

  return result;
}

/**
 * `outer` の表記が `inner` の表記をすべて呑み込んでいるか。
 *
 * 「どちらの表記も、相手のどれかに真に含まれている」ことを求める。
 * 片方だけが含まれる組（「良い ↔ よい」と「つよい ↔ ツヨイ」のような形）は
 * 別の揺れなので畳まない。
 */
function subsumes(
  outer: NotationVariantGroup,
  inner: NotationVariantGroup
): boolean {
  return inner.forms.every((form) =>
    outer.forms.some(
      (other) =>
        other.surface.length > form.surface.length &&
        other.surface.includes(form.surface)
    )
  );
}

/**
 * 「どのファイルの何行目か」の鍵。
 *
 * **区切りは `\u0000` とエスケープで書く**——生のNULを置くと、gitとgrepが
 * このファイルをバイナリ扱いし、差分も検索も効かなくなる
 * (`test/unit/sourceHygiene.test.ts` が止める)。ファイル名に現れない字なので、
 * 行番号との境目が混ざらない。
 */
function lineKey(occurrence: NotationOccurrence): string {
  return `${occurrence.filePath}\u0000${occurrence.line}`;
}

/** 長いほうの組が占めている場所（ファイル・行・列の範囲） */
function coveredRanges(
  groups: readonly NotationVariantGroup[]
): Map<string, Array<[number, number]>> {
  const ranges = new Map<string, Array<[number, number]>>();
  for (const group of groups) {
    for (const form of group.forms) {
      for (const occurrence of form.occurrences) {
        const key = lineKey(occurrence);
        const list = ranges.get(key) ?? [];
        list.push([occurrence.column, occurrence.column + form.surface.length]);
        ranges.set(key, list);
      }
    }
  }
  return ranges;
}

function isCovered(
  ranges: Map<string, Array<[number, number]>>,
  occurrence: NotationOccurrence,
  length: number
): boolean {
  const list = ranges.get(lineKey(occurrence));
  if (!list) return false;
  return overlaps(list, occurrence.column, length);
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

/**
 * 送り仮名ゆれ（設計書6.13.6）。
 *
 * **厳選した一覧で見る**（`OKURIGANA_GROUPS`）。
 * 汎用の検出は実データで壊れた。語の切れ目を決めるには形態素解析が要り、
 * 無いままだと「今 / 今なら / 今さら」のような組が数百件挙がる。
 *
 * **長い表記から先に数える。** 「打合せ」を先に数えると、
 * 「打ち合わせ」の中の「合わせ」までは拾わないが、
 * 「申込」は「申込み」の一部なので**二重に数える**。
 * 長いほうを先に数え、短いほうからは除いてある。
 */
function detectOkuriganaVariants(
  sources: NotationSource[]
): NotationVariantGroup[] {
  const groups: NotationVariantGroup[] = [];

  for (const group of OKURIGANA_GROUPS) {
    // 長い順に並べ、短いものは「より長いもの」を除外して数える
    const ordered = [...group].sort((a, b) => b.length - a.length);
    const forms = collectForms(
      sources,
      ordered.map((surface, index) => ({
        surface,
        exclude: ordered.slice(0, index),
      }))
    );
    if (forms.length < 2) continue;

    groups.push({
      kind: "okurigana",
      key: `okurigana:${ordered.join("|")}`,
      label: forms.map((form) => form.surface).join(" ↔ "),
      forms,
    });
  }

  return groups;
}

/** 全角の数字。半角の `0`〜`9` と同じ並びで持つ */
const FULLWIDTH_DIGITS = "０１２３４５６７８９";

/**
 * 単独の半角数字を、全角へ揃えるよう促す（作者の依頼、2026-09-12
 * 「表記揺れで、半角1文字の数字は全角にするよう促したほうが良いかも」）。
 *
 * 縦書きで半角の数字1文字は**横に寝る**。原稿エディタは1〜2文字を縦中横で
 * 立てるが（`tateChuYoko.ts`）、それは画面の見た目の手当てであって、
 * 投稿サイトやEPUBの組み方まで面倒は見られない。**全角で書いてあれば、
 * どこへ出しても寝ない。**
 *
 * ## 原則の例外：全角側が0件でも組を返す
 *
 * ほかの組は「2つ以上の表記が実際に本文へ出ている」ことを条件にしている。
 * ここだけは**全角の出現が0件でも返す**——作者の依頼は「揺れているものを
 * 揃える」ではなく「半角のままなら全角にするよう促す」ことだからである。
 * 一度も全角を使っていない原稿こそ、いちばん促す値打ちがある。
 * ただし**半角が1件も無ければ出さない**（直すものが無い）。
 *
 * ## 数字ごとに組を分ける
 *
 * 0〜9をまとめて1組にすると作者の手数は減るが、**揃える処理は
 * 「surface を suggestion へ置き換える」作り**である
 * （`features/checkNotation.ts` の `buildIssue` と提案パネルの適用）。
 * まとめると置換先が数字ごとに違ってしまい、その作りに載らない。
 * 数字ごとに分ければ、実績のある適用経路をそのまま使える。
 *
 * ## 拾う範囲は縦中横と同じ規則
 *
 * **判定は `tateChuYoko.ts` の1つだけ**を使い、そのうち1文字の run に絞る。
 * 2文字以上（「12」「2026」）は促さない——縦中横で立つものを直させるのは
 * 余計なお世話で、作者の指定（「3文字以降は現行通り」）にも合わない。
 * 型番（「F5」「A-13」）が外れるのも、あちらの規則をそのまま引き継ぐ。
 */
function detectDigitWidthVariants(
  sources: NotationSource[]
): NotationVariantGroup[] {
  const groups: NotationVariantGroup[] = [];

  for (let digit = 0; digit <= 9; digit++) {
    const half = String(digit);
    const full = FULLWIDTH_DIGITS[digit];

    const halfOccurrences = findSingleDigitOccurrences(sources, half);
    if (halfOccurrences.length === 0) continue;

    groups.push({
      kind: "digit_width",
      key: `digit_width:${half}`,
      label: `半角の数字1文字（${half}）↔ 全角（${full}）`,
      // **全角を先頭に置く。** `forms` の先頭は「揃える先の既定」であり
      // （まとめて決めるときはここが選ばれる）、この組は全角へ促すために
      // ある。出現数の多い順に並べる決まりは、どちらへ揃えるか機械では
      // 決められない組のためのものなので、ここでは当てはまらない
      forms: [
        { surface: full, occurrences: findOccurrences(sources, full) },
        { surface: half, occurrences: halfOccurrences },
      ],
    });
  }

  return groups;
}

/**
 * 単独の半角数字が出てくる場所。
 *
 * `findOccurrences` を使えないのは、あちらが**ただの部分一致**だからである
 * （「2026」の中の「2」まで拾ってしまう）。縦中横と同じ規則で run を取り、
 * 長さ1のものだけを数える。
 */
function findSingleDigitOccurrences(
  sources: NotationSource[],
  digit: string
): NotationOccurrence[] {
  const found: NotationOccurrence[] = [];

  for (const source of sources) {
    const lines = source.body.split("\n");
    lines.forEach((lineText, index) => {
      for (const run of tcyRuns(lineText)) {
        if (run.end - run.start !== 1) continue;
        if (lineText[run.start] !== digit) continue;
        found.push({
          filePath: source.filePath,
          line: source.startLine + index,
          lineText,
          column: run.start,
        });
      }
    });
  }

  return found;
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

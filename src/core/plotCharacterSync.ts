import { emptyCharacter, type Character } from "../models/character";
import { normalizeName } from "./characterMerge";
import { sha256Text } from "./hash";
import { clampSummary } from "./summaryLimit";

/**
 * plot.md の「主要登場人物」から設定資料への差分反映（設計書6.4.9）。
 *
 * ここは**読むだけの純粋な部品**である。plot.md へは書かず、台帳へも書かない
 * （積むのは承認待ちだけ）。VS Code APIにも依存しない。
 *
 * ## AIを呼ばない
 *
 * プロットの人物欄は短く、構造も緩い箇条書きにすぎない。読める形だけを
 * 機械で拾い、**読めなかった行は黙って飛ばさずに件数を返す**。AIに読ませると
 * 「たぶんこう書きたかったのだろう」という補完が混ざり、作者が書いていない
 * 紹介文が資料へ流れ込む。
 *
 * ## 区切りの優先順（テンプレートの案内に合わせる）
 *
 * 書き出し（`plotTemplate.ts`）が勧めるのは**箇条書き**だけで、中身の形は
 * 決めていない（6.4.3。文書を欄に閉じ込めない）。設計書6.4.9が例に挙げる
 * `- 名前：説明`・`- 名前——説明` を軸に、次の順で読む。
 *
 * 1. **コロン**（`：` `:`）——いちばん明示的。名前に空白やダッシュが
 *    入っていても、コロンの手前を名前として読める
 * 2. **ダッシュ**（`——` `―` `–` `－`、および前後を空白で挟んだ `-`）
 *    ——空白より先に見る。「ギルドマスター グラハム —— 受付の主」で、
 *    名前側の空白を区切りと取り違えないため
 * 3. **空白**（半角・全角）——箇条書きの行だけ
 * 4. **名前だけ**——箇条書きの行だけ。説明は空で拾う
 *
 * **中黒（`・`）と長音符（`ー`）は区切りにしない。** どちらもカタカナの
 * 名前そのものに現れる（「ヴォイド・コンストラクタ」「ギルドマスター」）。
 * 区切りに数えると、名前が途中で割れる。
 *
 * 3と4を箇条書きの行に限るのは、**自由に書かれた地の文を人物にしない**
 * ためである。「この節はあとで書き直す。」のような1行は、空白区切りとして
 * 読めばそれらしく割れてしまう。
 */

/** 節から読み取れた1人分 */
export interface PlotCharacterEntry {
  name: string;
  /** 説明。名前だけの行では空文字 */
  summary: string;
}

export interface ParsedPlotCharacters {
  entries: PlotCharacterEntry[];
  /** 読めなかった行（そのまま）。件数を作者へ伝えるために持つ */
  unparsed: string[];
}

/** 行頭の箇条書きの印。`- ` `* ` `+ ` `・` `1. ` */
const BULLET = /^(?:[-*+]\s+|・\s*|\d+[.)]\s+)/;

/** 名前として認めない長さ。ここを超える行は説明文か地の文である */
const MAX_NAME_LENGTH = 20;

/** 文の終わりを含むものは名前ではない */
const SENTENCE_MARKS = /[。！？!?．]/;

/** 名前に見えるか。記号だけの行（`---` など）も弾く */
function isNameLike(value: string): boolean {
  const name = value.trim();
  if (!name || [...name].length > MAX_NAME_LENGTH) return false;
  if (SENTENCE_MARKS.test(name)) return false;
  return /[\p{L}\p{N}]/u.test(name);
}

/** 強調の印（`**灯**`）を落とす。名前そのものではない */
function stripEmphasis(value: string): string {
  return value.replace(/^\*{1,2}(.+?)\*{1,2}$/, "$1").trim();
}

function tidySummary(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * 1行を人物として読む。読めなければ undefined。
 *
 * `bullet` が false の行（箇条書きでない行）は、区切りが明示されている
 * ものだけを読む——上の「区切りの優先順」を参照。
 */
function parseEntryLine(
  content: string,
  bullet: boolean
): PlotCharacterEntry | undefined {
  const patterns: RegExp[] = [
    // コロン。説明が空でもよい（「灯：」）
    /^(.+?)[：:][ 　]*(.*)$/,
    // 全角系のダッシュ。連続していてもまとめて区切りにする
    /^(.+?)[ 　]*[—―–－]+[ 　]*(.*)$/,
    // 半角ハイフンは、前後を空白で挟んだときだけ区切りにする
    // （名前の中のハイフンを割らないため）
    /^(.+?)[ 　]+-{1,3}[ 　]+(.*)$/,
  ];
  if (bullet) patterns.push(/^([^ 　]+)[ 　]+(.+)$/);

  for (const pattern of patterns) {
    const matched = pattern.exec(content);
    if (!matched) continue;
    const name = stripEmphasis(matched[1]);
    if (!isNameLike(name)) continue;
    return { name, summary: tidySummary(matched[2] ?? "") };
  }

  if (!bullet) return undefined;
  const name = stripEmphasis(content);
  return isNameLike(name) ? { name, summary: "" } : undefined;
}

/**
 * 「主要登場人物」の節を読む。
 *
 * 渡すのは `parsePlotMarkdown` が返した節の中身だけ（見出しは含まない）。
 */
export function parsePlotCharacters(
  sectionText: string
): ParsedPlotCharacters {
  const entries: PlotCharacterEntry[] = [];
  const unparsed: string[] = [];

  // 案内のコメントは書かれた中身ではない（`isBlankPlotSection` と同じ扱い）
  const text = sectionText.replace(/<!--[\s\S]*?-->/g, "");

  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 節の中の小見出しと罫線は、人物の行ではない
    if (/^#{1,6}\s/.test(trimmed)) continue;
    if (/^([-*_])\1{2,}$/.test(trimmed)) continue;
    // 印だけの行（`- `）はテンプレートが置く空欄。読めなかった行ではない
    if (/^[-*+・]$/.test(trimmed)) continue;

    const indented = /^[ \t　]/.test(line);
    const bulletMatch = BULLET.exec(trimmed);
    const content = bulletMatch
      ? trimmed.slice(bulletMatch[0].length).trim()
      : trimmed;
    // 「- 」だけの行はテンプレートの空欄。読めなかった行ではない
    if (bulletMatch && !content) continue;

    // 字下げした箇条書きは、直前の人物の細目として書かれることが多い。
    // 別の人物として拾うと「十七歳」という名前の人物が資料に並ぶ
    if (indented && bulletMatch && entries.length > 0) {
      const last = entries[entries.length - 1];
      last.summary = tidySummary(`${last.summary} ${content}`);
      continue;
    }

    const entry = parseEntryLine(content, Boolean(bulletMatch));
    if (!entry) {
      unparsed.push(trimmed);
      continue;
    }
    entries.push(entry);
  }

  return { entries, unparsed };
}

/**
 * 節の内容ハッシュ。**前回と同じなら積まない**ための鍵である。
 *
 * **並べ替えただけでは変わらない。** 人物の順を入れ替えたり、1人を
 * 上へ動かしたりするたびに同じ提案が積み上がると、提案パネルが
 * 前回と同じ行で埋まる。名前と説明の組が変わったときだけ変わればよい。
 *
 * 1人分を `JSON.stringify` で綴じてから並べ替える。**区切り文字を
 * 自前で決めない**——名前にも説明にも現れない文字を選ぶのは難しく、
 * NULのような制御文字を書けば今度はソースがバイナリ扱いされる。
 */
export function plotCharactersDigest(
  entries: readonly PlotCharacterEntry[]
): string {
  const rows = entries
    .map((entry) => JSON.stringify([entry.name, entry.summary]))
    .sort();
  return sha256Text(rows.join("\n"));
}

/** 積まなかったものと、その理由 */
export interface PlotCharacterSkip {
  name: string;
  /**
   * authorConfirmed: 作者が確定させた人物（`autoGenerated: false`）。
   *   抽出と同じく、こちらからは書き換えない
   * ambiguous: 同じ呼び名の人物が複数居て、寄せ先を決められない
   */
  reason: "authorConfirmed" | "ambiguous";
}

export interface PlotCharacterPlan {
  /** 既存レコードの写しに、プロットの紹介文を入れたもの（承認待ちへ積む） */
  updates: Character[];
  /** 資料にまだ居ない名前 */
  creations: PlotCharacterEntry[];
  skipped: PlotCharacterSkip[];
}

/**
 * 節の内容と既存の人物一覧から、承認待ちへ積むものを決める。
 *
 * **紹介文（summary）だけを扱う。** プロットの人物欄に書かれるのは
 * 「何者か」の一行であり、外見や一人称ではない。ここで欄を増やすと、
 * 書かれていない項目を空で塗り替えることになる。
 *
 * **作中の変化（`changes`）には記録しない。** プロットの記述は
 * 「第何話の値」ではないので、話数の分からない値を変化として積むと、
 * 6.18の前後判定（いちばん後ろの話の値を採る）が狂う。
 */
export function buildPlotCharacterUpdates(
  entries: readonly PlotCharacterEntry[],
  existing: readonly Character[]
): PlotCharacterPlan {
  const updates: Character[] = [];
  const creations: PlotCharacterEntry[] = [];
  const skipped: PlotCharacterSkip[] = [];

  for (const entry of entries) {
    const matches = findCharactersByAppellation(existing, entry.name);

    if (matches.length === 0) {
      creations.push(entry);
      continue;
    }
    if (matches.length > 1) {
      // どれへ寄せても半分は誤りになる。作者の判断を待つ（characterMergeと同じ）
      skipped.push({ name: entry.name, reason: "ambiguous" });
      continue;
    }

    const match = matches[0];
    const summary = clampSummary(entry.summary);
    // 名前だけの行は、既に居る人物に対して足す情報を持たない
    if (!summary) continue;
    if (summary === match.summary) continue;

    // 作者が確定させたレコードは、抽出と同じくこちらから書き換えない
    // （実装ルール2。登場話数の追記だけが許されるが、プロットには話数が無い）
    if (!match.autoGenerated) {
      skipped.push({ name: entry.name, reason: "authorConfirmed" });
      continue;
    }

    // 呼び出し側のレコードを書き換えない。承認するまで台帳は変わらない
    const proposal = structuredClone(match) as Character;
    proposal.summary = summary;
    updates.push(proposal);
  }

  return { updates, creations, skipped };
}

/**
 * 新規案が持つ仮のID。
 *
 * `parseCharacter` はIDの形（`char_数字`）を確かめるので、空にはできない。
 * **この番号のまま台帳へ入れてはいけない**——承認したときに
 * `applyPendingUpdates` が採り直す。積んだ時点で本番の番号を採ると、
 * 承認までのあいだに別の操作が同じ番号を使う。
 */
export const PENDING_CREATION_ID = "char_000";

/**
 * 新規の人物案のレコードを作る。
 *
 * **初期値は抽出の新規と同じ流儀**（`emptyCharacter`。`autoGenerated: true`、
 * 登場話数は空）。違うのは `status` だけで、**本文にまだ出ていないので
 * 「未登場」**にする（設定資料には「未登場（設定のみ）」と出る）。
 * プロットに書いただけの人物を「登場済み」と名乗らせない。
 */
export function buildNewCharacterRecords(
  entries: readonly PlotCharacterEntry[]
): Character[] {
  return entries.map((entry) => ({
    ...emptyCharacter(PENDING_CREATION_ID, entry.name),
    summary: clampSummary(entry.summary),
    status: "未登場" as const,
  }));
}

/**
 * その呼び名で引き当てられる人物。
 *
 * 名前と別名の両方を見る。**作者が「別人だ」と決めた呼び名では
 * 引き当てない**（設計書6.5.8）——ここを塞がないと、分けた判断が
 * プロット経由で戻ってくる。
 *
 * 承認のとき（`applyPendingUpdates`）にも使う。積んだあとに同じ名前の
 * 人物が資料へ増えていたら、新規案は作らずに片付ける——写しを作らない
 * ために、突き合わせの決まりはここ1か所に置く。
 */
export function findCharactersByAppellation(
  existing: readonly Character[],
  name: string
): Character[] {
  const key = normalizeName(name);
  if (!key) return [];

  return existing.filter((character) => {
    const blocked = new Set(
      (character.distinctFrom ?? []).map((entry) => normalizeName(entry.name))
    );
    if (blocked.has(key)) return false;
    return [character.name, ...character.aliases]
      .map(normalizeName)
      .some((candidate) => candidate === key && !blocked.has(candidate));
  });
}

import { isSameBodyText } from "./bodyCompare";
import { decodeCharacterReferences } from "./htmlEntities";

/**
 * アルファポリスのバックアップ（`.txt` 直）を読む（設計書6.99）。
 *
 * ## カクヨム・なろうとは形が決定的に違う
 *
 * | | カクヨム | なろう | **アルファポリス** |
 * |---|---|---|---|
 * | 入れ物 | ZIP | ZIP | **`.txt` 直** |
 * | 作品情報 | `about.txt` | 合本の頭（【Nコード】等） | **1つも無い** |
 * | 区切り | ファイル | `--- エピソードN開始 ---` | **`第○章『…』` と `N話　題`** |
 * | 文字コード | UTF-8 | UTF-8 | **Shift_JIS と UTF-8 の両方** |
 *
 * **見出しが1つも無く、いきなり本文から始まる。** 題すら書かれていないので、
 * **ファイル名から採るしかない**（`workZip.ts` の `workTitleFromBackupFileName`）。
 *
 * ## HTMLの文字参照が本文に混ざる
 *
 * 実物に152件あった（`&#x2014;`＝—、`&#x2049;`＝⁉、`&#x2022;`＝•、`&#x2661;`＝♡）。
 * **UTF-8版にも同じだけ入っている**ので文字コードの問題ではなく、
 * 書き出しの仕様である。**ほどかないと `&#x2014;` が原稿にそのまま残る。**
 *
 * ## 丸ごと復号してから判定する
 *
 * 呼ぶ側（`workZip.ts`）は**バイト列を切らずに**文字へ直してから渡すこと。
 * 頭だけ切って判定すると、最後の1文字が欠けた並びになって文字コードの
 * 見分けが外れ、**全文が化ける**（0.69.9 でなろうの合本を読めなくした
 * のと同じ穴。速さのために切った数キロバイトが、機能そのものを黙って止めた）。
 *
 * ## 決め打ちしない
 *
 * ここが「アルファポリスのものだ」と言うのは、**ほかのサイトの手がかりが
 * 1つも無く、章と話の形で区切られている**ときだけである。ただの原稿を
 * アルファポリスのバックアップと読み違えると、話でない行で本文が切れる。
 * サイトを決めるのは `backupSite.ts` で、ここはその手がかりを渡すだけである。
 *
 * VS Code API には依存しない。
 */

/**
 * 話の見出し。実物は `１話　転生`（全角数字＋`話`＋全角空白＋題）。
 *
 * **`第` は付いていても付いていなくてもよい**（他の作品での揺れに備える）。
 * 題が空の行は見出しとみなさない——`１話` だけの行は、本文の一部かもしれない。
 */
const EPISODE_HEADING = /^第?\s*([0-9０-９]+)\s*話[\s　:：・．.、,，\-–—]+(\S.*)$/;

/**
 * 章の見出し。実物は `第一章『死の谷』`（漢数字＋`章`＋『題』）。
 *
 * 括弧を落とさずに**そのまま持つ**——既存の合本の【第N章】へ載せるとき、
 * 作者が見慣れた文字列のまま出したいためである。
 */
const CHAPTER_HEADING =
  /^第\s*[一二三四五六七八九十百千0-9０-９]+\s*章(?:\s*[『「《【].*[』」》】])?\s*$/;

/** なろうの合本の区切り行。これがあればなろうのものなので、ここでは読まない */
const NAROU_SEPARATOR = /^-{3,}\s*エピソード\s*\d*\s*開始\s*-{3,}$/;

/** 行頭に単独で置かれた【見出し】。1つでもあれば、ここが読むものではない */
const LABEL_LINE = /^【[^】]+】\s*$/;

/** これ未満しか話の見出しが無ければ、合本とみなさない（ただの原稿かもしれない） */
const MIN_EPISODES = 2;

export interface AlphapolisChapter {
  /** 1始まりの章番号（ファイルに出てきた順） */
  readonly number: number;
  /** 章の見出しそのまま（`第一章『死の谷』`）。文字参照はほどいてある */
  readonly title: string;
}

export interface AlphapolisEpisode {
  /** 見出しから読み取った話数。**読めなければ null**（並び順で埋めない） */
  readonly number: number | null;
  /** 話数を除いた題（`転生`）。文字参照はほどいてある */
  readonly title: string;
  /** 見出しの行そのもの（作者へ見せる名前。`178話　変わった面接`） */
  readonly label: string;
  /** その話が属する章の見出し。章が無ければ null */
  readonly part: string | null;
  /** 本文。文字参照はほどき、前後の空行は落としてある */
  readonly body: string;
}

export interface AlphapolisBackup {
  readonly chapters: readonly AlphapolisChapter[];
  /** 取り込む話（中身まで同じ重複を落としたあと） */
  readonly episodes: readonly AlphapolisEpisode[];
  /**
   * ファイルに入っていた話**ぜんぶ**（落としたものも、出てきた順のまま）。
   *
   * **点検（`episodeNumberCheck.ts`）はこちらに掛ける。** 落としたあとの
   * 並びを見ると、**重複そのものが見えなくなる**——「同じ話が2回入って
   * います」と言えなくなり、作者の指示（必ず言う）を満たせない。
   */
  readonly allEpisodes: readonly AlphapolisEpisode[];
  /**
   * 中身まで同じだったので、取り込みから落とした話の名前。
   *
   * **落としたことは必ず伝える**（作者の指示）。黙って捨てると、
   * 188話のはずが187話になっていても誰も気づけない。
   */
  readonly dropped: readonly string[];
}

/**
 * アルファポリスのバックアップを読む。**そうでなければ null。**
 *
 * @param rawText **丸ごと復号したあと**の全文（上の注意を参照）
 */
export function parseAlphapolisBackup(
  rawText: string
): AlphapolisBackup | null {
  const lines = rawText.replace(/\r\n?/g, "\n").split("\n");

  // **ほかのサイトの形が見えたら、ここでは読まない**（決め打ちしない）
  if (lines.some((line) => LABEL_LINE.test(line.trim()))) return null;
  if (lines.some((line) => NAROU_SEPARATOR.test(line.trim()))) return null;

  const headings = findHeadings(lines);
  const episodeCount = headings.filter(
    (heading) => heading.kind === "episode"
  ).length;
  if (episodeCount < MIN_EPISODES) return null;

  /*
    **見出しで始まっていなければ読まない。**

    アルファポリスの書き出しは、1行目が章題か話の見出しである（実物で確認）。
    途中から話の見出しらしき行が出てくるだけのファイルは、**ただの原稿**
    かもしれない——そこで区切ると、作者の本文が見出しとして食われる。
  */
  const firstContent = lines.findIndex((line) => line.trim() !== "");
  if (firstContent < 0 || headings[0]?.line !== firstContent) return null;

  return assemble(lines, headings);
}

/** 見出しの行（章か話か）と、その位置 */
interface Heading {
  readonly line: number;
  readonly kind: "chapter" | "episode";
  /** 話のとき：読み取った話数（読めなければ null） */
  readonly number: number | null;
  /** 話のとき：話数を除いた題／章のとき：見出しそのまま */
  readonly title: string;
  /** 見出しの行そのもの（前後の空白は落とす） */
  readonly label: string;
}

/**
 * 見出しの行を拾う。
 *
 * **話の見出しは「前が空行か章題か、ファイルの先頭」でなければ拾わない。**
 * 実物の190件はすべてそうなっている（空行の次が184件、章題の次が6件）。
 * この条件を外すと、本文の途中の「１話　…」で切れてしまう。
 */
function findHeadings(lines: readonly string[]): Heading[] {
  const headings: Heading[] = [];

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "") continue;

    if (CHAPTER_HEADING.test(line)) {
      const title = decodeCharacterReferences(line);
      headings.push({
        line: index,
        kind: "chapter",
        number: null,
        title,
        label: title,
      });
      continue;
    }

    const matched = EPISODE_HEADING.exec(line);
    if (!matched) continue;
    if (!startsBlock(lines, index)) continue;

    headings.push({
      line: index,
      kind: "episode",
      number: toEpisodeNumber(matched[1]),
      title: decodeCharacterReferences(matched[2].trim()),
      label: decodeCharacterReferences(line),
    });
  }

  return headings;
}

/** その行は、区切りとして立てる場所にあるか（先頭・空行の次・章題の次） */
function startsBlock(lines: readonly string[], index: number): boolean {
  if (index === 0) return true;
  const previous = lines[index - 1].trim();
  return previous === "" || CHAPTER_HEADING.test(previous);
}

/** 全角数字も読む。桁が大きすぎるものは話数として扱わない */
function toEpisodeNumber(raw: string): number | null {
  const half = raw.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0)
  );
  const number = parseInt(half, 10);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** 見出しのあいだを本文として切り出し、同じ中身の重複を落とす */
function assemble(
  lines: readonly string[],
  headings: readonly Heading[]
): AlphapolisBackup {
  const chapters: AlphapolisChapter[] = [];
  const episodes: AlphapolisEpisode[] = [];
  const allEpisodes: AlphapolisEpisode[] = [];
  const dropped: string[] = [];
  let part: string | null = null;

  for (const [index, heading] of headings.entries()) {
    if (heading.kind === "chapter") {
      chapters.push({ number: chapters.length + 1, title: heading.title });
      part = heading.title;
      continue;
    }

    const to =
      index + 1 < headings.length ? headings[index + 1].line : lines.length;
    const body = decodeCharacterReferences(
      lines.slice(heading.line + 1, to).join("\n")
    )
      .replace(/^\n+/, "")
      .replace(/\n+$/, "");

    const episode: AlphapolisEpisode = {
      number: heading.number,
      title: heading.title,
      label: heading.label,
      part,
      body,
    };
    allEpisodes.push(episode);

    /*
      **中身まで同じなら、片方だけ取り込む**（作者の裁定）。

      落としてよいのは、落としても**何も失われない**からである。ここで
      切っているのは「見出し＋本文」だけで、日付も反応も付いていない
      ——同じ番号・同じ題・同じ本文なら、2つ目は1つ目の写しでしかない。

      **中身が違えば落とさない。** どちらも作者が書いた文章で、どちらが
      新しいかはファイルから分からない（設計書6.100：アルファポリスの
      バックアップには日付が1つも入っていない）。機械が選べる問いではない。
    */
    const twin = episodes.find(
      (existing) =>
        existing.number !== null &&
        existing.number === episode.number &&
        existing.title === episode.title &&
        isSameBodyText(existing.body, episode.body)
    );
    if (twin) {
      dropped.push(episode.label);
      continue;
    }

    episodes.push(episode);
  }

  return { chapters, episodes, allEpisodes, dropped };
}

/**
 * 既存の合本の形（`collectedFile.ts` が読む形）へ載せ替える。
 *
 * ## なぜ載せ替えるのか
 *
 * 製品の中で「1ファイルに全話」を扱えるのは**この形だけ**である
 * （話への分割・話ごとの字数・原稿エディタの「次の話」・投稿用コピー）。
 * アルファポリスの生の形のまま置くと、**188話がまるごと1話に見える。**
 *
 * **写しを作らない。** 区切りの書き方は `collectedFile.ts` の読み方に
 * 合わせてある——あちらが読めない形を書けば、取り込んだ瞬間に1話になる。
 *
 * ## 元のファイルは書き換えない
 *
 * これが作るのは**新しい文字列**であって、作者のバックアップには1バイトも
 * 触らない（`Downloads` は読むだけ。実装ルール1）。
 */
export function buildCollectedTextFromAlphapolis(
  backup: AlphapolisBackup
): string {
  const parts: string[] = [];
  let part: string | null = null;
  let chapterNumber = 0;

  for (const [index, episode] of backup.episodes.entries()) {
    const block: string[] = [
      `------------------------- エピソード${index + 1}開始 -------------------------`,
    ];

    // 章が変わったところにだけ【第N章】を置く（`collectedFile.ts` と同じ形）
    if (episode.part !== null && episode.part !== part) {
      chapterNumber++;
      block.push(`【第${chapterNumber}章】`, episode.part, "");
      part = episode.part;
    }

    block.push(
      "【エピソードタイトル】",
      // **話数を読めた話は「N話　題」に揃える。** 読めなかった話は見出しの
      // ままにして、番号をこちらで作らない（並び順で埋めると話数がずれる）
      episode.number === null
        ? episode.label
        : `${episode.number}話　${episode.title}`,
      "",
      "【本文】",
      episode.body,
      ""
    );
    parts.push(block.join("\n"));
  }

  return parts.join("\n");
}

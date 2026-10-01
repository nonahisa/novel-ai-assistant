import { parseCollectedFile } from "./collectedFile";
import { parseEpisodeMetadata } from "./metadataParser";
import { hashText } from "./hash";
import { blankMemoLines } from "./sceneMemo";

/**
 * 1ファイルの本文を、各話あらすじ（P-07）が使う「話ごとの本文」へ分ける。
 *
 * もとは `episodeBodies.ts` の `loadEpisodeBodies` の中にあった。あちらは
 * 読み込み（`textFile.ts`）が `vscode` を引くので、外から呼ぶ束（MCP）から
 * 使えない。**外部AIのあらすじを資料へ保存する道（`novel.synopsis.commit`、
 * 2026-10-02）が、製品と同じ本文・同じハッシュを持つ**ために、読み込みの
 * 後ろだけをここへ切り出した。写しを2つ持つと、片方だけメモの消し方が
 * 変わった日にハッシュが食い違い、作り直しの判断が狂う。
 *
 * 読み込み・競合マーカーの判定は呼ぶ側が行う（製品は `readTextFile`、
 * MCP は `readBody`）。
 */

export interface EpisodeBodyPart {
  /** 話数。読み取れなければ null（推測で埋めない） */
  chapter: number | null;
  /** サブタイトル。無ければ null */
  title: string | null;
  /** シーンメモを消した本文（行数は保つ） */
  body: string;
  /** 本文のハッシュ。作り直しの判断に使う（`ChapterSynopsis.sourceHash`） */
  hash: string;
  /** 合本の中の話か */
  insideCollected: boolean;
}

/**
 * @param single 合本でないときの話数と題（製品は走査の `chapterStart` と
 *   `subtitle ?? metaTitle`）。合本なら中の話の題と話数を使う
 */
export function splitEpisodeBodyParts(
  text: string,
  single: { chapter: number | null; title: string | null }
): EpisodeBodyPart[] {
  const collected = parseCollectedFile(text);
  if (collected) {
    const parts: EpisodeBodyPart[] = [];
    for (const inner of collected) {
      const body = blankMemoLines(inner.body);
      if (!body.trim()) continue;
      parts.push({
        chapter: inner.chapter,
        title: inner.title,
        body,
        // **ハッシュもメモを抜いた本文から取る。** メモを直しただけで
        // あらすじを作り直すと、AIを無駄に呼ぶことになる
        hash: hashText(body),
        insideCollected: true,
      });
    }
    return parts;
  }

  const body = blankMemoLines(parseEpisodeMetadata(text).body);
  if (!body.trim()) return [];
  return [
    {
      chapter: single.chapter,
      title: single.title,
      body,
      hash: hashText(body),
      insideCollected: false,
    },
  ];
}

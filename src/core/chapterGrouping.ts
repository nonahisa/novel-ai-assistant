import type { EpisodeFile } from "../models/types";
import { normalizeEpisodePath, type Chapter } from "../models/chapter";
import { episodePathFor } from "./bookStore";
import { episodeUnit, formatChapterLabel } from "./episodeLabel";
import type { WorkFormatKey } from "./workFormat";

/**
 * 話を章ごとに束ねる（設計書6.66.1・6.66.3）。
 *
 * **章は開始の話しか持たない。** 次の章が始まるまでがその章なので、
 * 束ねはここで作る。話を後から足しても台帳は書き換わらず、
 * 書いた場所の章へ自然に落ちる。
 *
 * 走査（`scanner.ts`）が返した並びをそのまま使う。**ここで並べ替えない**
 * ——一覧に出る順と章の切れ目が別々の規則で決まると、章の境目だけが
 * 一覧の見た目とずれる。
 */

export interface ChapterGroup {
  chapter: Chapter;
  /** この章に入る話。開始の話が見つからない章では空 */
  episodes: EpisodeFile[];
  /**
   * 開始の話が作品の中に見つからない（改題・削除が典型）。
   *
   * **黙って消さない。** 台帳から落とすと、作者が付けた章名が
   * 理由も告げずに消える（挿絵の指し先と同じ扱い、設計書6.65.10）。
   */
  missingStart: boolean;
}

export interface ChapterGrouping {
  /** 最初の章より前の話。作品の直下に並ぶ（章なし） */
  ungrouped: EpisodeFile[];
  /** 章の束。**話の並び順**に並ぶ（台帳に書かれた順ではない） */
  groups: ChapterGroup[];
}

export function groupEpisodesByChapter(
  episodes: readonly EpisodeFile[],
  chapters: readonly Chapter[],
  workFolder: string
): ChapterGrouping {
  const list = [...episodes];

  // 話の相対パス → 並びの位置。同じパスが2つ並ぶことは無いので、
  // 最初に見つかった位置だけを覚える
  const indexByPath = new Map<string, number>();
  list.forEach((episode, index) => {
    const key = episodePathFor(workFolder, episode.filePath);
    if (!indexByPath.has(key)) indexByPath.set(key, index);
  });

  const found: Array<{ chapter: Chapter; startIndex: number }> = [];
  const missing: Chapter[] = [];
  for (const chapter of chapters) {
    const startIndex = indexByPath.get(
      normalizeEpisodePath(chapter.startEpisodePath)
    );
    if (startIndex === undefined) {
      missing.push(chapter);
      continue;
    }
    found.push({ chapter, startIndex });
  }

  // **台帳の並びは当てにしない。** 作者が手で書き足すと、あとの章が
  // 先に書かれていることがある。切れ目は話の並びが決める
  found.sort((left, right) => left.startIndex - right.startIndex);

  const groups: ChapterGroup[] = found.map((entry, position) => {
    const next = found[position + 1];
    return {
      chapter: entry.chapter,
      // 次の章が始まる手前まで。最後の章は末尾まで
      episodes: list.slice(entry.startIndex, next?.startIndex ?? list.length),
      missingStart: false,
    };
  });

  return {
    // 最初の章より前は章なし。章が1つも無ければ、話は全部が章なし
    ungrouped: list.slice(0, found[0]?.startIndex ?? list.length),
    groups: [
      ...groups,
      // 指し先の無い章は末尾へ。並びの中に置き場所が無いので、
      // どこへ挟んでも作者の読みを誤らせる
      ...missing.map((chapter) => ({
        chapter,
        episodes: [],
        missingStart: true,
      })),
    ],
  };
}

/**
 * 章に添える話数の範囲と件数（「第1話〜第5話・5話」）。
 *
 * 見出しの作り方は `episodeLabel.ts` の部品に任せる。話数の言い方は
 * 作品の形式で変わる（SNS記事は「投稿3」で、「第3話」とは言わない）。
 */
export function formatChapterRange(
  episodes: readonly EpisodeFile[],
  format?: WorkFormatKey
): string {
  const unit = episodeUnit(format);
  if (episodes.length === 0) return `${unit.noun}がありません`;

  const count = `${episodes.length}${unit.noun}`;
  const first = formatChapterLabel(episodes[0], format);
  const last = formatChapterLabel(episodes[episodes.length - 1], format);
  // 話数が読み取れない話（ファイル名から番号が分からない）では、
  // 範囲を作れない。数だけを出し、**番号を捏造しない**
  if (!first || !last) return count;

  const range = first === last ? first : `${first}〜${last}`;
  return `${range}・${count}`;
}

/**
 * 章ノードのID（設計書6.66.3）。
 *
 * **名前を入れない。** 折りたたみの開閉状態はVS CodeがIDで覚えるので、
 * 名前から作ると**改名のたびに開閉が失われる**。作品と開始の話は
 * 章そのものの位置を表すので、名前を変えてもIDは動かない。
 */
export function chapterNodeId(
  workId: string,
  startEpisodePath: string
): string {
  return `chapter:${workId}:${normalizeEpisodePath(startEpisodePath)}`;
}

/**
 * 章立て（設計書6.66.1）。
 *
 * 章のレコードは **「名前」と「どの話から始まるか」の2つだけ**である。
 * 終わりの話は持たない——次の章が始まるまでがその章である。「章に属する
 * 話の一覧」を持つ設計にすると、話を1つ足すたびに全部の章を書き直すことに
 * なり、書き忘れた話が宙に浮く。開始だけなら、**新しい話は書いた場所の
 * 章へ自然に落ちる。**
 *
 * 話の指し方は**作品フォルダからの相対パス**（挿絵・ページ分割と同じ。
 * 話数は並べ替えや改題で動くが、パスはその話そのものを指し続ける）。
 * 実際にパスを作るのは `core/bookStore.ts` の `episodePathFor` で、
 * ここでは読み込んだ文字列を同じ形へ揃えるだけにしてある。
 *
 * VS Code API には依存しない（`models` の約束）。
 */

import {
  invalid,
  objectValue,
  optionalObjectArray,
  optionalString,
  requireNonEmptyString,
} from "./jsonValidation";

/** 保存先のファイル名。`設定/` の直下に置く */
export const CHAPTERS_FILE = "章立て.json";

export const CHAPTERS_SCHEMA_VERSION = "1";

export interface Chapter {
  /** 章の名前（「第一章　出立」など）。空は許さない */
  name: string;
  /** 開始の話。作品フォルダからの相対パス（区切りは `/`） */
  startEpisodePath: string;
}

export interface ChapterSet {
  schemaVersion: string;
  chapters: Chapter[];
}

export function emptyChapterSet(): ChapterSet {
  return { schemaVersion: CHAPTERS_SCHEMA_VERSION, chapters: [] };
}

/**
 * 話の指し方を1つの形へ揃える。
 *
 * **区切りは `/`。** 手元のWindowsで書かれた `本文\第1話.txt` と、
 * ブラウザ上の作品（`vscode-vfs://`）の `本文/第1話.txt` が別物に
 * 見えると、同じ作品を2つの環境で開いたときに章が黙って外れる
 * （`models/book.ts` の挿絵の指定と同じ揃え方）。
 */
export function normalizeEpisodePath(value: string): string {
  return value.trim().replace(/\\/g, "/");
}

/**
 * 作者が手で編集したJSONを読む。**壊れていたら例外を投げる。**
 *
 * 勝手に直して上書きすると、作者が書いた章名が黙って消える
 * （他の台帳と同じ約束）。
 */
export function parseChapterSet(raw: unknown): ChapterSet {
  const value = objectValue(raw, `設定/${CHAPTERS_FILE}`);
  optionalString(value.schemaVersion, "schemaVersion");

  const chapters =
    optionalObjectArray(value.chapters, "chapters", (entry, entryPath) => {
      requireNonEmptyString(entry.name, `${entryPath}.name`);
      requireNonEmptyString(
        entry.startEpisodePath,
        `${entryPath}.startEpisodePath`
      );
      return {
        name: (entry.name as string).trim(),
        startEpisodePath: normalizeEpisodePath(entry.startEpisodePath as string),
      };
    }) ?? [];

  assertUniqueStarts(chapters);

  return {
    schemaVersion:
      (value.schemaVersion as string | undefined) ?? CHAPTERS_SCHEMA_VERSION,
    chapters,
  };
}

/**
 * 同じ話から始まる章が2つ無いことを確かめる。
 *
 * **後勝ちで畳まず、読めないと言って止める。** 1つの話が2つの章の
 * 始まりであることは無いので、そうなっているJSONは作者の書き損じか
 * 同期の取り違えである。片方を黙って捨てると、**作者が付けた章名が
 * 理由も告げずに消える**——壊れたJSONを修復しない約束と同じ理由で、
 * ここは止めるほうを採った。
 *
 * 画面からの操作（「ここから章を始める」）は、既にその話から始まる章が
 * あれば改名として扱うので、そもそも重複を作らない。
 */
export function assertUniqueStarts(chapters: readonly Chapter[]): void {
  const seen = new Set<string>();
  for (const chapter of chapters) {
    if (seen.has(chapter.startEpisodePath)) {
      invalid(
        `chapters（「${chapter.startEpisodePath}」から始まる章が2つあります）`
      );
    }
    seen.add(chapter.startEpisodePath);
  }
}

/** その話から始まる章。無ければ undefined */
export function findChapterStartingAt(
  chapters: readonly Chapter[],
  startEpisodePath: string
): Chapter | undefined {
  const wanted = normalizeEpisodePath(startEpisodePath);
  return chapters.find((chapter) => chapter.startEpisodePath === wanted);
}

/**
 * その話から始まる章を置く。既にあれば**改名**として扱う（設計書6.66.2）。
 *
 * **元の配列は書き換えない。** 保存に失敗したときに、画面に出ている
 * 一覧だけが変わってしまうのを避けるためである。
 */
export function withChapterStartingAt(
  chapters: readonly Chapter[],
  startEpisodePath: string,
  name: string
): Chapter[] {
  const start = normalizeEpisodePath(startEpisodePath);
  const trimmed = name.trim();
  if (!start) invalid("startEpisodePath");
  if (!trimmed) invalid("name");

  const found = chapters.some((chapter) => chapter.startEpisodePath === start);
  if (found) {
    return chapters.map((chapter) =>
      chapter.startEpisodePath === start
        ? { name: trimmed, startEpisodePath: start }
        : chapter
    );
  }
  return [...chapters, { name: trimmed, startEpisodePath: start }];
}

/**
 * その話から始まる章を外す。**話は消えない**（章なしに戻るだけ）。
 */
export function withoutChapterStartingAt(
  chapters: readonly Chapter[],
  startEpisodePath: string
): Chapter[] {
  const start = normalizeEpisodePath(startEpisodePath);
  return chapters.filter((chapter) => chapter.startEpisodePath !== start);
}

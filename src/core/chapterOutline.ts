import type { Chapter } from "../models/chapter";
import { parseCollectedFile, parseEpisodeTitle } from "./collectedFile";
import {
  collectedSectionStarts,
  type CollectedSectionStart,
} from "./collectedSections";
import { parseEpisodeMetadata } from "./metadataParser";

/**
 * バックアップ（や投稿サイトの作品管理の画面）に書かれた章立てを、作品の章立てへ
 * 取り込む（残課題 B7。設計書6.66.6）。
 *
 * 作者の問い（2026-09-23）：「なろうやカクヨムのバックアップから章立ては
 * 読み取れませんでしたか？」
 *
 * | 出どころ | 章がどこにあるか |
 * |---|---|
 * | なろう | 合本の【第N章】の次の行（`collectedFile.ts` の `part`） |
 * | アルファポリス | `第一章『…』` の見出し行（`alphapolisBackup.ts` の `part`） |
 * | カクヨム | **バックアップには無い。** 作品管理の画面の「大見出し」を、ヘルパーが読んで渡す（`chapterEnvelope.ts`） |
 *
 * どれも「話の並び」と「その話が属する章の題」の組（`OutlineEpisode`）へ揃えてから、
 * ここで作品の話と照らし合わせる。**出どころごとに照らし方を写さない**
 * ——写すと、なろうでは立つのにカクヨムでは立たない、の食い違いが出る。
 *
 * ## 名前について
 *
 * 合本まわりのコードでは `chapter` が**話数**を指す（`CollectedEpisode.chapter`）。
 * ここでも章の題は `part`、章の始まりは `section` と呼ぶ（`collectedSections.ts` と同じ）。
 * 台帳へ書くところだけは製品の型（`Chapter`）に合わせる。
 *
 * ## 守り（実装ルール1・2）
 *
 * - **本文には触らない。** 書くのは章立ての記録（`設定/章立て.json`）だけ
 * - **章立てが既にあれば上書きしない。** 違いを並べて、作者に選ばせる
 *   （足りない章だけ足す／置き換える／やめる）
 * - **話を推測で割り当てない。** 題と話数で照らし、合わない話が1つでもあれば
 *   一覧にして止める。並びが入れ替わっているときも止める（章の切れ目は
 *   作品一覧の並びで決まるので、並びが違うと別の話が章に入る）
 *
 * VS Code API には依存しない。
 */

/** バックアップの中の1話（章立てを取り込むのに要るものだけ） */
export interface OutlineEpisode {
  /** 作者に見せる見出し（「3話　嵐の夜」。読めなければ「3番目の話」） */
  readonly label: string;
  /** 題から読み取った話数。**読めなければ null**（並び順で埋めない） */
  readonly number: number | null;
  /** 話数を除いた題。読めなければ null */
  readonly title: string | null;
  /** その話が属する章の題。章の外（最初の章より前）なら null */
  readonly part: string | null;
}

/** 手元の作品の1話（読むのは呼ぶ側） */
export interface LocalOutlineEpisode {
  /** 作品フォルダーからの相対パス（`episodePathFor` の形）。章立てはこれを指す */
  readonly relPath: string;
  /** そのファイルの中で何番目の話か（0始まり）。合本でなければ 0 */
  readonly indexInFile: number;
  readonly number: number | null;
  readonly title: string | null;
  /** 作者に見せる見出し（「第3話」。読めなければファイル名） */
  readonly label: string;
}

/** 手元の原稿ファイル1つぶんの材料（読むのは呼ぶ側。**作品一覧に出る順**で渡す） */
export interface LocalOutlineSource {
  /** 作品フォルダーからの相対パス（`episodePathFor` の形） */
  readonly relPath: string;
  /** 作者に見せる見出し（「第3話」。読めなければファイル名） */
  readonly label: string;
  /** ファイル名から読んだ話数（`EpisodeFile.chapterStart`） */
  readonly fileNumber: number | null;
  /** ファイル名から読んだ題（`EpisodeFile.subtitle`） */
  readonly fileSubtitle: string | null;
  /** 全文。**読めなかったときは null**（ファイル名の話数と題だけで照らす） */
  readonly text: string | null;
}

/**
 * 手元の原稿ファイルを、照らし合わせる形にする。
 *
 * **読み方は取り込みと同じ部品を通す**（合本は `parseCollectedFile`、投稿サイトの
 * 頭書きのある話は `parseEpisodeMetadata`）。ここで見出しの読み方を写すと、
 * バックアップ側と手元側で同じ題が別の形に読まれる。
 *
 * - 合本（区切り行がある）：中の話を1つずつ。なろうの合本を分けたファイルも、
 *   区切り行が残っているのでここを通る
 * - 頭書きの【タイトル】がある（カクヨムの取り込み）：その題から話数と題
 * - どちらでもない：ファイル名の話数と題
 */
export function localOutlineOf(
  sources: readonly LocalOutlineSource[]
): LocalOutlineEpisode[] {
  const locals: LocalOutlineEpisode[] = [];
  for (const source of sources) {
    const collected = source.text === null ? null : parseCollectedFile(source.text);
    if (collected) {
      collected.forEach((episode, index) => {
        locals.push({
          relPath: source.relPath,
          indexInFile: index,
          number: episode.chapter,
          title: episode.title,
          // 合本の2話目以降は、ファイルの見出しに話の題を添えて見分ける
          label:
            index === 0
              ? source.label
              : `${source.label}の中の「${episode.title ?? `${episode.order}番目の話`}」`,
        });
      });
      continue;
    }
    const metadata = source.text === null ? null : parseEpisodeMetadata(source.text);
    const fromTitle = parseEpisodeTitle(metadata?.title ?? null);
    const hasTitle = fromTitle.title !== null || fromTitle.chapter !== null;
    locals.push({
      relPath: source.relPath,
      indexInFile: 0,
      number: fromTitle.chapter ?? source.fileNumber,
      title: hasTitle ? fromTitle.title : source.fileSubtitle,
      label: source.label,
    });
  }
  return locals;
}

/**
 * 章の見出しが変わった話ごとに、章を1つ立てる。
 * 決め方は `collectedSectionStarts` の1か所（合本を分けるときと同じ）。
 */
export function outlineSections(
  outline: readonly OutlineEpisode[]
): CollectedSectionStart[] {
  return collectedSectionStarts(
    outline.map((episode, index) => ({ order: index + 1, part: episode.part }))
  );
}

/** 照らし合わせられなかった話1つ */
export interface OutlineProblem {
  readonly label: string;
  /**
   * - `missing`：手元に見当たらない
   * - `ambiguous`：同じ話数・題の話が手元に2つ以上ある（どれか決められない）
   * - `title`：話数は合うが題が違う
   * - `order`：手元での並びが、バックアップと違う
   */
  readonly reason: "missing" | "ambiguous" | "title" | "order";
  /** `title` のとき、手元の題 */
  readonly localTitle?: string;
}

/** いまの章立てとの違い1行 */
export type ChapterDiffLine =
  /** 同じ話から始まるが、名前が違う */
  | {
      readonly kind: "rename";
      readonly startEpisodePath: string;
      readonly label: string;
      readonly from: string;
      readonly to: string;
    }
  /** バックアップにだけある章 */
  | {
      readonly kind: "add";
      readonly startEpisodePath: string;
      readonly label: string;
      readonly name: string;
    }
  /** この作品にだけある章（どの選び方でも、足すときは残る） */
  | {
      readonly kind: "extra";
      readonly startEpisodePath: string;
      readonly label: string;
      readonly name: string;
    };

export type ChapterImportPlan =
  /** 章の見出しが1つも無い */
  | { readonly kind: "none" }
  /** 章立ての記録を読めなかった。**何もしない** */
  | { readonly kind: "unreadable"; readonly count: number }
  /** 照らし合わせられない話がある。**何もしない**（推測で割り当てない） */
  | {
      readonly kind: "mismatch";
      readonly count: number;
      readonly problems: readonly OutlineProblem[];
    }
  /**
   * 手元の合本の途中から始まる章がある。**1つも立てない**
   * （`chaptersFromHeadings.ts` と同じ判断。頭の章だけ立てると、あとで分けても残りが立たない）
   */
  | {
      readonly kind: "insideCollected";
      readonly count: number;
      readonly inside: number;
    }
  /** 章立てが空なので、そのまま立てる */
  | {
      readonly kind: "create";
      readonly chapters: readonly Chapter[];
      readonly labels: readonly string[];
    }
  /** 章立てが既にあり、バックアップと同じ */
  | { readonly kind: "same"; readonly count: number }
  /** 章立てが既にあり、違う。**上書きせず、違いを見せて選ばせる** */
  | {
      readonly kind: "differs";
      readonly proposed: readonly Chapter[];
      readonly existing: readonly Chapter[];
      readonly diff: readonly ChapterDiffLine[];
    };

/**
 * 章立てを取り込む計画を立てる。**まだ何も書かない。**
 *
 * @param outline バックアップの話の並び
 * @param locals 手元の話の並び。**作品一覧に出る順**（走査の並び）で渡す
 * @param existing いまの章立て。**読めなかったときは null**
 */
export function planChapterImport(input: {
  outline: readonly OutlineEpisode[];
  locals: readonly LocalOutlineEpisode[];
  existing: readonly Chapter[] | null;
}): ChapterImportPlan {
  const sections = outlineSections(input.outline);
  if (sections.length === 0) return { kind: "none" };
  if (input.existing === null) {
    return { kind: "unreadable", count: sections.length };
  }

  const matched = matchOutline(input.outline, input.locals);
  if (matched.problems.length > 0) {
    return {
      kind: "mismatch",
      count: sections.length,
      problems: matched.problems,
    };
  }

  const chapters: Chapter[] = [];
  const labels: string[] = [];
  let inside = 0;
  for (const section of sections) {
    const local = matched.locals[section.startIndex];
    // 照らし合わせは全部通っているので、ここで欠けることは無い
    if (!local) continue;
    // **章立てはファイルしか指せない**（6.66.4）。合本の途中には置けない
    if (local.indexInFile > 0) {
      inside++;
      continue;
    }
    chapters.push({ name: section.name, startEpisodePath: local.relPath });
    labels.push(local.label);
  }
  // 同じファイルから2つの章が始まる形は、台帳が受け付けない（読み込みで弾かれる）
  const starts = new Set(chapters.map((chapter) => chapter.startEpisodePath));
  if (inside > 0 || starts.size !== chapters.length) {
    return {
      kind: "insideCollected",
      count: sections.length,
      inside: inside + (chapters.length - starts.size),
    };
  }

  if (input.existing.length === 0) {
    return { kind: "create", chapters, labels };
  }

  const diff = diffChapters(input.existing, chapters, input.locals);
  if (diff.length === 0) return { kind: "same", count: chapters.length };
  return { kind: "differs", proposed: chapters, existing: input.existing, diff };
}

/**
 * いまの章立てに、バックアップにだけある章を足す。**いまの章は名前も含めて1つも変えない。**
 *
 * 並びは話の並びが決める（`chapterGrouping.ts`）ので、台帳の中の順は問わない。
 */
export function addMissingChapters(
  existing: readonly Chapter[],
  proposed: readonly Chapter[]
): Chapter[] {
  const known = new Set(existing.map((chapter) => chapter.startEpisodePath));
  return [
    ...existing,
    ...proposed.filter((chapter) => !known.has(chapter.startEpisodePath)),
  ];
}

/* ── 照らし合わせ ─────────────────────────────────────── */

interface Matching {
  /** バックアップの話ごとの、手元の話（合わなかった話は undefined） */
  readonly locals: readonly (LocalOutlineEpisode | undefined)[];
  readonly problems: readonly OutlineProblem[];
}

/**
 * バックアップの話を、手元の話へ1つずつ当てる。
 *
 * - **話数が読めれば話数で探す。** 題が両方にあれば、題も合わなければならない
 *   （話数だけで決めると、手元で話を挿入して番号がずれた作品で、別の話に章が立つ）
 * - 話数が読めなければ、**題がちょうど1つだけ合う**話に当てる
 *   （なろうの「１　自殺の後始末」のように、話数を題から読めない作品がある）
 * - 当てた話の並びが、バックアップと同じ順でなければ止める
 *
 * 題は、空白と全角半角の違いだけを揃えて比べる（サイトと手元で空白の入れ方が違う
 * ことがある）。それ以外の違いは違いとして扱う。
 */
function matchOutline(
  outline: readonly OutlineEpisode[],
  locals: readonly LocalOutlineEpisode[]
): Matching {
  const problems: OutlineProblem[] = [];
  const matchedLocals: (LocalOutlineEpisode | undefined)[] = [];
  let lastPosition = -1;

  for (const episode of outline) {
    const wanted = titleKey(episode.title);
    let candidates: number[];
    if (episode.number !== null) {
      const sameNumber = indexesOf(locals, (local) => local.number === episode.number);
      candidates = sameNumber.filter((index) =>
        titlesAgree(wanted, titleKey(locals[index].title))
      );
      // 話数の無い手元の話でも、題がそっくり同じなら同じ話である
      if (candidates.length === 0 && wanted !== null) {
        candidates = indexesOf(
          locals,
          (local) => local.number === null && titleKey(local.title) === wanted
        );
      }
      if (candidates.length === 0 && sameNumber.length === 1) {
        problems.push({
          label: episode.label,
          reason: "title",
          localTitle: locals[sameNumber[0]].title ?? "",
        });
        matchedLocals.push(undefined);
        continue;
      }
    } else if (wanted !== null) {
      candidates = indexesOf(locals, (local) => titleKey(local.title) === wanted);
    } else {
      candidates = [];
    }

    if (candidates.length !== 1) {
      problems.push({
        label: episode.label,
        reason: candidates.length === 0 ? "missing" : "ambiguous",
      });
      matchedLocals.push(undefined);
      continue;
    }

    const position = candidates[0];
    if (position <= lastPosition) {
      problems.push({ label: episode.label, reason: "order" });
      matchedLocals.push(undefined);
      continue;
    }
    lastPosition = position;
    matchedLocals.push(locals[position]);
  }

  return { locals: matchedLocals, problems };
}

function indexesOf(
  locals: readonly LocalOutlineEpisode[],
  test: (local: LocalOutlineEpisode) => boolean
): number[] {
  const found: number[] = [];
  locals.forEach((local, index) => {
    if (test(local)) found.push(index);
  });
  return found;
}

/** 題を比べる形。空白を落とし、全角の英数字を半角へ（NFKC） */
function titleKey(title: string | null): string | null {
  if (title === null) return null;
  const key = title.normalize("NFKC").replace(/\s+/gu, "");
  return key === "" ? null : key;
}

/** どちらかの題が分からなければ、題では弾かない（話数で決める） */
function titlesAgree(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

/* ── いまの章立てとの違い ─────────────────────────────── */

function diffChapters(
  existing: readonly Chapter[],
  proposed: readonly Chapter[],
  locals: readonly LocalOutlineEpisode[]
): ChapterDiffLine[] {
  const labelOf = (relPath: string) =>
    locals.find((local) => local.relPath === relPath && local.indexInFile === 0)
      ?.label ?? relPath;
  const existingByPath = new Map(
    existing.map((chapter) => [chapter.startEpisodePath, chapter.name])
  );
  const proposedPaths = new Set(proposed.map((chapter) => chapter.startEpisodePath));

  const lines: ChapterDiffLine[] = [];
  for (const chapter of proposed) {
    const current = existingByPath.get(chapter.startEpisodePath);
    if (current === undefined) {
      lines.push({
        kind: "add",
        startEpisodePath: chapter.startEpisodePath,
        label: labelOf(chapter.startEpisodePath),
        name: chapter.name,
      });
    } else if (current !== chapter.name) {
      lines.push({
        kind: "rename",
        startEpisodePath: chapter.startEpisodePath,
        label: labelOf(chapter.startEpisodePath),
        from: current,
        to: chapter.name,
      });
    }
  }
  for (const chapter of existing) {
    if (proposedPaths.has(chapter.startEpisodePath)) continue;
    lines.push({
      kind: "extra",
      startEpisodePath: chapter.startEpisodePath,
      label: labelOf(chapter.startEpisodePath),
      name: chapter.name,
    });
  }
  return lines;
}

/* ── 作者に見せる言葉 ─────────────────────────────────── */

/** 1行ずつ並べる数。これを超えたら「ほか」にまとめる */
const LISTED = 30;

/**
 * 押す前に見せる文（確認の画面の小さい字）。
 *
 * **どの章がどの話から始まるかを全部並べる**（多すぎるときだけ「ほか」）。
 * 章立てが既にあるときは、**作者の章が消えないこと**と違いの中身を先に言う。
 */
export function describeChapterImportPlan(plan: ChapterImportPlan): string[] {
  switch (plan.kind) {
    case "none":
      return ["章の見出しが見つかりませんでした。"];
    case "unreadable":
      return [
        `章の見出しは${plan.count}個ありますが、章立ての記録（設定/章立て.json）を読めなかったため、取り込みません。`,
      ];
    case "mismatch":
      return [
        "バックアップの話と、この作品の話を照らし合わせられないものがありました。",
        "推測では割り当てないため、章立ては取り込みません。",
        "",
        ...listed(plan.problems.map(describeProblem), "話"),
      ];
    case "insideCollected":
      return [
        `手元の合本の途中から始まる章が${plan.inside}個あります。` +
          "章はファイルの頭からしか始められないため、取り込みません。",
        "先に作品一覧で合本を右クリックして「話ごとのファイルに分ける」を選んでください（分けるときに章も立ちます）。",
      ];
    case "create":
      return [
        ...listed(
          plan.chapters.map(
            (chapter, index) => `・${chapter.name}　← ${plan.labels[index]}から`
          ),
          "個"
        ),
        "",
        "章立ての記録（設定/章立て.json）に書くだけで、原稿は書き換えません。",
      ];
    case "same":
      return [`章立ては、すでにバックアップと同じです（${plan.count}個）。`];
    case "differs":
      return [
        `この作品には既に章立てがあります（${plan.existing.length}個）。上書きはしません。`,
        "バックアップとの違いは次のとおりです。",
        "",
        ...listed(plan.diff.map(describeDiffLine), "行"),
        "",
        "原稿は書き換えません。書くのは章立ての記録（設定/章立て.json）だけです。",
      ];
  }
}

function describeProblem(problem: OutlineProblem): string {
  switch (problem.reason) {
    case "missing":
      return `・${problem.label}：この作品に見当たりません`;
    case "ambiguous":
      return `・${problem.label}：この作品に同じ話が2つ以上あり、どれか決められません`;
    case "title":
      return `・${problem.label}：話数は合いますが、題が違います（この作品では「${problem.localTitle}」）`;
    case "order":
      return `・${problem.label}：この作品での並びが、バックアップと違います`;
  }
}

function describeDiffLine(line: ChapterDiffLine): string {
  switch (line.kind) {
    case "rename":
      return `・${line.label}からの章：いまは「${line.from}」、バックアップでは「${line.to}」`;
    case "add":
      return `・バックアップにだけある章：「${line.name}」（${line.label}から）`;
    case "extra":
      return `・この作品にだけある章：「${line.name}」（${line.label}から。足すときもそのまま残ります）`;
  }
}

function listed(lines: readonly string[], unit: string): string[] {
  const shown = lines.slice(0, LISTED);
  const rest = lines.length - shown.length;
  return rest > 0 ? [...shown, `…ほか${rest}${unit}`] : shown;
}

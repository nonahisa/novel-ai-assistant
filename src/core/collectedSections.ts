import type { Chapter } from "../models/chapter";
import { parseCollectedFile } from "./collectedFile";
import type { SplitPart } from "./splitCollected";

/**
 * 合本の中の章の見出し（なろうの【第N章】）から、章の始まりを拾う
 * （設計書6.66.4・6.2.2）。
 *
 * ## 名前について
 *
 * **ここでは章を `section` と呼ぶ。** 合本まわりのコードでは `chapter` が
 * **話数**を指す（`CollectedEpisode.chapter`＝「１話」の1、`SplitPart.chapter`
 * も同じ）。章の見出しは `part` という欄で読まれている。同じ語を別の意味で
 * 使うと、次に読む人が取り違えるので、章は `section` で通す。台帳へ書く
 * ところだけは製品の型（`Chapter`）に合わせる。
 *
 * ## なぜ分けるときに立てるのか
 *
 * **章の台帳はファイルしか指せない**（`Chapter.startEpisodePath`）。合本の
 * ままでは、2章目以降の始まりの話を指す場所が無い——合本の途中には章を
 * 置けない（6.66.4）。分けたあとなら、始まりの話が実在のファイルになる。
 *
 * VS Code API には依存しない。
 */

/** 章の始まり1つ */
export interface CollectedSectionStart {
  /** 章の題。**そのまま持つ**（前後の空白だけ落とす） */
  readonly name: string;
  /** 始まりの話の区切り行の番号（「エピソードN開始」のN）。作者に見せる */
  readonly startOrder: number;
  /** 始まりの話が、渡した並びの何番目か（0始まり）。ファイルへ戻すのに使う */
  readonly startIndex: number;
}

/**
 * 章の見出しが変わった話ごとに、章を1つ立てる。
 *
 * - **見出しの無い話は直前の章に入る。** なろうの合本は【第N章】を
 *   章の最初の話にしか付けない（作者の `N5078JI.txt` で、5章31話に見出し5つ）
 * - **最初の章より前の話は、どの章にも入れない。** 作者が書いていない章を
 *   こちらで作らない（`chapterGrouping.ts` の「章なし」と同じ扱い）
 * - **同じ題が続いても2つ目を別の章にしない。** 章題を話ごとに繰り返す形が
 *   あっても、章は1つである
 */
export function collectedSectionStarts(
  episodes: readonly { readonly order: number; readonly part: string | null }[]
): CollectedSectionStart[] {
  const sections: CollectedSectionStart[] = [];
  let current: string | null = null;

  episodes.forEach((episode, index) => {
    const name = episode.part?.trim() ?? "";
    // 空白だけの見出しは「無い」のと同じ。空の名前の章は台帳が受け付けない
    if (name === "" || name === current) return;
    sections.push({ name, startOrder: episode.order, startIndex: index });
    current = name;
  });

  return sections;
}

/**
 * 分け方（`planSplit`）の1話ずつから、章の始まりを拾う。
 *
 * **章の見出しの読み方は `parseCollectedFile` の1か所に任せる。** 分割の
 * 断片は区切り行から始まるので、1話ぶんの合本としてそのまま読める。
 * ここで【第N章】の読み方を写すと、合本の読み取りと分割とで章の題が
 * 食い違う日が来る。
 */
export function splitPartSections(
  parts: readonly SplitPart[]
): CollectedSectionStart[] {
  return collectedSectionStarts(
    parts.map((part) => ({
      order: part.order,
      part: parseCollectedFile(part.text)?.[0]?.part ?? null,
    }))
  );
}

/**
 * 章の見出しから章を立てるとき、台帳をどうするか。
 *
 * 合本を分けるとき（`planSplitSections`）と、分け済みの話ごとのファイルから
 * 読むとき（`planEpisodeSections`）の両方がこの形を返す。**守りは同じ**
 * ——台帳が空のときだけ立てる。
 */
export type SectionPlan =
  /** 章の見出しが無い。何もしない（確認画面にも出さない） */
  | { readonly kind: "none" }
  /**
   * 台帳に既に章がある。**立てない**（作者の章を上書きしない。実装ルール2）。
   * 見出しそのものは原稿に残る（どちらの道も原稿の中身に触らない）
   */
  | {
      readonly kind: "existing";
      readonly sections: readonly CollectedSectionStart[];
      readonly existingCount: number;
    }
  /** 台帳を読めなかった（壊れているなど）。**立てない** */
  | {
      readonly kind: "unreadable";
      readonly sections: readonly CollectedSectionStart[];
    }
  /** 台帳が空なので、実在のファイルを指して章を立てる */
  | {
      readonly kind: "create";
      readonly sections: readonly CollectedSectionStart[];
      readonly chapters: readonly Chapter[];
    };

/**
 * 拾った章の始まりと、いまの台帳から、台帳へ書くものを決める。
 *
 * **台帳が空のときだけ立てる。** 1つでも章があれば、作者が自分で章を
 * 組んでいる——そこへ見出しから作った章を混ぜると、作者の組んだ
 * 切れ目の間にこちらの章が挟まり、どれが作者のものか分からなくなる。
 * 足りない章を足すかどうかは、作者が見て決める。
 *
 * @param existingChapters いまの台帳の章。**読めなかったときは null**
 * @param startPathAt 始まりの話（並びの何番目か）から、台帳に書く相対パスを作る
 */
function sectionPlanFrom(
  sections: readonly CollectedSectionStart[],
  existingChapters: readonly Chapter[] | null,
  startPathAt: (index: number) => string
): SectionPlan {
  if (sections.length === 0) return { kind: "none" };

  if (existingChapters === null) return { kind: "unreadable", sections };
  if (existingChapters.length > 0) {
    return {
      kind: "existing",
      sections,
      existingCount: existingChapters.length,
    };
  }

  return {
    kind: "create",
    sections,
    chapters: sections.map((section) => ({
      name: section.name,
      startEpisodePath: startPathAt(section.startIndex),
    })),
  };
}

/**
 * 分けたあとで台帳へ書くものを決める。**まだ何も書かない。**
 * 守りは `sectionPlanFrom`（台帳が空のときだけ立てる）。
 *
 * @param existingChapters いまの台帳の章。**読めなかったときは null**
 * @param startPathOf 分けたファイルの名前から、台帳に書く相対パスを作る
 */
export function planSplitSections(input: {
  parts: readonly SplitPart[];
  existingChapters: readonly Chapter[] | null;
  startPathOf: (fileName: string) => string;
}): SectionPlan {
  return sectionPlanFrom(
    splitPartSections(input.parts),
    input.existingChapters,
    (index) => input.startPathOf(input.parts[index].fileName)
  );
}

/** 確認画面に並べる章の題の数。多すぎると肝心の件数まで読まれない */
const LISTED_SECTIONS = 3;

/**
 * 分割の確認画面に足す一文。**章の見出しが無い合本では null**（何も足さない）。
 *
 * 押す前に、台帳に何が起きるかを見せる（実装ルール2）。台帳に既に章が
 * あって立てないときも、**立てないこと**を言う——言わないと、分けたあとで
 * 「見出しは読めたはずなのに章ができていない」と見える。
 */
export function describeSplitSections(plan: SectionPlan): string | null {
  switch (plan.kind) {
    case "none":
      return null;
    case "create":
      return `合本の章の見出しから、章を${plan.sections.length}個立てます：${listSections(
        plan.sections
      )}`;
    case "existing":
      return (
        `章の台帳に既に章が${plan.existingCount}個あるため、合本の章の見出し` +
        `（${plan.sections.length}個）から章は立てません。見出しは分けたファイルに残ります。`
      );
    case "unreadable":
      return (
        "章の台帳を読めなかったため、合本の章の見出し" +
        `（${plan.sections.length}個）から章は立てません。見出しは分けたファイルに残ります。`
      );
  }
}

/* ── 分け済みの話ごとのファイルから読む ─────────────────── */

/**
 * 話ごとのファイル1つぶんの材料。**作品一覧に出る順**（走査の並び）で渡す。
 *
 * 並べ替えはしない——章の切れ目を決めるのは作品一覧と同じ並び
 * （`chapterGrouping.ts` と同じ約束）。
 */
export interface EpisodeHeadingSource {
  /** 台帳に書く、作品フォルダからの相対パス（`episodePathFor` の形） */
  readonly startEpisodePath: string;
  /** 作者に見せる見出し（「第1話」。読めなければファイル名） */
  readonly label: string;
  /** ファイルの全文。**読めなかったときは null** */
  readonly text: string | null;
}

/** 話ごとのファイルを読んだ結果 */
export interface EpisodeSectionReading {
  /** 章の始まり。`startIndex` は渡した並びの何番目か */
  readonly sections: readonly CollectedSectionStart[];
  /** 読めなかったファイルの数（見出しがあったかどうか分からない） */
  readonly unreadable: number;
  /**
   * 合本の2話目以降にあって、**章として置けない**見出しの数。
   *
   * 台帳はファイルしか指せない（6.66.4）ので、合本の途中から始まる章は
   * 置き場が無い。**1つでもあれば、呼ぶ側は1章も立てずに「先に分ける」へ
   * 案内する**——頭の章だけ立てると台帳が空でなくなり、分けるときに
   * 残りの章が立たなくなる（案Aの守りが「既に章がある」と見る）。
   */
  readonly insideCollected: number;
}

/**
 * 分け済みの作品の、話ごとのファイルの頭にある章の見出しを拾う。
 *
 * なろうの合本を「合本を話ごとに分ける」で分けると、章の最初の話の
 * ファイルの頭に `【第N章】` と章の題が残る（分割は中身に触らない）。
 * **台帳を書くだけで章が立つ**——原稿のファイルの並びは変えない。
 *
 * **読み方は `parseCollectedFile` に任せる**（合本を分けるときと同じ）。
 * 区切り行（「エピソードN開始」）の無いファイルからは拾わない——
 * 区切り行の無い原稿の `【第1章】` は、なろうの見出しかどうか決められない。
 */
export function readEpisodeSections(
  sources: readonly EpisodeHeadingSource[]
): EpisodeSectionReading {
  let unreadable = 0;
  let insideCollected = 0;

  const heads = sources.map((source, index) => {
    if (source.text === null) {
      unreadable++;
      return { order: index + 1, part: null };
    }
    const inner = parseCollectedFile(source.text) ?? [];
    insideCollected += inner
      .slice(1)
      .filter((episode) => (episode.part?.trim() ?? "") !== "").length;
    return { order: index + 1, part: inner[0]?.part ?? null };
  });

  return {
    sections: collectedSectionStarts(heads),
    unreadable,
    insideCollected,
  };
}

/**
 * 話ごとのファイルの見出しから、台帳へ書くものを決める。**まだ何も書かない。**
 * 守りは合本を分けるときと同じ（`sectionPlanFrom`：台帳が空のときだけ）。
 */
export function planEpisodeSections(input: {
  sources: readonly EpisodeHeadingSource[];
  reading: EpisodeSectionReading;
  existingChapters: readonly Chapter[] | null;
}): SectionPlan {
  return sectionPlanFrom(
    input.reading.sections,
    input.existingChapters,
    (index) => input.sources[index].startEpisodePath
  );
}

/** 確認画面に1行ずつ並べる章の数。これを超えたら「ほか」にまとめる */
const LISTED_EPISODE_SECTIONS = 30;

/**
 * 「話の見出しから章を立てる」の確認画面の本文。
 *
 * **章を全部並べる**（多すぎるときだけ「ほか」）。押す前に、どの章が
 * どの話から始まるかを作者が見て確かめられるようにする（実装ルール2）。
 * 置けなかった見出し・読めなかったファイルがあれば、その数も言う。
 */
export function describeEpisodeSections(
  sections: readonly CollectedSectionStart[],
  sources: readonly EpisodeHeadingSource[],
  reading: EpisodeSectionReading
): string {
  const lines = sections
    .slice(0, LISTED_EPISODE_SECTIONS)
    .map(
      (section) =>
        `・${section.name}　← ${sources[section.startIndex].label}から`
    );
  const rest = sections.length - LISTED_EPISODE_SECTIONS;
  if (rest > 0) lines.push(`…ほか${rest}個`);

  // 合本の途中の見出しがあるときは、呼ぶ側が確認の前に止める
  // （`chaptersFromHeadings.ts`）ので、ここでは言わない
  const notes: string[] = [];
  if (reading.unreadable > 0) {
    notes.push(
      `読めなかったファイルが${reading.unreadable}件あります（そこに見出しがあっても拾えていません）。`
    );
  }
  notes.push("章立ての台帳（設定/章立て.json）に書くだけで、原稿は書き換えません。");

  return [...lines, "", ...notes].join("\n");
}

/** 「A」（1話から）「B」（5話から）…ほかN個 */
function listSections(sections: readonly CollectedSectionStart[]): string {
  const listed = sections
    .slice(0, LISTED_SECTIONS)
    .map((section) => `「${section.name}」（エピソード${section.startOrder}から）`)
    .join("");
  const rest = sections.length - LISTED_SECTIONS;
  return rest > 0 ? `${listed}ほか${rest}個` : listed;
}

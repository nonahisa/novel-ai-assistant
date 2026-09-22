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

/** 分けるときに章をどうするか */
export type SplitSectionPlan =
  /** 合本に章の見出しが無い。何もしない（確認画面にも出さない） */
  | { readonly kind: "none" }
  /**
   * 台帳に既に章がある。**立てない**（作者の章を上書きしない。実装ルール2）。
   * 見出しそのものは分けたファイルに残る（分割は中身に触らない）
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
  /** 台帳が空なので、分けたファイルを指して章を立てる */
  | {
      readonly kind: "create";
      readonly sections: readonly CollectedSectionStart[];
      readonly chapters: readonly Chapter[];
    };

/**
 * 分けたあとで台帳へ書くものを決める。**まだ何も書かない。**
 *
 * **台帳が空のときだけ立てる。** 1つでも章があれば、作者が自分で章を
 * 組んでいる——そこへ合本の見出しから作った章を混ぜると、作者の組んだ
 * 切れ目の間にこちらの章が挟まり、どれが作者のものか分からなくなる。
 * 足りない章を足すかどうかは、作者が見て決める。
 *
 * @param existingChapters いまの台帳の章。**読めなかったときは null**
 * @param startPathOf 分けたファイルの名前から、台帳に書く相対パスを作る
 */
export function planSplitSections(input: {
  parts: readonly SplitPart[];
  existingChapters: readonly Chapter[] | null;
  startPathOf: (fileName: string) => string;
}): SplitSectionPlan {
  const sections = splitPartSections(input.parts);
  if (sections.length === 0) return { kind: "none" };

  if (input.existingChapters === null) return { kind: "unreadable", sections };
  if (input.existingChapters.length > 0) {
    return {
      kind: "existing",
      sections,
      existingCount: input.existingChapters.length,
    };
  }

  return {
    kind: "create",
    sections,
    chapters: sections.map((section) => ({
      name: section.name,
      startEpisodePath: input.startPathOf(
        input.parts[section.startIndex].fileName
      ),
    })),
  };
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
export function describeSplitSections(plan: SplitSectionPlan): string | null {
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

/** 「A」（1話から）「B」（5話から）…ほかN個 */
function listSections(sections: readonly CollectedSectionStart[]): string {
  const listed = sections
    .slice(0, LISTED_SECTIONS)
    .map((section) => `「${section.name}」（エピソード${section.startOrder}から）`)
    .join("");
  const rest = sections.length - LISTED_SECTIONS;
  return rest > 0 ? `${listed}ほか${rest}個` : listed;
}

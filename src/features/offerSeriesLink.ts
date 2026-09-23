import * as vscode from "vscode";
import { shouldOfferSeriesLink } from "../core/seriesLink";
import { readWorkConfig } from "../core/workRegistry";
import type { WorkEntry } from "../models/types";

/**
 * 書庫に作品が並んだとき、1度だけ、シリーズとしてつなぐかを訊く（6.95.4）。
 *
 * ## 訊くのは一度きり
 *
 * 設計書6.95.4：「訊きすぎると邪魔になるので、初回の1度だけにする」。
 * **`offerLibraryMerge.ts` と同じ作法**——先に「訊いた」と覚えてから出し、
 * 閉じられても次の登録でまた出ることはない。あとから詳細メニューの
 * 「シリーズとしてつなぐ」でいつでも呼べる。
 *
 * ## 判断は core に置く
 *
 * 出すかどうかは `core/seriesLink.ts` の `shouldOfferSeriesLink` が決める。
 * **画面を押さずに測れるようにするため**で、ここは繋ぎこみだけを持つ。
 */

/** 訊いたことを覚えておく鍵（`globalState`。作品ごとではなく環境ごと） */
export const SERIES_OFFERED_KEY = "novelai.series.linkOffered";

/** ボタンの文言。ここ1か所に置く */
export const SERIES_ACTION_LABEL = "シリーズ連結";

export interface SeriesLinkOfferDeps {
  /** 登録し終えたあとの、すべての作品 */
  readonly works: readonly { folderPath: string }[];
  /** いま登録した作品 */
  readonly added: { folderPath: string };
  /** その作品にもうシリーズが設定されているか */
  readonly addedHasSeries: boolean;
  readonly wasOffered: () => boolean;
  readonly markOffered: () => Promise<void>;
  /** 案内を出す。押されたボタンの文言を返す */
  readonly notify: (
    message: string,
    action: string
  ) => Promise<string | undefined>;
  /** 「シリーズとしてつなぐ」を走らせる */
  readonly link: () => Promise<void>;
}

export async function offerSeriesLink(
  deps: SeriesLinkOfferDeps
): Promise<void> {
  const should = shouldOfferSeriesLink({
    works: deps.works,
    added: deps.added,
    addedHasSeries: deps.addedHasSeries,
    alreadyOffered: deps.wasOffered(),
  });
  if (!should) return;

  // **先に覚える。** 途中で閉じられても、次の登録でまた出るのは邪魔である
  await deps.markOffered();

  const answer = await deps.notify(
    "同じフォルダーに、ほかの作品が並んでいます。" +
      "同じ世界・同じ人物の作品なら、つないでおくと名前の表記が揃います" +
      "（相手の名前と読み仮名だけを借ります。中身は読まず、相手の資料も書き換えません）。",
    SERIES_ACTION_LABEL
  );
  if (answer !== SERIES_ACTION_LABEL) return;
  await deps.link();
}

/** VS Code に繋いだ形 */
export async function offerSeriesLinkInVsCode(
  context: vscode.ExtensionContext,
  works: readonly WorkEntry[],
  added: WorkEntry
): Promise<void> {
  let addedHasSeries = false;
  try {
    addedHasSeries = Boolean((await readWorkConfig(added))?.series);
  } catch {
    // 設定が読めないなら「まだつないでいない」として扱う。
    // 訊くだけなので、読めないことで止める理由がない
  }

  await offerSeriesLink({
    works,
    added,
    addedHasSeries,
    wasOffered: () => context.globalState.get<boolean>(SERIES_OFFERED_KEY, false),
    markOffered: async () => {
      await context.globalState.update(SERIES_OFFERED_KEY, true);
    },
    notify: async (message, action) =>
      vscode.window.showInformationMessage(message, action),
    link: async () => {
      await vscode.commands.executeCommand("novelai.setSeries", added);
    },
  });
}

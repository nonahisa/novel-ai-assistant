import * as vscode from "vscode";
import {
  shouldOfferLibraryMerge,
  type WorkLocation,
} from "../core/libraryHome";

/**
 * 2作目を書庫の外へ登録したときだけ、1度だけ、まとめるかを訊く（設計書6.97.3）。
 *
 * 作者の言葉（2026-09-19）：「既存資産がある場合も書庫へ統合を促しても
 * よいかもしれません」。
 *
 * ## 促すのは、その一瞬だけ
 *
 * **1作目では勧めない**（まとめる利点が見えない）。**3作目以降でも勧めない**
 * （断った作者に言い続ければ小言になる）。**書庫の外に2つ目が並んだ瞬間**が、
 * 「まとめると同期が1回で済みます」と言える最初で最後の機会である。
 *
 * ## まとめるのは写すだけ
 *
 * 実際の作業は既存の「作品を書庫にまとめる」（`mergeIntoLibrary`）へ渡す。
 * **元のフォルダーは消さない**という作法も、そちらのものをそのまま使う
 * ——ここで別の写し方を作ると、危ない道が2本になる。
 */

/** 勧めたことを覚えておく鍵（`globalState`。作品ごとではなく環境ごと） */
export const MERGE_OFFERED_KEY = "novelai.library.mergeOffered";

/** 勧めるときの言葉。ボタンの文言はここ1か所に置く */
export const MERGE_ACTION_LABEL = "書庫にまとめる";

export interface LibraryMergeOfferDeps {
  /** 登録し終えたあとの、すべての作品 */
  readonly works: readonly WorkLocation[];
  /** いま登録した作品 */
  readonly added: WorkLocation;
  /** 前に一度勧めたか */
  readonly wasOffered: () => boolean;
  readonly markOffered: () => Promise<void>;
  /** 案内を出す。押されたボタンの文言を返す */
  readonly notify: (
    message: string,
    action: string
  ) => Promise<string | undefined>;
  /** 「作品を書庫にまとめる」を走らせる */
  readonly merge: () => Promise<void>;
}

/**
 * 勧めるかどうかを判断して、勧める。
 *
 * **先に「勧めた」と覚える。** 途中で閉じられても、次の登録でまた出るのは
 * 邪魔である（`firstRun.ts` と同じ形）。あとから詳細メニューの
 * 「作品を書庫にまとめる」でいつでも呼べる。
 */
export async function offerLibraryMerge(
  deps: LibraryMergeOfferDeps
): Promise<void> {
  const should = shouldOfferLibraryMerge({
    works: deps.works,
    added: deps.added,
    alreadyOffered: deps.wasOffered(),
  });
  if (!should) return;

  await deps.markOffered();

  const answer = await deps.notify(
    "作品が2つになりました。1つのフォルダーにまとめておくと、" +
      "GitHubとのやり取りが1回で済み、別のパソコンでも一度で全部そろいます。" +
      "（まとめるのは写すだけで、元のフォルダーは消しません）",
    MERGE_ACTION_LABEL
  );
  if (answer !== MERGE_ACTION_LABEL) return;
  await deps.merge();
}

/** VS Code に繋いだ形 */
export function offerLibraryMergeInVsCode(
  context: vscode.ExtensionContext,
  works: readonly WorkLocation[],
  added: WorkLocation
): Promise<void> {
  return offerLibraryMerge({
    works,
    added,
    wasOffered: () => context.globalState.get<boolean>(MERGE_OFFERED_KEY, false),
    markOffered: async () => {
      await context.globalState.update(MERGE_OFFERED_KEY, true);
    },
    notify: async (message, action) =>
      vscode.window.showInformationMessage(message, action),
    merge: async () => {
      await vscode.commands.executeCommand("novelai.mergeIntoLibrary");
    },
  });
}

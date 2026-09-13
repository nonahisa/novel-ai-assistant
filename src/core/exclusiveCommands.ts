/**
 * 同時に2本走らせない操作の一覧（作者の報告 2026-09-12
 * 「すべて同期を2回押してしまうことがあったが、複数立ちあがった。
 * 2件動かす意味はないので重複起動しないようにできないか？」）。
 *
 * まとめて同期を続けて2回押すと、2つが同時に走り、進み具合の表示も2つ出た。
 * **同じ置き場へ同じ git の操作を2本走らせるのは、意味が無いだけでなく危ない。**
 *
 * **塞ぐのは、2本目に意味が無いものだけ。** 線引きは次のとおり。
 *
 * - **同期の系**：同じ置き場（リポジトリ）へ同じ git の操作を2本走らせない
 * - **AIを長く回す系**：2回ぶん送れば2回ぶん待ち、クラウドAIなら2回ぶん課金される
 * - **本文をまとめて書き換える系**：同じファイルを2本が同時に書きに行く
 * - **取り寄せ・下ごしらえ**：同じ場所へ2本が同時に入れに行く
 *
 * **画面を開くだけのもの（パネル・一覧・設定・ヘルプ）、切り替え、`refresh`
 * は入れない。** 同じ画面を2回開いても害が無いし、押せないほうが困る。
 *
 * **ここへ並べるIDは `package.json` に実在するものだけ。** ただの文字列なので
 * 綴り違いは型検査を素通りし、押しても何も起きないまま気づかれない
 * （`EDITOR_ALLOWED` で実際に起きた。0.47.3）。
 * `test/unit/exclusiveCommands.test.ts` が突き合わせる。
 *
 * VS Code APIに依存しない。
 */

export interface ExclusiveCommand {
  /** `package.json` の `contributes.commands` に実在するコマンドID */
  id: string;
  /** 断りの文言に出す日本語。`package.json` の `title` と揃える */
  label: string;
}

export const EXCLUSIVE_COMMANDS: readonly ExclusiveCommand[] = [
  // 同期の系。同じ置き場へ同じ git の操作を2本走らせない
  { id: "novelai.syncAllWorks", label: "作品をすべて同期" },
  { id: "novelai.gitSync", label: "GitHubと同期" },
  { id: "novelai.resolveConflicts", label: "競合解決" },
  { id: "novelai.resolveDivergence", label: "分かれた分を合わせる" },

  // AIを長く回す系。2回ぶん送れば2回ぶん待ち、クラウドAIなら2回ぶん課金される
  { id: "novelai.checkTypos", label: "誤字脱字を検知" },
  { id: "novelai.checkNotation", label: "表記ゆれを検知" },
  { id: "novelai.checkProofread", label: "推敲する" },
  { id: "novelai.checkContradictions", label: "矛盾を検知" },
  { id: "novelai.checkFactContradictions", label: "矛盾検知（事実の照合）" },
  { id: "novelai.checkDeviations", label: "プロットからの逸脱を検知" },
  { id: "novelai.checkForeshadows", label: "伏線を検知する" },
  { id: "novelai.checkForeshadowResolution", label: "伏線の回収を確かめる" },
  { id: "novelai.checkEpisodePlot", label: "単話プロットを検査" },
  { id: "novelai.checkOpening", label: "冒頭を診断" },
  // 指示の `novelai.extractCharacters` は実在しない。人物の抽出は
  // 種別ごとに分かれており（6.17.2）、その人物のぶんがこれである
  { id: "novelai.extractCharactersOnly", label: "人物を抽出" },
  { id: "novelai.extractLocationsOnly", label: "場所を抽出" },
  { id: "novelai.extractAbilitiesOnly", label: "能力を抽出" },
  { id: "novelai.extractOrganizationsOnly", label: "組織を抽出" },
  { id: "novelai.extractWorldOnly", label: "世界観を抽出" },
  { id: "novelai.extractSettings", label: "設定資料をまとめて抽出" },
  { id: "novelai.runProofreadingSuite", label: "校正をまとめて実行" },
  { id: "novelai.generateSynopses", label: "各話あらすじを生成" },
  { id: "novelai.proposeChapters", label: "章立てをAIに提案させる" },
  { id: "novelai.measureContext", label: "AIチューニング" },

  // 本文をまとめて書き換える系。同じファイルを2本が同時に書きに行く
  { id: "novelai.unifyEol", label: "改行コードを揃える" },
  { id: "novelai.applyPendingUpdates", label: "更新分を反映" },
  { id: "novelai.unifyCharacters", label: "重複をまとめる" },

  // 取り寄せ・下ごしらえ。同じ場所へ2本が同時に入れに行く
  { id: "novelai.addWorkFromGithub", label: "GitHubから作品を追加" },
  { id: "novelai.runFullSetup", label: "セットアップ" },
  { id: "novelai.setupOllama", label: "Ollamaのセットアップ" },
  { id: "novelai.setupLmStudio", label: "LM Studioのセットアップ" },
  /*
    **意味検索の準備（`novelai.setupVectorSearch`）は、ここへ入れない。**

    この操作は**自分自身を呼び直す道を持っている**。索引づくり
    （`buildVectorIndex`）の途中で意味検索が「切」だと「準備を開く」が出て、
    そこから `setupVectorSearch` を実行する（`extension.ts`・`vectorSearch.ts`）。
    外側がまだ走っているので、塞ぐと**その案内を押しても断られる**。
    行き止まりにはならないが、**いま通っている道を塞ぐ理由が無い。**

    重いのは索引づくりのほうで、そちらは下で塞いである。
  */
  { id: "novelai.buildVectorIndex", label: "検索用の索引を作る・更新する" },
];

/** 引き当て用の索引。一覧は固定なので、読み込み時に一度だけ組む */
const BY_ID = new Map(EXCLUSIVE_COMMANDS.map((entry) => [entry.id, entry]));

/**
 * 塞ぐ対象なら、断りの文言に出す日本語を返す。
 *
 * @returns 対象でなければ `undefined`
 */
export function exclusiveLabelOf(id: string): string | undefined {
  return BY_ID.get(id)?.label;
}

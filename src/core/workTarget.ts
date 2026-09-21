/**
 * 「どの作品について」を、訊く前に当てる（設計書6.68.2／6.104）。
 *
 * ## なぜ要るか
 *
 * 作品を引数に取るコマンドは、引数が無ければ作品を選ばせる。だが
 * **画面には既に「この作品」と出ていることがある**——相談パネルが
 * 作品を名指しで表示しているとき、そこから案内（6.104）の札で
 * ターゲット読者診断へ入ると、**いま相談している作品をもう一度選ばされる**
 * （作者の指摘）。作品一覧で作品を選んでいるときも同じである。
 *
 * **選び直させないのは、手間だからではない。** 別の作品を選んでしまえば、
 * 画面に出ている作品とは違う作品の資料が書き換わる。
 *
 * ## なぜ純粋な関数にするか
 *
 * 当てどころの順（引数 → ツリーの選択 → 相談の対象 → 訊く）は、
 * 画面を開かないと確かめられない場所（`extension.ts` の `resolveWork`）に
 * 埋まっていた。順番だけをここへ出しておけば、画面なしで確かめられる。
 *
 * VS Code API に依存しない。
 */

/** どこから作品を決めたか。理由を持たせるのは、記録と検査のため */
export type WorkTargetSource =
  /** 登録が1作品しかない。選ばせる意味がない */
  | "single"
  /** 作品一覧（ツリー）で選ばれている */
  | "tree"
  /** 相談パネルがいま対象にしている */
  | "chat";

export interface WorkTargetHints {
  /** 登録簿にある作品のID。ここに無いものは当てどころにしない */
  registeredIds: readonly string[];
  /** 作品一覧で選ばれている作品のID（一覧が見えていないときは渡さない） */
  treeSelectedId?: string;
  /** 相談パネルがいま対象にしている作品のID（開いていないときは渡さない） */
  chatTargetId?: string;
}

/**
 * 名指し（コマンドの引数）が無いときに、画面で指している作品を当てる。
 *
 * **返せないときは undefined**（呼び出し側が作者に訊く）。当てずっぽうに
 * 「たぶんこれだろう」とは決めない——外したときに、別の作品の資料が
 * 書き換わるためである。
 *
 * 当てどころは**登録簿に在ることを確かめてから**返す。ツリーの選択も
 * 相談の対象も、作品が登録から外れたあとしばらく残ることがある。
 */
export function pickHintedWork(
  hints: WorkTargetHints
): { workId: string; source: WorkTargetSource } | undefined {
  const registered = new Set(hints.registeredIds);
  if (registered.size === 0) return undefined;

  // **1作品しか無いなら、そこしかない。** 画面で何を指していても同じ
  if (hints.registeredIds.length === 1) {
    return { workId: hints.registeredIds[0], source: "single" };
  }

  // **ツリーの選択が先。** 作品一覧は「いまどの作品を見ているか」を
  // いちばん直接に表している（相談は前の作品のまま残ることがある）
  if (hints.treeSelectedId && registered.has(hints.treeSelectedId)) {
    return { workId: hints.treeSelectedId, source: "tree" };
  }

  if (hints.chatTargetId && registered.has(hints.chatTargetId)) {
    return { workId: hints.chatTargetId, source: "chat" };
  }

  return undefined;
}

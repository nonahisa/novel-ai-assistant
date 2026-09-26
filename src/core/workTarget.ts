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

/**
 * 作品を選ぶ一覧で、**直前に使った作品を一番上へ出す**（作者の裁定 J13、
 * 2026-09-26）。
 *
 * ## なぜ一覧を出したまま先頭へ置くのか
 *
 * 作者の希望は「直前の作品を既定にして、変えたいときだけ選び直す」。
 * 一覧を出さずに直前の作品で走らせると、作品を替えたつもりで替え忘れたとき
 * 別の作品で検知が走る。**一覧は出し、先頭に置く**——VS Code の一覧は
 * 先頭が選ばれた状態で開くので、Enter だけで進める。
 *
 * ## なぜ残りの順を変えないのか
 *
 * 作品の並び（登録順や「溜まっている作品を上」）は、それぞれの呼び出し側が
 * 理由を持って決めている。ここで動かすのは直前の1件だけにする。
 *
 * 登録から外れたIDは当てにしない（`pickHintedWork` と同じ理由）。
 */
export function orderByLastWork<T extends { id: string }>(
  works: readonly T[],
  lastWorkId: string | undefined
): { ordered: T[]; lastFirst: boolean } {
  const index =
    lastWorkId === undefined
      ? -1
      : works.findIndex((work) => work.id === lastWorkId);
  if (index < 0) return { ordered: [...works], lastFirst: false };
  return {
    ordered: [works[index], ...works.filter((_, i) => i !== index)],
    lastFirst: true,
  };
}

/**
 * 作品を**推し量って**決めたときの、決め方（作者の裁定、2026-09-23）。
 *
 * - `"tree"`：作品一覧（ツリー）で選ばれていた
 * - `"chat"`：相談パネルがいま対象にしていた（相談からの実行を含む）
 * - `"file"`：開いているファイルがその作品の中にあった
 *
 * **1作品しか登録が無いとき（`"single"`）は含めない。** 取り違える相手が
 * いないので、推し量ったことにしなくてよい。
 */
export type InferredWorkSource = "tree" | "chat" | "file";

/**
 * 推し量って決めた作品の印。
 *
 * ## なぜ要るか
 *
 * ノートPCの実機（2026-09-23）で、作品一覧の行を誤って選んでいたため、
 * 詳細メニューの「場所を抽出」が**作者の本物の作品**で確認画面まで進んだ。
 * 確認で「以降は訊かない」を選んでいれば、**約1時間30分の抽出が黙って走る。**
 * 作者の裁定は「推し量ったときは、覚えていても確認を出す。右クリックや
 * 作品を選ぶ画面で名指ししたときは、これまでどおり訊かない」。
 *
 * ## なぜ作品そのものに印を付けるか
 *
 * 作品を決める所（`extension.ts` の `resolveWork` など）と、確認を出す所
 * （`views/notify.ts` の `confirmRun`）のあいだは、**作品の入れ物が
 * そのまま通る**——コマンドは作品を機能へ渡し、機能は確認へ渡すだけである。
 * 決め方を別の引数で運ぶと、コマンドと機能の関数をすべて書き換えることになり、
 * 1か所渡し忘れれば、そこだけ黙って走る。印を入れ物に付けておけば、
 * **作品が届く所には決め方も届く。**
 *
 * ## なぜ写しに付けるか
 *
 * 登録簿（`WorkRegistry.list()`）が返す作品は、同じ入れ物が使い回される
 * ことがある。それに印を付けると、あとで右クリックで名指ししたときまで
 * 「推し量った」ことになる。**印は写しにだけ付け、元には触らない。**
 *
 * `WeakMap` にするのは、写しが要らなくなったら印も一緒に消える
 * ようにするため（覚えたまま溜まり続けない）。
 */
const inferredWorks = new WeakMap<object, InferredWorkSource>();

/**
 * 推し量って決めた作品に印を付けた**写し**を返す。
 *
 * 呼び出し側は、返った写しを元の代わりに使うこと（元には印が付かない）。
 */
export function markInferredWork<T extends object>(
  work: T,
  source: InferredWorkSource
): T {
  const copy = { ...work };
  inferredWorks.set(copy, source);
  return copy;
}

/** その作品は推し量って決めたものか。名指しなら undefined */
export function inferredWorkSource(
  work: object | undefined
): InferredWorkSource | undefined {
  return work ? inferredWorks.get(work) : undefined;
}

/**
 * 確認画面に添える、決め方の言い方。
 *
 * 「なぜ今回は訊かれたのか」が分からないと、作者は「以降は訊かない」が
 * 壊れたと受け取る。**どこから決めたか**を具体的に言う。
 */
export function describeInferredWorkSource(source: InferredWorkSource): string {
  switch (source) {
    case "tree":
      return "作品一覧で選ばれている作品";
    case "chat":
      return "相談パネルの作品";
    case "file":
      return "開いているファイルの作品";
  }
}

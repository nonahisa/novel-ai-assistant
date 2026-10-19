/**
 * 作品一覧の右クリックの品書きから来た命令を、操作ログへ1行残すための部品
 * （0.105.2）。
 *
 * ## なぜ要るか
 *
 * 遅い機械（ノートPC、VS Code 1.141.0）で、作品一覧が描き直された直後に
 * 品書きを押すと、押した行が命令に渡らない・入力欄が一度も開かない、が
 * 起きた（2026-10-12）。見えるのは「何も起きない」だけで、
 * - 押下が命令まで届き、行も渡った（その先で止まった）
 * - 届いたが、行が渡らなかった（描き直しの隙間）
 * - 命令まで届かなかった（品書きの押下が別のものに当たった）
 * のどれなのかを分けられなかった。命令の入口で1行残せば、ログに行が
 * 無いこと自体が「届かなかった」の印になる。
 *
 * ## 何を書くか
 *
 * **命令の名前と行の種類だけ。** 作品名・ファイル名・本文は書かない
 * （ログは作者が人に見せることがある。行の種類で切り分けには足りる）。
 *
 * VS Code API に依存しない（拡張機能の定義〈package.json〉を値で受け取る）。
 */

/**
 * 作品一覧の右クリックの品書き（行の横のボタンを含む）に並ぶ命令を、
 * 拡張機能の定義から拾う。
 *
 * **手で一覧を持たない。** 品書きは版ごとに増えるので、写しを持つと
 * 足し忘れた命令だけログが出ない。定義の `when` に `view == novelai.works` を
 * 含むものを拾う（`viewId` が作品一覧のとき）。
 */
export function treeMenuCommandsFrom(
  packageJson: unknown,
  /**
   * 一覧の画面ID（作品一覧なら `novelai.works`）。**ここに文字で書かない**——
   * 同じ文字列は登録簿の保管庫の鍵でもあり、鍵の文字列を置いてよい所は
   * `mementoWrites.test.ts` が1か所に限っている
   */
  viewId: string
): Set<string> {
  const commands = new Set<string>();
  const entries = (
    packageJson as {
      contributes?: { menus?: Record<string, unknown> };
    } | null | undefined
  )?.contributes?.menus?.["view/item/context"];
  if (!Array.isArray(entries)) return commands;
  // `view == novelai.works` のあとに名前の続き（novelai.worksX）が来ないもの
  const escaped = viewId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`view\\s*==\\s*${escaped}(?![\\w.-])`);
  for (const entry of entries) {
    const { command, when } = (entry ?? {}) as { command?: unknown; when?: unknown };
    if (typeof command === "string" && typeof when === "string" && pattern.test(when)) {
      commands.add(command);
    }
  }
  return commands;
}

/** 行の種類の言い方（`views/workTree.ts` の `TreeNode` の `type`） */
const ROW_KINDS: Readonly<Record<string, string>> = {
  library: "書庫の段",
  work: "作品の行",
  chapter: "章の行",
  episode: "話の行",
  memoFolder: "メモの枝",
  memoFile: "メモの行",
  message: "案内の行",
};

/**
 * 操作ログへ書く1行（時刻は書き手が付ける）。
 *
 * @param arg 命令の最初の引数。品書きからなら押した行、描き直しの隙間なら
 *   `undefined`／`null` が来る
 */
export function describeTreeMenuCall(command: string, arg: unknown): string {
  return `作品一覧の品書きから命令：${command}（${describeRow(arg)}）`;
}

function describeRow(arg: unknown): string {
  if (arg === undefined || arg === null) return "行なし";
  if (typeof arg === "object") {
    const type = (arg as { type?: unknown }).type;
    // `in` だと「constructor」などの継いだ名前まで当たる
    if (typeof type === "string" && Object.prototype.hasOwnProperty.call(ROW_KINDS, type)) {
      return ROW_KINDS[type];
    }
  }
  return "行以外の値";
}

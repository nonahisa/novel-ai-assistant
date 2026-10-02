import { isPathInside } from "./paths";

/**
 * 原稿エディターを開いているときだけ効くキー割り当て（作者の裁定、2026-10-02。
 * 設計書6.25.10）。
 *
 * 「Ctrl+Alt+頭文字で、VS Code の『キーボード ショートカット』で作者が
 * 変えられる形」。**割り当てそのものは package.json の `keybindings` が持つ**
 * ——画面（WebView）の中で受けると、作者が VS Code の画面から変えられない。
 * ここに置くのは、マニュアル（`featureGuide.ts`）と試験が読む同じ表と、
 * 「キーから呼ばれた」ことの見分け方だけである。
 */

/**
 * キーから呼んだときにコマンドへ渡る印（package.json の `args`）。
 *
 * **印が要る理由。** 引数の無い呼び出しでは、コマンドの側は作品を画面の選択
 * （作品一覧・相談の対象）から推し量る。作品一覧で別の作品を選んだまま原稿を
 * 書いていると、キーを押した原稿ではなくそちらで検知が走る。かといって
 * 「前面の原稿」を推し量りの先頭へ置くと、メニューや右クリックから別の作品を
 * 指したときまで原稿が勝ってしまう。**キーから来たときだけ**原稿を見るために、
 * 呼ばれ方そのものに印を付ける。
 */
export const MANUSCRIPT_KEY_SOURCE = "manuscriptEditor";

export interface ManuscriptKeyArgs {
  readonly source: typeof MANUSCRIPT_KEY_SOURCE;
}

/** コマンドの第1引数が、原稿エディターのキーから来た印か */
export function isManuscriptKeyArgs(value: unknown): value is ManuscriptKeyArgs {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { source?: unknown }).source === MANUSCRIPT_KEY_SOURCE
  );
}

export interface ManuscriptKeyBinding {
  /** package.json の書き方（`ctrl+alt+t`）。mac は `cmd+alt+…` に読み替える */
  readonly key: string;
  readonly command: string;
  /** マニュアルに出す呼び名 */
  readonly label: string;
}

/** 作者の裁定の表（2026-10-02）。package.json と食い違うと試験が止める */
export const MANUSCRIPT_KEY_BINDINGS: readonly ManuscriptKeyBinding[] = [
  {
    key: "ctrl+alt+t",
    command: "novelai.checkTyposForFile",
    label: "この話の誤字脱字を検知",
  },
  { key: "ctrl+alt+p", command: "novelai.checkProofread", label: "推敲" },
  { key: "ctrl+alt+h", command: "novelai.checkNotation", label: "表記ゆれ検知" },
  {
    key: "ctrl+alt+a",
    command: "novelai.runProofreadingSuite",
    label: "校正一括実行",
  },
  {
    key: "ctrl+alt+m",
    command: "novelai.openSceneMemos",
    label: "シーンメモ一覧",
  },
  {
    key: "ctrl+alt+n",
    command: "novelai.nextSceneMemo",
    label: "次のシーンメモへ",
  },
  {
    key: "ctrl+alt+b",
    command: "novelai.prevSceneMemo",
    label: "前のシーンメモへ",
  },
  {
    key: "ctrl+alt+i",
    command: "novelai.addSceneMemo",
    label: "ここにシーンメモを足す",
  },
  { key: "ctrl+alt+c", command: "novelai.openChat", label: "AIに相談する" },
];

/**
 * その原稿がどの作品のものか。**入れ子の作品では、いちばん深い作品を選ぶ。**
 *
 * 書庫（1つのフォルダーに複数作品）では、書庫そのものと中の作品の両方が
 * 登録されていることがある。浅いほうを返すと、書庫の別の作品で検知が走る。
 * どこにも入っていなければ undefined——推し量らず、呼んだ側の今までの道
 * （作品を訊く）へ戻す。
 */
export function workForFile<T extends { folderPath: string }>(
  works: readonly T[],
  filePath: string
): T | undefined {
  let best: T | undefined;
  for (const work of works) {
    if (!isPathInside(work.folderPath, filePath)) continue;
    if (!best || work.folderPath.length > best.folderPath.length) best = work;
  }
  return best;
}

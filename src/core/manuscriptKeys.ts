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

/**
 * 作者の裁定の表（2026-10-02、メモとルビは 2026-10-03 に変えた）。
 * package.json と食い違うと試験が止める。
 */
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
    label: "校正・メモパネルを開く",
  },
  /*
    メモの3つは、同時押しを減らした（作者の裁定、2026-10-03「キーが押しにくい」）。
    F8／Shift+F8 は VS Code の「次の問題・前の問題」と同じ形で、本体の側は
    素のエディターが前面のときだけ効くので奪い合わない。F8 は日本語入力の
    変換（半角カナ）にも使うので、変換中は画面が本体へ渡さない
    （manuscriptEditorHtml.ts のキーの区切り）。Ctrl+/ は「行をコメントにする」
    と同じ指の形で、メモの印 // と揃う
  */
  {
    key: "f8",
    command: "novelai.nextSceneMemo",
    label: "次のメモへ",
  },
  {
    key: "shift+f8",
    command: "novelai.prevSceneMemo",
    label: "前のメモへ",
  },
  {
    key: "ctrl+/",
    command: "novelai.addSceneMemo",
    label: "ここにメモを足す",
  },
  { key: "ctrl+alt+c", command: "novelai.openChat", label: "AIに相談する" },
  /*
    傍点（K は圏点）。前は画面の中で Ctrl+Shift+K を受けていたが、Notion の
    デスクトップアプリが Windows 全体で取っていて届かなかった（作者の実機、
    2026-10-03。裁定「既定のキーを変える」）。ほかと同じ Ctrl+Alt+頭文字にし、
    作者が「キーボード ショートカット」で変えられる形へ揃えた
  */
  {
    key: "ctrl+alt+k",
    command: "novelai.addEmphasis",
    label: "選んだ語に傍点を付ける",
  },
  /*
    ルビ。前は画面の中で Ctrl+Shift+R を受けていた。傍点と同じ形にしてほしい
    という作者の依頼（2026-10-03）で、Ctrl+Alt+R にして本体の割り当てへ移した
  */
  {
    key: "ctrl+alt+r",
    command: "novelai.addRuby",
    label: "選んだ語にルビを振る",
  },
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

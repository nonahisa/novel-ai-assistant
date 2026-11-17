import * as nodePath from "node:path";

/**
 * 試しの中の「絶対の道」を、いま動いている OS の形で作る手伝い（2026-11-17）。
 *
 * **作る理由。** 製品の道の部品（`core/pathText.ts`）は OS の `path` を使う。
 * 試しに `"C:\\novels\\work"` や `path.join("C:", "novels")` を直に書くと、
 * Mac では区切りが「/」なので**相対の道**として読まれ、保存のときに今いる
 * フォルダーの下を指して落ちていた（Mac の `npm run test:unit` で 113ファイル）。
 * 製品は Mac でも正しく動くので、直すのは試しの側である。
 *
 * **道の形そのものに意味の無い試しは、ここで作る。** ドライブ文字の大小・円記号・
 * UNC など **Windows の道の扱いそのもの**を確かめる試しは、ここへ置き換えると
 * 意味が変わるので、`it.runIf(isWindowsHost)` で Windows だけにする。
 */
export const isWindowsHost = process.platform === "win32";

/**
 * 道の区切り（Windows は `\`、それ以外は `/`）。作り物のファイルの仕組みが
 * 「直下の名前」を切り出すときに使う（`"\\"` を直に書くと Mac で直下が見えない）
 */
export const SEP = nodePath.sep;

/**
 * `process.platform` をしばらく別の OS に見せる。戻す関数を返す。
 *
 * **キーの書き方や案内の文言**（Windows は Ctrl、Mac は ⌘）は、製品が動いている
 * OS で変わる（`core/keyLabels.ts`・`core/runtime.ts`）。Windows の文言そのものを
 * 確かめる試しを Mac でも同じ意味で流すために使う（Mac の文言は別の試しが見る）。
 * 道の部品（`path`）は読み込んだ時点の OS のままなので、道の形は変わらない
 */
export function pinHostPlatform(platform: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  return () => {
    if (original) Object.defineProperty(process, "platform", original);
  };
}

/** 道の根（Windows は `C:\`、それ以外は `/`） */
export const ROOT = isWindowsHost ? "C:\\" : "/";

/**
 * 根から下の道をつなぐ。`absPath("novels", "work")` は
 * Windows で `C:\novels\work`、Mac で `/novels/work`。
 * 区切りを含む1つの文字列（`"novels/work"`）を渡してもよい（`join` が揃える）
 */
export function absPath(...segments: string[]): string {
  return nodePath.join(ROOT, ...segments);
}

/**
 * `absPath` を、VS Code の `Uri.fsPath` が返す形にする（Windows ではドライブ文字が
 * 小文字の `c:\…`。Mac では `absPath` と同じ）。作り物のディスクの鍵を `fsPath` で
 * 引く試しは、こちらで場所を作らないと鍵が合わない
 */
export function fsPathOf(...segments: string[]): string {
  return absPath(...segments).replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
}

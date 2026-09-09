/**
 * 既定と違う宛先を使っているときに、接続の知らせへ添える印。
 *
 * AIの宛先（`novelai.*.endpoint`）は `machine` スコープにして、作品
 * リポジトリの `.vscode/settings.json` からは書けないようにした。
 * これはその**保険**である——設定が何らかの理由で差し替わっていても、
 * 「◯◯に接続しました」だけでは、原稿と鍵がどこへ送られているのかが
 * 作者に見えない。
 *
 * **既定のままなら何も出さない。** 普段の画面に余計な文字を足さないため、
 * 印が出ること自体を「いつもと違う」の合図にする。
 */
export function customEndpointNotice(
  endpoint: string,
  defaultEndpoint: string
): string {
  const configured = endpoint.trim();
  // 設定を空にしただけのときは、呼ぶ側が既定へ落としている
  if (configured.length === 0) return "";
  if (normalize(configured) === normalize(defaultEndpoint)) return "";

  return `（宛先: ${hostOf(configured)}）`;
}

/** 末尾のスラッシュの有無だけの違いは、同じ宛先とみなす */
function normalize(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "");
}

/**
 * 宛先のうち、作者に見せる部分。
 *
 * ホスト（とポート）だけにする。パスまで出すと長くなり、
 * 肝心の「どこへ送っているか」が読み取りにくい。
 * **URLとして読めないものは、そのまま見せる**——解釈できないからと
 * 黙るのは逆で、おかしな値ほど作者の目に触れたほうがよい。
 */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

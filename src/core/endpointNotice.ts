import { isLoopbackEndpoint } from "./loopbackHost";

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

/**
 * クラウドのAIへ送ってよい宛先か。だめなら作者に見せる理由、よければ `undefined`
 * （セキュリティ点検 2026-11-21）。
 *
 * **https だけを通す。** 鍵はヘッダーで、本文は要求の中身で送るので、http だと両方が
 * 平文で回線に出る。**この PC の中（localhost など）の http だけは通す**——OpenAI 互換の
 * 手元のサーバーを ChatGPT の宛先に書く使い方があり、PC の外へは出ないため。
 *
 * 呼ぶのは各プロバイダの「宛先を読む1か所」（接続の確認・モデルの一覧・生成のどれも通る）。
 * ここで断った失敗は、指定を外して試し直す仕組みにも、失敗の覚えにも入らない（実装ルール5）
 */
export function insecureCloudEndpointReason(endpoint: string): string | undefined {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    return `AIの宛先「${endpoint}」を URL として読めません。https:// で始まる宛先を設定してください。`;
  }
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:" && isLoopbackEndpoint(endpoint)) return undefined;
  return (
    `AIの宛先「${url.host || endpoint}」が https ではないため、送りませんでした。` +
    "APIキーと本文が暗号化されずに送られるのを防ぐためです。宛先の設定を https:// で始まるものにしてください。"
  );
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

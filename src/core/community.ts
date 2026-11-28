/**
 * コミュニティ（Discord）への案内のリンク（1.0.0。作者の裁定 2026-10-18「1.0.0 を出すときに入れる」）。
 *
 * **リンクはここだけに置く。** 使うのは、障害報告用の記録を書き出したあとの［Discord で報告する］と
 * そのあとの［サーバーに参加する］・詳細メニューの「ヘルプ › コミュニティ（Discord）」・README の「ログ」の節
 * （障害報告用の記録の案内のすぐ下）。
 * 招待が切れたら、ここと README と `docs/Discordコミュニティ計画.md` の「いまの状態」を一緒に直す
 * （README と食い違うと `community.test.ts` が止める）。
 */
import { keysInText } from "./keyLabels";

export const COMMUNITY_DISCORD_URL = "https://discord.gg/6pcuUaCMax";

/**
 * サーバーの #不具合報告 のチャンネル（1.1.0。作者の頼み 2026-11-28「貼るところまでやって欲しい」）。
 * 入っている人はこのリンクでチャンネルが開く。入っていない人は開けないので、招待（上）も並べる
 */
export const BUG_REPORT_CHANNEL_URL =
  "https://discord.com/channels/1561045589142142976/1561059988237983790";

/** 案内のボタンの名前（記録を書き出したあとの知らせ） */
export const OPEN_COMMUNITY_LABEL = "Discord を開く";
/** 書き出したあとの、報告まで進めるボタン（1.1.0） */
export const REPORT_ON_DISCORD_LABEL = "Discord で報告する";
/** 手順の知らせの、まだサーバーに入っていない人のためのボタン（招待を開く） */
export const JOIN_COMMUNITY_LABEL = "サーバーに参加する";
/** 手順の知らせの、記録ファイルの場所をもう一度写すボタン（ほかの物を写して消えたとき） */
export const COPY_REPORT_PATH_AGAIN_LABEL = "場所をもう一度写す";

/**
 * ファイルを選ぶ画面へ、写した場所を入れるキー。OS ごとに画面の作りが違う
 * （Windows は名前の欄へそのまま貼れる。Mac は「フォルダーへ移動」の欄を開いてから貼る。
 * Linux（GTK）は場所の欄を開いてから貼る）
 */
function pastePathKeys(platform: string | undefined): string {
  // キーの書き方は OS に合わせる部品を通す（Mac は ⇧⌘G・⌘V の形。keyLabelsOnMac.test.ts）
  if (platform === "darwin") return keysInText("Ctrl+Shift+G を押し、Ctrl+V を押して Enter（開くときはもう一度 Enter）", "mac");
  if (platform === "win32") return keysInText("名前の欄に Ctrl+V を押して Enter", "other");
  return keysInText("Ctrl+L を押し、Ctrl+V を押して Enter", "other");
}

/**
 * ［Discord で報告する］のあとに出す手順（1行に1操作）。押すと焦点が Discord へ移るので、
 * VS Code へ戻ったときに読み直せるよう、知らせに残る形にする
 */
export function bugReportSteps(platform: string | undefined): string[] {
  return [
    "1. #不具合報告 で /不具合を報告 と打つ",
    "2. 「添付」の欄を押す",
    `3. ファイルを選ぶ画面で、${pastePathKeys(platform)}`,
    "4. Enter で送り、［入力窓を開く］を押す",
    "5. 再現手順・期待した動き・実際の動きを書いて送る",
  ];
}

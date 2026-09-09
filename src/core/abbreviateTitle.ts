/**
 * 長い作品名を、行の中で省略して見せる（設計書6.70）。
 *
 * 作品名は作者が付けたものなので長さに上限が無く、
 * 「ハイエルフ未亡人のお気楽資産運用～食っちゃ寝しているだけなのに、
 * 金融の女王と呼ばれてます～」のような題は行の幅を使い切る。
 * すると**右側に添えた補足（字数・同期の印）が幅の外へ押し出されて読めない**。
 * 補足は「いま何をすべきか」を知らせるものなので、そちらを優先する。
 *
 * **省略するのは表示だけ**である。作品名そのもの・フォルダー名・台帳は触らない。
 * 全文はホバー（tooltip）と QuickPick の `detail` に必ず出す。
 *
 * 全角・半角の幅の違いは数えない（作者の裁定、2026-09-06）。
 * 日本語の題ではほとんどが全角なので、幅を測る手間に見合わない。
 * ただし**絵文字などのサロゲートペアは割らない**——半分だけ残ると
 * 文字化けした題に見えるため、符号位置の単位で数える。
 */
export function abbreviateTitle(title: string, max = 20): string {
  const chars = Array.from(title ?? "");
  if (chars.length <= max) return title ?? "";
  return `${chars.slice(0, max).join("")}…`;
}

/** 省略が起きるか（全文を別の場所へ出すかの判断に使う） */
export function isAbbreviated(title: string, max = 20): boolean {
  return abbreviateTitle(title, max) !== (title ?? "");
}

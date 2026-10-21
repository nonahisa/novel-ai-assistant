/**
 * 有料のAIを使う前に見せる断りの行（設計書7.1.1）。
 *
 * **中身の決め方はここ1か所。** 画面の確認（`features/aiConnectivity.ts` の
 * `confirmPaidUsage`）と、外から頼まれた実行の確認（設計書6.87.22）が
 * 同じ行を出す。写しを2つ持つと、片方だけ言い回しが変わった日に
 * 「同じAIなのに、頼まれ方で料金の断りが違う」ことになる。
 *
 * **窓の本文は3行**（作者の裁定 2026-10-19「確認画面はもう少しシンプルに」
 * 「3行にする」「課金の機能で共通にしてください」）。
 *
 * 1. どこへ送るか（`<サービス>（有料）で送ります`。無料枠のあるAIは `<サービス>（無料枠あり・超えると有料）で送ります`）
 * 2. 何を送るか（`送るもの：…`。本文を送る機能は量を書く）
 * 3. いくらかかるか（`料金：…`。呼ぶ回数が分かれば入れる）
 *
 * モデル名・「トークンを消費し…」・「実際の金額は…」は**消さずに**［詳しく］へ
 * 移す（`more`）。作者が開けば読める所に残す。
 *
 * **サービス名は決め打ちしない**（CLAUDE.md 実装ルール5）。呼び出し側が
 * 渡した表示名（プロバイダの `displayName`）をそのまま使う。
 *
 * VS Code API にも Node にも依存しない（MCP の束からも読めるように）。
 */

/** 本文を送らない機能が、2行目の終わりに添える断り */
export const BODY_NOT_SENT = "（本文は送りません）";

export interface PaidUsageNotice {
  /** 窓の本文に出す3行（どこへ・何を・いくら） */
  readonly lines: readonly [string, string, string];
  /** ［詳しく］で開く行。モデル名と、料金の細かい断り */
  readonly more: readonly string[];
}

export interface PaidUsageNoticeOptions {
  /**
   * 送るもの。**短い名詞で**（「プロットと直近の会話」「本文 約4,321字（1話）」）。
   * 本文を送る機能は、作者が量を見て決められるよう字数を入れる
   */
  sends: string;
  /** 本文を送らない機能は true。2行目に「（本文は送りません）」が付く */
  bodyNotSent?: boolean;
  /** AIを何回呼ぶか。分かるときだけ（3行目に入る） */
  calls?: number;
  /** 機能ごとの補足。［詳しく］へ入る（「この確認はこの画面で一度だけです」など） */
  more?: readonly string[];
}

/** 末尾の性質の括弧1つ（「（クラウド・無料枠あり）」）の中身。無ければ空 */
function trailingParen(name: string): string {
  const m = name.trim().match(/（([^（）]*)）$/u);
  return m ? m[1] : "";
}

/**
 * 表示名から、窓の1行目に出すサービス名を作る。
 *
 * プロバイダの表示名は末尾に性質の括弧を持つ（「Claude（クラウド・有料）」
 * 「Gemini（クラウド・無料枠あり）」）。そのまま「（有料）で送ります」を付けると
 * 括弧が2つ続き、「無料枠あり（有料）」と食い違って読める。**末尾の括弧1つだけ**を
 * 外す（名前そのものは表示名から作り、決め打ちしない。実装ルール5）
 */
export function paidServiceName(providerName: string): string {
  const trimmed = providerName.trim();
  const short = trimmed.replace(/（[^（）]*）$/u, "").trim();
  return short === "" ? trimmed : short;
}

/**
 * 無料枠のあるAIか。
 *
 * **プロバイダ側に「無料枠あり」を表す印は無い**（`isPaid` は「呼ぶたびに課金されうるか」で、
 * 無料枠つきのGeminiもさくらも true）。無料枠の有無を持つのは表示名の性質の括弧
 * （「（クラウド・無料枠あり）」）だけなので、**サービス名ではなく括弧の中の「無料枠」で**
 * 判じる。名前で決め打つと、無料枠のあるサービスが増えたときに外れる
 */
export function hasFreeTier(providerName: string): boolean {
  return trailingParen(providerName).includes("無料枠");
}

/**
 * 1行目。どのサービスへ送るか。
 *
 * 無料枠のあるAIは「（無料枠あり・超えると有料）」、それ以外は「（有料）」。
 * 複数（取り出しと判定で別のAI）のときは「・」でつなぎ、**全部が無料枠つきのときだけ**
 * 無料枠の言い方にする（1つでも純粋な有料があれば、有料と言うほうが安全）
 */
export function paidHeadLine(providerName: string | readonly string[]): string {
  const names = typeof providerName === "string" ? [providerName] : providerName;
  const free = names.length > 0 && names.every(hasFreeTier);
  const label = names.map(paidServiceName).join("・");
  return free
    ? `${label}（無料枠あり・超えると有料）で送ります`
    : `${label}（有料）で送ります`;
}

/**
 * 3行目。**呼ぶ回数が分かれば回数を入れる**——作者が料金の見当を付けられる
 * いちばん確かな数だから。分からない機能（相談のように作者が何度送るか
 * 決まらないもの）は、送るたびにかかることだけを言う
 */
export function paidPriceLine(calls?: number): string {
  return calls !== undefined
    ? `料金：AIを ${calls} 回呼びます。使った量だけかかります`
    : "料金：送るたびに、使った量だけかかります";
}

/**
 * ［詳しく］の行。**窓の本文から外した断りは、ここに必ず残す**（消さない）
 */
export function paidMoreLines(
  model: string,
  extra: readonly string[] = []
): string[] {
  return [
    `使うモデル：${model}`,
    ...extra,
    "実行するとトークンを消費し、利用量が加算されます。",
    "実際の金額はモデル・実使用量・各社の現行料金によって変わります。",
  ];
}

/** 有料のAIを使う前の断り（窓の3行と［詳しく］の行） */
export function paidUsageNotice(
  providerName: string | readonly string[],
  model: string,
  options: PaidUsageNoticeOptions
): PaidUsageNotice {
  return {
    lines: [
      paidHeadLine(providerName),
      `送るもの：${options.sends}${options.bodyNotSent ? BODY_NOT_SENT : ""}`,
      paidPriceLine(options.calls),
    ],
    more: paidMoreLines(model, options.more),
  };
}

/**
 * 見積もりを自前で組む確認（矛盾検知・推敲など。量の行が何行もある）へ添える
 * 2行。**量の行は畳まずに残し、料金の言い方だけを共通の形にそろえる**——
 * 3行へ畳むと、作者が量を見て決めるための行（チャンク数・材料・前の話の量）が
 * 窓から消える。
 */
export function paidCostLines(
  providerName: string | readonly string[],
  calls?: number
): string[] {
  return [paidHeadLine(providerName), paidPriceLine(calls)];
}

/**
 * AI接続の確認（`novelai.testAI`）の結果を、動作の記録（actions.log）へ残す1行を作る。
 *
 * 以前は一覧を引く段の成否と全部通ったときが右下の知らせにしか出ず、
 * 知らせが消えると何も残らなかった。実機確認は actions.log を読んで裏付けるので、
 * 3つの結果すべてを同じ頭の1行で残す（頭で grep できるように揃える）。
 *
 * **ここでは中身を推し量らない**（実装ルール5）。種別は分類済みの `AIError.kind` を
 * そのまま書き、一覧の段のように種別を返さない結果には種別を作らない。エラーの
 * 生の文もそのまま残す。鍵は書き込みの口（`logger.ts` の `writeLine`）が
 * `redactSecrets` で伏せるので、ここで二重には伏せない。AIの種類はプロバイダIDを
 * 書き、サービス名を決め打ちしない。
 */

/** 3つの行に共通の頭。実機確認でこの語で探す */
export const CONNECTION_CHECK_LOG_PREFIX = "AI接続の確認";

export type ConnectionCheckOutcome =
  /** 一覧を引く段（`testConnection`）。成否と画面の文だけで、種別は返らない */
  | { stage: "list"; ok: boolean; message: string; modelCount?: number }
  /** 生成を試す段（`probeGeneration`）の失敗 */
  | {
      stage: "generate";
      ok: false;
      /** `AIError.kind`。AIError でない例外のときは無い */
      kind?: string;
      /** `AIError.detail`（エラーの生の本文） */
      detail?: string;
      message: string;
    }
  /** 全部通ったとき */
  | { stage: "done"; ok: true; message: string };

const STAGE_LABEL: Record<ConnectionCheckOutcome["stage"], string> = {
  list: "一覧を引く",
  generate: "生成を試す",
  done: "全部通った",
};

/**
 * 改行を `\n` の2文字に置き換える。1行で grep できるようにしつつ、
 * 生の文の中身は落とさない（戻せる形にしておく）
 */
function oneLine(text: string): string {
  return text.replace(/\r?\n/g, "\\n");
}

export function connectionCheckLogLine(
  providerId: string,
  model: string,
  outcome: ConnectionCheckOutcome
): string {
  const parts = [
    `${CONNECTION_CHECK_LOG_PREFIX}（${STAGE_LABEL[outcome.stage]}）: ${
      outcome.ok ? "成功" : "失敗"
    }`,
    `AI: ${providerId}`,
    `モデル: ${model}`,
  ];
  if (outcome.stage === "list" && outcome.modelCount !== undefined) {
    parts.push(`モデル数: ${outcome.modelCount}`);
  }
  if (outcome.stage === "generate") {
    // 種別が無いのは AIError でない例外のとき。推測で埋めず「不明」と書く
    parts.push(`種別: ${outcome.kind ?? "不明"}`);
    if (outcome.detail) parts.push(`詳細: ${oneLine(outcome.detail)}`);
  }
  parts.push(`画面の文: ${oneLine(outcome.message)}`);
  return parts.join(" ／ ");
}

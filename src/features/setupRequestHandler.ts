import {
  describeSetupRequest,
  parseSetupQuery,
  setupRequestForLog,
  type SetupRequest,
} from "../core/setupRequest";

/**
 * Claude Code からのセットアップの依頼を受ける（設計書6.87.18）。
 *
 * 受け口（`vscode://nonahisa.novel-ai-assistant/setup?…`）に届いたクエリを
 * 確かめ、**「Claude Code からの依頼です」の確認を出してから**その段を呼ぶ。
 *
 * - **URI はウェブページのリンク1つでも開かせられる。** 誰が作ったか
 *   分からない依頼を黙って始めない。作者が断れば何も起きない
 * - 確認のあとは、その操作の**既存の確認がそのまま続く**（導入の同意・書庫の
 *   選択・許可の画面）。ここで飛ばすものは無い
 * - おかしな依頼（知らない段・受けない鍵）は、確認も出さずに理由を言って断る
 *
 * 画面と操作は外から渡す（VS Code を知らずに試せるように）。
 */

export interface SetupRequestHandlerDeps {
  /** モーダルで確かめる。「始める」が押されたら true */
  confirm(message: string, detail: string): Promise<boolean>;
  /** その段を呼ぶ */
  run(request: SetupRequest): Promise<void>;
  /** 作者に知らせる（断った理由・失敗） */
  warn(message: string): void;
  /** 記録へ1行（値は入れない） */
  log(line: string): void;
}

export async function handleSetupRequest(
  query: string,
  deps: SetupRequestHandlerDeps
): Promise<void> {
  const parsed = parseSetupQuery(query);
  if (!parsed.ok) {
    deps.log(`Claude Code からのセットアップの依頼を断りました：${parsed.reason}`);
    deps.warn(`Claude Code からの依頼を受けられませんでした。${parsed.reason}`);
    return;
  }
  const request = parsed.request;
  const forLog = setupRequestForLog(request);
  deps.log(`Claude Code からのセットアップの依頼を受けました：${forLog}`);

  const accepted = await deps.confirm(
    "Claude Code からの依頼です。この操作を始めますか？",
    [
      ...describeSetupRequest(request),
      "",
      "このあと、いつもの確認（導入の同意や、作品を置く場所の確認など）がそのまま出ます。",
      "覚えのない依頼なら「始める」を押さずに閉じてください。",
    ].join("\n")
  );
  if (!accepted) {
    deps.log(`作者が断りました：${forLog}`);
    return;
  }

  try {
    await deps.run(request);
    deps.log(`依頼の操作を呼びました：${forLog}`);
  } catch (error) {
    // **落ちずに知らせる。** 受け口は他の合図（読者の反応など）も受けている
    const message = error instanceof Error ? error.message : String(error);
    deps.log(`依頼の操作に失敗しました（${forLog}）：${message}`);
    deps.warn(`Claude Code から頼まれた操作に失敗しました：${message}`);
  }
}

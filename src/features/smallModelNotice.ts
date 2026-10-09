// ログの書き先：呼ぶ側が向ける（検知の機能が `useLogFile` で作品のログへ向けたあとに呼ばれる）
import * as vscode from "vscode";
import {
  SMALL_MODEL_NOTICE_STATE_KEY,
  describeSmallModelNotice,
  needsSmallModelNotice,
  readDismissedKeys,
  smallModelNoticeKey,
} from "../core/smallModelNotice";
import { SMALL_MODEL_NOTICE } from "../core/requirements";
import { verifiedState, type InnerMemento } from "../core/verifiedMemento";
import { logStep } from "../core/logger";

/**
 * 小さいモデルで検知の機能を動かす前に、1回だけ知らせる（設計書6.28.9）。
 * 出す条件と鍵は `core/smallModelNotice.ts`。
 *
 * ## 出し方
 *
 * - **モーダルにしない**（右下の通知）。実行前の確認（処理量の目安と「大きいモデルの
 *   案内」）と、手元のAIの関所の GPU の警告はどちらもモーダル／選ぶ画面なので、
 *   ここまでモーダルにすると押す画面が1つ増え、重なって見える。通知なら実行は
 *   止めずに、読んだ作者が割当を変えられる
 * - **作品ごと・モデルごとに、起動中1回だけ**。まとめ実行で誤字脱字・推敲・矛盾検知が
 *   続けて走っても1回で済む（作者の言う「まとめて出す」）
 * - **「今後出さない」は手元の保管庫（globalState）にだけ覚える**。設定同期に乗る
 *   設定（`confirmMemoryStore` の置き場所）には書かない——別の機械では別のモデルを
 *   使っていることがある
 */

/** 押せるもの。文言を変えるときは E2E（`smallModelNotice.test.ts`）も直す */
export const SMALL_MODEL_NOTICE_ASSIGN = "機能別AI割当を開く";
export const SMALL_MODEL_NOTICE_DISMISS = "今後出さない";

let state: InnerMemento | undefined;
/** 起動中に一度出した鍵。保管庫が無いとき（単体テスト）もこれで1回に絞る */
const shownThisSession = new Set<string>();

/** 拡張機能の起動時に保管庫を渡す */
export function installSmallModelNoticeState(memento: InnerMemento | undefined): void {
  state = memento;
}

/** 単体テストのための片づけ */
export function resetSmallModelNoticeForTests(): void {
  state = undefined;
  shownThisSession.clear();
}

export interface SmallModelNoticeRequest {
  /** 作品フォルダー。分からなければ undefined（モデルごとだけで覚える） */
  readonly workFolder: string | undefined;
  /** 機能別AI割当のキー */
  readonly feature: string;
  readonly providerId: string;
  readonly model: string;
  /** API が申告した大きさ（`ModelInfo.parameterSize`） */
  readonly parameterSize: string | null | undefined;
}

/**
 * 出すべきなら通知を出す。**待たなくてよい**（実行は止めない）。
 *
 * 戻り値は「出したか」と、押されたボタンを片づけ終える約束（テストが待つため）。
 */
export function noticeSmallModelOnce(request: SmallModelNoticeRequest): {
  shown: boolean;
  settled: Promise<void>;
} {
  if (!needsSmallModelNotice(request.feature, request.parameterSize)) {
    return { shown: false, settled: Promise.resolve() };
  }
  const key = smallModelNoticeKey(
    request.workFolder ?? "",
    request.providerId,
    request.model
  );
  if (shownThisSession.has(key)) return { shown: false, settled: Promise.resolve() };
  if (state && readDismissedKeys(state.get(SMALL_MODEL_NOTICE_STATE_KEY)).includes(key)) {
    return { shown: false, settled: Promise.resolve() };
  }
  shownThisSession.add(key);

  const message = describeSmallModelNotice(
    SMALL_MODEL_NOTICE,
    request.model,
    request.parameterSize
  );
  const settled = (async () => {
    // 記録も含めて中で行う——どこで失敗しても実行は止めない（下の catch）
    logStep(`小さいモデルの知らせ：${message}`);
    const choice = await vscode.window.showWarningMessage(
      message,
      SMALL_MODEL_NOTICE_ASSIGN,
      SMALL_MODEL_NOTICE_DISMISS
    );
    if (choice === SMALL_MODEL_NOTICE_ASSIGN) {
      await vscode.commands.executeCommand("novelai.assignFeatureAI");
      return;
    }
    if (choice === SMALL_MODEL_NOTICE_DISMISS) {
      await rememberDismissed(key);
    }
  })().catch((error: unknown) => {
    // 知らせが出せなくても実行は止めない（知らせは添え物）。理由は記録に残す
    try {
      logStep(
        `小さいモデルの知らせを出せませんでした：${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } catch {
      // 記録の口も使えない環境（単体テストの作り物など）。黙って続ける
    }
  });
  return { shown: true, settled };
}

async function rememberDismissed(key: string): Promise<void> {
  if (!state) return;
  try {
    await verifiedState(state).patch<unknown>(
      SMALL_MODEL_NOTICE_STATE_KEY,
      [],
      (current) => {
        const keys = readDismissedKeys(current);
        return keys.includes(key) ? keys : [...keys, key];
      }
    );
    logStep(`小さいモデルの知らせを今後出さないことにしました：${key}`);
  } catch (error) {
    // 覚えられなくても実行には響かない。理由は記録に残す
    logStep(
      `小さいモデルの知らせの「今後出さない」を覚えられませんでした：${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

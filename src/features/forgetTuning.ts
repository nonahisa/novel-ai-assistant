import * as vscode from "vscode";
import type { AIRegistry } from "../ai/registry";
import { parseModelTuning } from "../core/modelTuning";
import {
  forgetModelTuning,
  isTuningStoreBroken,
  reloadTuningStore,
  tuningStoreTable,
} from "../core/modelTuningStore";
import { formatMeasuredAt, splitTuningKey } from "../core/tuningStats";
import { confirmRun } from "../views/notify";

/**
 * AIチューニングで測った記録を、モデルごとに消す（作者の裁定、2026-09-18）。
 *
 * 台帳は 0.66.6 で設定（`novelai.modelTuning`）から**拡張機能の保管庫の
 * ファイル**へ移った（`core/modelTuningStore.ts`）。設定に置いていたころは
 * 「設定画面を開いて JSON を手で削る」という道があったが、ファイルにすると
 * その道が無くなる。**消せる口をこちらで持つ**のは、そのための引き換えである。
 *
 * ## 同梱の行は出さない
 *
 * `core/bundledTuning.ts` の初期値は製品に焼き込んであるので、**押しても
 * 消えない。** 並べると「押したのに消えない行」ができるので、一覧には
 * 作者自身の記録（＝保管庫のファイルに実在する鍵）だけを出す。
 * 同梱の値は、そのモデルを測り直せば作者の実測が上に載る。
 */
export async function forgetTuning(registry: AIRegistry): Promise<void> {
  // **いまのファイルを読み直してから並べる。** 別の窓で測った直後だと、
  // 手元の写しがまだ古いことがある（`REFRESH_INTERVAL_MS`）
  await reloadTuningStore();

  if (isTuningStoreBroken()) {
    void vscode.window.showErrorMessage(
      "AIチューニングの記録のファイルが読めないため、消す操作はできません。" +
        "「操作ログを表示」で場所と理由を確かめてください。"
    );
    return;
  }

  /*
    **生の表から鍵を採る。** `parseModelTuning` を通した表は、こちらが
    読めなかった行（作者が手で書いた覚え書きだけの行など）を落とすので、
    それを一覧の元にすると**消したいのに出てこない行**ができる。
    測った日だけは解釈が要るので、そちらは解釈した表から引く。
  */
  const raw = tuningStoreTable();
  const parsed = parseModelTuning(raw);
  const keys = Object.keys(raw);

  if (keys.length === 0) {
    void vscode.window.showInformationMessage(
      "消せるAIチューニングの記録はありません" +
        "（同梱されている初期値は消せません）。"
    );
    return;
  }

  // 表示名を知っているのはプロバイダ自身だけなので、写しを作らない
  // （`features/showTuningStats.ts` と同じ理由）。見つからない鍵はIDのまま
  const labels = new Map<string, string>(
    registry.listProviders().map((provider) => [provider.id, provider.displayName])
  );

  const picked = await vscode.window.showQuickPick(
    keys.map((key) => {
      const { providerId, model } = splitTuningKey(key);
      const measuredAt = parsed.get(key)?.measuredAt;
      return {
        label: `${labels.get(providerId) ?? providerId} / ${model || key}`,
        description: `測った日: ${formatMeasuredAt(measuredAt)}`,
        detail: key,
        key,
      };
    }),
    {
      title: `AIチューニングの記録（${keys.length}件）`,
      placeHolder: "消す記録を選んでください（複数選べます）",
      canPickMany: true,
      ignoreFocusOut: true,
    }
  );

  // **何も選ばずに閉じたら、何もしない。** 空の配列を「全部」と読むと、
  // 見に来ただけの作者の測定が消える
  if (!picked || picked.length === 0) return;

  const targets = picked.map((item) => item.key);
  const ok = await confirmRun(
    `${targets.length}件のAIチューニングの記録を消します。`,
    "消す",
    {
      // 測り直しには時間がかかる（遅いモデルでは1時間以上）ので、
      // 取り消しにくい操作として扱う
      kind: "warning",
      detail:
        `${targets.join("\n")}\n\n` +
        "消すと、そのモデルは測る前の状態に戻ります（測り直せばまた入ります）。" +
        "同梱されている初期値は消えません。",
    }
  );
  if (!ok) return;

  const removed = await forgetModelTuning(targets);
  // **件数を出すので、消える知らせ（ステータスバー）ではなく通知にする**
  // （`views/notify.ts` の行き先の分け方）
  void vscode.window.showInformationMessage(`${removed}件の記録を消しました。`);
}

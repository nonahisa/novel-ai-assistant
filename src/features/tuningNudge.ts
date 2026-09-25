// ログの書き先：作品が定まらない——AIの選択が変わったときに鳴るもので、どの作品の操作でもない
import * as vscode from "vscode";
import type { AIRegistry } from "../ai/registry";
import type { ProviderId } from "../ai/types";
import { modelTuningRaw } from "../core/modelTuning";
import { logLine } from "../core/logger";
import {
  NUDGE_MEASURE_LABEL,
  NUDGE_MUTE_LABEL,
  newlySelectedModels,
  nudgeTuningMessage,
  selectedModelKey,
  shouldNudgeTuning,
  type SelectedModel,
} from "../core/tuningNudge";

/**
 * 測っていないモデルに切り替えたら、AIチューニングを一言勧める
 * （設計書6.49.8。決まりは `core/tuningNudge.ts`）。
 *
 * ## 見張るのは「選択が変わった」合図1つ
 *
 * モデルを選ぶ道は3つある——AI設定（セットアップも同じウィザードを通る）・
 * 機能別AI割当・大きいモデルへの切り替えの案内（6.28.9 の A3④）。
 * どれも `AIRegistry` の `select` か `assign` を通り、どちらも
 * `onDidChangeSelection` を鳴らす。**道ごとに勧める処理を写すと、
 * 道を足した人が書き忘れる**ので、合図の1か所で見る。
 *
 * ## 覚えるのは `globalState`
 *
 * 台帳（`model-tuning.json`）が機械ごとなので、「この機械で勧めたか」も
 * 機械ごとでよい。別の機械で同じモデルを選んだら、そこでは測っていない
 * のだから、そこで一度勧めるのが正しい。
 */

/** 勧めたモデルの鍵の一覧（`プロバイダ/モデル`） */
const SHOWN_KEY = "novelai.tuningNudge.shown";
/** 「今後出さない」を押したか */
const MUTED_KEY = "novelai.tuningNudge.muted";

export function registerTuningNudge(
  context: vscode.ExtensionContext,
  registry: AIRegistry
): vscode.Disposable {
  let before = selectedModelsOf(registry);
  return registry.onDidChangeSelection(() => {
    const after = selectedModelsOf(registry);
    const fresh = newlySelectedModels(before, after);
    before = after;
    for (const selected of fresh) {
      void nudgeOnce(context, registry, selected);
    }
  });
}

/**
 * いま使われているモデルの一覧。**既定を先に、機能別の割当を後に並べる。**
 *
 * `resolve()` は通さない——割当先が使えないときに「既定へ落とした」を
 * ログへ書く副作用がある。ここは選ばれたものを並べるだけでよい。
 */
function selectedModelsOf(registry: AIRegistry): SelectedModel[] {
  const selected: SelectedModel[] = [];
  const providerId = registry.selectedProviderId;
  const model = registry.selectedModel;
  if (providerId && model) {
    selected.push({ providerId, model, feature: "default" });
  }
  for (const [feature, assigned] of Object.entries(registry.assignments())) {
    if (!assigned) continue;
    selected.push({
      providerId: assigned.provider,
      model: assigned.model,
      feature,
    });
  }
  return selected;
}

async function nudgeOnce(
  context: vscode.ExtensionContext,
  registry: AIRegistry,
  selected: SelectedModel
): Promise<void> {
  const shown = new Set(context.globalState.get<string[]>(SHOWN_KEY) ?? []);
  const muted = context.globalState.get<boolean>(MUTED_KEY) ?? false;
  /*
    **測ったかは、作者自身の台帳だけで見る**（同梱の初期値は混ぜない）。
    同梱が持つのはクラウドの読める長さだけで、待ち時間は持たない
    （機械と回線で変わるため。CLAUDE.md 規則6）。判定の欄は未チューニングの
    安全既定（6.65.16）と同じ `measuredChars`——普段の呼び出しが書く
    速さの欄だけの行を「測った」と読まない。
  */
  const tuned =
    modelTuningRaw(selected.providerId, selected.model)?.measuredChars !==
    undefined;
  if (!shouldNudgeTuning(selected, { tuned, shown, muted })) return;

  // **出す前に覚える。** 知らせを閉じずに放っておかれても、二度目は出さない
  shown.add(selectedModelKey(selected));
  await context.globalState.update(SHOWN_KEY, [...shown]);

  // 鍵は台帳と同じただの文字列。知らないIDなら undefined が返るだけ
  const provider = registry.getProvider(selected.providerId as ProviderId);
  const message = nudgeTuningMessage({
    providerName: provider?.displayName ?? selected.providerId,
    model: selected.model,
    // **分からないときは「無料」へ倒さない**（6.49.4 と同じ守り）
    isPaid: provider?.isPaid,
  });
  // 知らせを出したことは、操作ログにも残す（あとで「出たか」を追えるように）
  logLine(`AIチューニングを勧めた：${selectedModelKey(selected)}`);

  const picked = await vscode.window.showInformationMessage(
    message,
    NUDGE_MEASURE_LABEL,
    NUDGE_MUTE_LABEL
  );
  if (picked === NUDGE_MEASURE_LABEL) {
    // **その機能の割当先を測る**（既定なら "default"）。割当を測らないと、
    // 測ったAIと使うAIが別物になる（6.49.5 の①）
    await vscode.commands.executeCommand(
      "novelai.measureContext",
      selected.feature
    );
    return;
  }
  if (picked === NUDGE_MUTE_LABEL) {
    await context.globalState.update(MUTED_KEY, true);
  }
}

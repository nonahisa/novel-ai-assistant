import * as vscode from "vscode";
import {
  AIRegistry,
  ASSIGNABLE_FEATURES,
  ASSIGNABLE_FEATURE_LABELS,
  pickProviderAndModel,
  type AssignableFeature,
  type ProviderAndModelPick,
} from "../ai/registry";
import { cancelItem } from "../views/dialogs";

/**
 * 機能ごとに使うAIを割り当てる（設計書6.28.7の1、7.1）。
 *
 * **重い機能ほど手元の無料AIで足りる**というのが実測で分かっている
 * （設計書6.28.1）。いちばん送信量の多い設定資料の抽出はOllamaで実用に
 * なっており、逆に手元では全く働かなかった逸脱検知はいちばん軽い。
 * この対応があるので、機能ごとに割り当てると実際に課金が減る。
 *
 * **割り当てていない機能は、AI設定で選んだ既定のAIを使う。**
 * 「機能別割当が有効か」のフラグは持たない（設計書6.28.7）。
 */
export async function assignFeatureAI(registry: AIRegistry): Promise<void> {
  const feature = await pickFeature(registry);
  if (!feature) return;

  const target = await pickTarget(registry, feature);
  if (!target) return;

  if (target === "default") {
    await registry.unassign(feature);
    vscode.window.showInformationMessage(
      `${ASSIGNABLE_FEATURE_LABELS[feature]} は、AI設定で選んだ既定のAIで実行するようにしました。`
    );
    return;
  }

  await registry.assign(feature, target.providerId, target.model.id);

  const notes: string[] = [];
  if (target.model.tier === "light") {
    notes.push(
      "このモデルは軽量です。矛盾検知など高度な判断が必要な機能では精度が下がる場合があります。"
    );
  }
  if (target.provider.isPaid) {
    // **有料へ割り当てたことは、その場で言い切る。** 実行前の確認
    // （設計書7.1.1）でも出るが、割り当てた時点で気づけるほうがよい
    notes.push(
      "実行のたびに課金されます（実行前に目安を表示します）。"
    );
  }

  vscode.window.showInformationMessage(
    `${ASSIGNABLE_FEATURE_LABELS[feature]} は ` +
      `${target.provider.displayName}（${target.model.displayName}）で実行するようにしました。` +
      (notes.length > 0 ? "\n" + notes.join("\n") : "")
  );
}

/** どの機能の割当を変えるか。いまの割当を各行に出す */
async function pickFeature(
  registry: AIRegistry
): Promise<AssignableFeature | undefined> {
  const assignments = registry.assignments();

  const picked = await vscode.window.showQuickPick(
    [
      ...ASSIGNABLE_FEATURES.map((feature) => {
        const assigned = assignments[feature];
        const provider = assigned
          ? registry.getProvider(assigned.provider)
          : undefined;
        return {
          label: ASSIGNABLE_FEATURE_LABELS[feature],
          description: assigned
            ? `割当: ${provider?.displayName ?? assigned.provider} / ${assigned.model}`
            : "既定のAIを使う",
          feature,
        };
      }),
      cancelItem(),
    ],
    {
      title: "どの機能のAIを変えますか",
      placeHolder: "割り当てない機能は、AI設定で選んだ既定のAIを使います",
      ignoreFocusOut: true,
    }
  );
  if (!picked || !("feature" in picked)) return undefined;
  return picked.feature;
}

/**
 * 割当先を決める。
 *
 * `"default"` は「割当を外して既定へ戻す」。プロバイダとモデルを選ぶ
 * ところは **AI設定のウィザードと同じ手順**（`pickProviderAndModel`）を
 * 呼ぶ。鍵の入力・接続の確認・生成の試行まで一続きで通るので、
 * 「割り当てたのに実行して初めて失敗する」を作らない。
 */
async function pickTarget(
  registry: AIRegistry,
  feature: AssignableFeature
): Promise<"default" | ProviderAndModelPick | undefined> {
  const assigned = registry.assignments()[feature];

  const choice = await vscode.window.showQuickPick(
    [
      {
        label: "既定のAIを使う（割当を外す）",
        description: assigned ? undefined : "いまはこちら",
        action: "default" as const,
      },
      {
        label: "使うAIを選ぶ…",
        detail:
          "プロバイダとモデルを選び、実際に生成できるところまで確かめます",
        action: "pick" as const,
      },
      cancelItem(),
    ],
    {
      title: `${ASSIGNABLE_FEATURE_LABELS[feature]} で使うAI`,
      ignoreFocusOut: true,
    }
  );
  if (!choice || !("action" in choice)) return undefined;
  if (choice.action === "default") return "default";

  return await pickProviderAndModel(registry);
}

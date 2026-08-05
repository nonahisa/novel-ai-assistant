import * as vscode from "vscode";
import { AIProvider, ModelInfo, ProviderId } from "./types";
import { OllamaProvider } from "./ollamaProvider";

const KEY_PROVIDER = "novelai.ai.provider";
const KEY_MODEL = "novelai.ai.model";

/**
 * 使用するプロバイダとモデルを解決する。
 *
 * 設計方針として「1つだけ使う」を標準ケースとしており、
 * 既定では全機能が同じプロバイダ・モデルを使う。
 */
export class AIRegistry {
  private readonly providers = new Map<ProviderId, AIProvider>();

  constructor(private readonly context: vscode.ExtensionContext) {
    const ollama = new OllamaProvider();
    this.providers.set(ollama.id, ollama);
    // Gemini / Claude はフェーズ1以降で追加する
  }

  listProviders(): AIProvider[] {
    return [...this.providers.values()];
  }

  getProvider(id: ProviderId): AIProvider | undefined {
    return this.providers.get(id);
  }

  /** 現在選択されているプロバイダID */
  get selectedProviderId(): ProviderId | undefined {
    return this.context.globalState.get<ProviderId>(KEY_PROVIDER);
  }

  /** 現在選択されているモデル */
  get selectedModel(): string | undefined {
    return this.context.globalState.get<string>(KEY_MODEL);
  }

  async select(providerId: ProviderId, model: string): Promise<void> {
    await this.context.globalState.update(KEY_PROVIDER, providerId);
    await this.context.globalState.update(KEY_MODEL, model);
  }

  async clear(): Promise<void> {
    await this.context.globalState.update(KEY_PROVIDER, undefined);
    await this.context.globalState.update(KEY_MODEL, undefined);
  }

  /** 設定済みなら {provider, model} を返す。未設定なら undefined */
  resolve(): { provider: AIProvider; model: string } | undefined {
    const id = this.selectedProviderId;
    const model = this.selectedModel;
    if (!id || !model) return undefined;
    const provider = this.providers.get(id);
    if (!provider) return undefined;
    return { provider, model };
  }

  /** 選択中モデルの詳細（コンテキスト長など）を取得する */
  async resolveModelInfo(): Promise<ModelInfo | undefined> {
    const resolved = this.resolve();
    if (!resolved) return undefined;
    const p = resolved.provider;
    if (p instanceof OllamaProvider) {
      return p.getModel(resolved.model);
    }
    const all = await p.listModels();
    return all.find((m) => m.id === resolved.model);
  }
}

/**
 * AI設定のセットアップウィザード。
 * 未設定でAI機能を呼んだ場合にもここへ誘導する。
 */
export async function runSetupWizard(
  registry: AIRegistry
): Promise<boolean> {
  const providers = registry.listProviders();

  const providerPick = await vscode.window.showQuickPick(
    providers.map((p) => ({
      label: p.displayName,
      description:
        p.id === "ollama" ? "無料・オフライン可。ローカル実行" : undefined,
      providerId: p.id,
    })),
    {
      title: "使用するAIを選んでください（1つで構いません）",
      ignoreFocusOut: true,
    }
  );
  if (!providerPick) return false;

  const provider = registry.getProvider(providerPick.providerId)!;

  // 接続テスト
  const test = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "接続を確認しています…" },
    () => provider.testConnection()
  );

  if (!test.ok) {
    const action = await vscode.window.showErrorMessage(
      test.message,
      "設定を開く",
      "閉じる"
    );
    if (action === "設定を開く") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "novelai.ollama"
      );
    }
    return false;
  }

  if (test.modelCount === 0) {
    vscode.window.showWarningMessage(test.message);
    return false;
  }

  // モデル一覧を取得
  const models = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "モデル情報を取得しています…",
    },
    () => provider.listModels()
  );

  if (models.length === 0) {
    vscode.window.showWarningMessage("利用可能なモデルが見つかりませんでした。");
    return false;
  }

  const tierLabel: Record<string, string> = {
    high: "高性能",
    standard: "標準",
    light: "軽量",
  };

  const modelPick = await vscode.window.showQuickPick(
    models.map((m) => ({
      label: m.displayName,
      description: [
        m.parameterSize ?? "",
        `文脈 ${formatContext(m.contextWindow)}`,
        tierLabel[m.tier],
      ]
        .filter(Boolean)
        .join(" / "),
      detail:
        m.capabilities.length > 0
          ? `対応: ${m.capabilities.join(", ")}`
          : undefined,
      model: m,
    })),
    { title: "使用するモデルを選んでください", ignoreFocusOut: true }
  );
  if (!modelPick) return false;

  await registry.select(providerPick.providerId, modelPick.model.id);

  const m = modelPick.model;
  const notes: string[] = [];
  if (m.tier === "light") {
    notes.push(
      "このモデルは軽量です。矛盾検知など高度な判断が必要な機能では精度が下がる場合があります。"
    );
  }

  vscode.window.showInformationMessage(
    `${provider.displayName} / ${m.displayName} を設定しました。${
      notes.length > 0 ? "\n" + notes.join("\n") : ""
    }`
  );
  return true;
}

function formatContext(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1024)}k`;
  return String(tokens);
}

/** AI機能の実行前に呼ぶ。未設定ならウィザードを出す */
export async function ensureConfigured(
  registry: AIRegistry
): Promise<{ provider: AIProvider; model: string } | undefined> {
  const resolved = registry.resolve();
  if (resolved) return resolved;

  const answer = await vscode.window.showInformationMessage(
    "AIがまだ設定されていません。設定しますか？",
    "設定する",
    "後で"
  );
  if (answer !== "設定する") return undefined;

  const ok = await runSetupWizard(registry);
  return ok ? registry.resolve() : undefined;
}

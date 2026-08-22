import * as vscode from "vscode";
import {
  AIProvider,
  ApiKeyProvider,
  ModelInfo,
  ProviderId,
  isApiKeyProvider,
} from "./types";
import { OllamaProvider } from "./ollamaProvider";
import { ClaudeProvider } from "./claudeProvider";
import { OpenAIProvider } from "./openaiProvider";
import { SakuraProvider } from "./sakuraProvider";
import { GeminiProvider } from "./geminiProvider";
import { withProgress } from "../views/progress";
import { probeGeneration } from "./generationProbe";
import { logFailure, showLog } from "../core/logger";
import { askText, cancelItem } from "../views/dialogs";
import { canRunProcesses } from "../core/runtime";

const KEY_PROVIDER = "novelai.ai.provider";
const KEY_MODEL = "novelai.ai.model";

/**
 * 実行環境で選べないプロバイダを外す。
 *
 * **`AIRegistry.listProviders` から切り出した。** `canRunProcesses()` は
 * 実際のNode/ブラウザの違いでしか変わらないので、単体テストからは
 * どちらか一方（常にNode側）しか確かめられない。フィルタの中身だけを
 * 純粋な関数にして、両方の分岐をテストできるようにする。
 */
export function filterProvidersForRuntime(
  providers: AIProvider[],
  canRun: boolean
): AIProvider[] {
  return canRun ? providers : providers.filter((p) => p.id !== "ollama");
}

/**
 * 使用するプロバイダとモデルを解決する。
 *
 * 設計方針として「1つだけ使う」を標準ケースとしており、
 * 既定では全機能が同じプロバイダ・モデルを使う。
 */
export class AIRegistry {
  private readonly providers = new Map<ProviderId, AIProvider>();

  constructor(private readonly context: vscode.ExtensionContext) {
    // 並び順はそのまま選択画面に出る。無料で始められるものを先頭に置く
    for (const provider of [
      new OllamaProvider(),
      new GeminiProvider(context),
      new OpenAIProvider(context),
      new SakuraProvider(context),
      new ClaudeProvider(context),
    ] as AIProvider[]) {
      this.providers.set(provider.id, provider);
    }
  }

  /**
   * 選択肢に出すプロバイダ。
   *
   * **Ollamaはブラウザ版では出さない**（作者の指示、2026-08-21）。
   * `localhost` はブラウザからは（vscode.devが動いているMicrosoftのサーバ
   * から見て）作者のPCではないので、選んでも必ず「接続できません」に
   * なる。選ばせておいて毎回同じ理由で失敗させるより、はじめから
   * 選べないほうが分かりやすい。
   */
  listProviders(): AIProvider[] {
    return filterProvidersForRuntime(
      [...this.providers.values()],
      canRunProcesses()
    );
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
    // 個別取得できるプロバイダは一覧を引かずに済ませる（呼び出し回数の節約）
    if (p.getModel) return p.getModel(resolved.model);
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

  const providerDescriptions: Partial<Record<ProviderId, string>> = {
    ollama: "無料・オフライン可。ローカル実行",
    gemini: "無料枠あり。超えると課金される",
    openai: "実行するたびに課金される",
    sakura: "国内のサービス。無料枠あり。超えると課金される",
    claude: "高精度だが実行するたびに課金される",
  };

  const providerPick = await vscode.window.showQuickPick(
    [
      ...providers.map((p) => ({
        label: p.displayName,
        description: providerDescriptions[p.id],
        providerId: p.id,
      })),
      // **取りやめる道を画面に出す。** Escでも閉じられるが、
      // それを知らない人には出口が無いように見える（作者の指摘、2026-08-21）
      cancelItem(),
    ],
    {
      title: "使用するAIを選んでください（1つで構いません）",
      ignoreFocusOut: true,
    }
  );
  if (!providerPick || !("providerId" in providerPick)) return false;

  const provider = registry.getProvider(providerPick.providerId)!;

  // APIキーが要るプロバイダは、接続テストの前に入力してもらう
  if (isApiKeyProvider(provider)) {
    const ok = await ensureApiKey(provider);
    if (!ok) return false;
  }

  // 接続テスト
  const test = await withProgress("接続を確認しています…", () =>
    provider.testConnection()
  );

  if (!test.ok) {
    // **Ollamaだけは、入っていない・起動していないことがある。**
    // 「設定を開く」と言われても、まだ何も入れていない人は何もできない。
    // 何が要るのかを一覧で見せる道へ案内する（作者の指示、2026-08-19）。
    //
    // クラウドのAIは鍵の入力で先に躓くので、ここへは来ない
    if (providerPick.providerId === "ollama") {
      const action = await vscode.window.showWarningMessage(
        "Ollamaにつながりませんでした。",
        {
          modal: true,
          detail:
            test.message +
            "\n\nOllamaは、お使いのパソコンの中でAIを動かす土台です。" +
            "無料で、原稿を外へ送りません。\n" +
            "まだ入れていない場合は、何がどれだけ要るのかを一覧でお見せします。",
        },
        "セットアップを始める"
      );
      if (action === "セットアップを始める") {
        // コマンド経由で呼ぶ。直接 import すると読み込みが循環する
        await vscode.commands.executeCommand("novelai.setupOllama");
      }
      return false;
    }

    const action = await vscode.window.showErrorMessage(
      test.message,
      "設定を開く",
      "閉じる"
    );
    if (action === "設定を開く") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        `novelai.${providerPick.providerId}`
      );
    }
    return false;
  }

  if (test.modelCount === 0) {
    vscode.window.showWarningMessage(test.message);
    return false;
  }

  // モデル一覧を取得
  const models = await withProgress("モデル情報を取得しています…", () =>
    provider.listModels()
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
    [
      ...models.map((m) => ({
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
      cancelItem(),
    ],
    { title: "使用するモデルを選んでください", ignoreFocusOut: true }
  );
  if (!modelPick || !("model" in modelPick)) return false;

  // 選んだモデルで実際に生成できるか確かめる。
  // モデル一覧は残高ゼロでも返ってくるので、ここまでの確認では
  // 「使える」と言い切れない。設定を終えたあと抽出で初めて
  // 失敗すると、作者は何が悪いのか分からない
  const probe = await withProgress("実際に生成できるか試しています…", () =>
    probeGeneration(provider, modelPick.model.id)
  );
  if (!probe.ok) {
    if (probe.error) {
      logFailure("AIの設定（生成の試行）", {
        種別: probe.error.kind,
        詳細: probe.error.detail,
        モデル: modelPick.model.id,
      });
    }
    const action = await vscode.window.showErrorMessage(
      `${probe.message ?? "生成できませんでした。"}\n設定は保存していません。`,
      "ログを表示",
      "閉じる"
    );
    if (action === "ログを表示") showLog();
    return false;
  }

  await registry.select(providerPick.providerId, modelPick.model.id);

  const m = modelPick.model;
  const notes: string[] = [];
  if (m.tier === "light") {
    notes.push(
      "このモデルは軽量です。矛盾検知など高度な判断が必要な機能では精度が下がる場合があります。"
    );
  }
  if (provider.isPaid) {
    notes.push(
      `以降このモデルで実行すると、実行のたびに${provider.displayName}側で利用量が加算されます。` +
        "実行前に処理量の目安を表示します。"
    );
  }

  vscode.window.showInformationMessage(
    `${provider.displayName} / ${m.displayName} を設定しました。${
      notes.length > 0 ? "\n" + notes.join("\n") : ""
    }`
  );
  return true;
}

/**
 * APIキーを確認し、無ければ入力してもらう。
 * キーは設定ファイルではなくOSの資格情報ストア（SecretStorage）に保存する。
 * settings.json に書くとGitで同期されて漏洩するため。
 */
async function ensureApiKey(provider: ApiKeyProvider): Promise<boolean> {
  const help = provider.apiKeyHelp;
  const existing = await provider.getApiKey();

  if (existing) {
    const answer = await vscode.window.showQuickPick(
      [
        { label: "登録済みのキーを使う", action: "keep" as const },
        { label: "キーを入力し直す", action: "replace" as const },
        cancelItem(),
      ],
      {
        title: `${provider.displayName}のAPIキーは登録済みです`,
        ignoreFocusOut: true,
      }
    );
    if (!answer || !("action" in answer)) return false;
    if (answer.action === "keep") return true;
  }

  const key = await askText({
    title: help.title,
    prompt: help.prompt,
    placeHolder: help.placeHolder,
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => help.validate(value),
  });
  if (!key) return false;

  await provider.setApiKey(key);
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

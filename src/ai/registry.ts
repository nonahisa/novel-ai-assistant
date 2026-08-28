import * as vscode from "vscode";
import {
  AIProvider,
  ApiKeyProvider,
  ModelInfo,
  ProviderId,
  isApiKeyProvider,
} from "./types";
import { MeteredProvider } from "./meteredProvider";
import { OllamaProvider } from "./ollamaProvider";
import { ClaudeProvider } from "./claudeProvider";
import { OpenAIProvider } from "./openaiProvider";
import { SakuraProvider } from "./sakuraProvider";
import { LmStudioProvider } from "./lmstudioProvider";
import { GeminiProvider } from "./geminiProvider";
import { withProgress } from "../views/progress";
import { probeGeneration } from "./generationProbe";
import { logFailure, logStep, showLog } from "../core/logger";
import { askText, cancelItem } from "../views/dialogs";
import { canRunProcesses } from "../core/runtime";

const KEY_PROVIDER = "novelai.ai.provider";
const KEY_MODEL = "novelai.ai.model";
/**
 * 機能ごとのAI割当（設計書6.28.7の1）。
 *
 * **`globalState` に置く**（いまのAI選択と同じ場所）。設定同期に乗せると、
 * Ollamaの入っていない端末へ「抽出はOllamaで」という割当が流れ込み、
 * その端末では必ず失敗する。
 */
const KEY_FEATURE_ASSIGNMENTS = "novelai.ai.featureAssignments";

/**
 * 作者が割り当てを選べる機能のまとまり。増やすときはメニューの文言も揃える。
 *
 * **粒度は「作者が使い分けたい単位」で切っている。** 内部の
 * `meta.feature`（`contradiction_verify` など）より粗いのは、
 * 矛盾検知の本体と検証だけ別のAIにしたい作者はいないため。
 */
export type AssignableFeature =
  | "extract" // 設定資料の抽出（人物・場所・能力・組織・世界観、AIで再読込・項目の充実）
  | "typo" // 誤字脱字
  | "proofread" // 推敲
  | "contradiction" // 矛盾検知（指摘の検証・再チェックも含む）
  | "deviation" // プロットからの逸脱
  | "foreshadow" // 伏線の検知（配置と回収。どちらも同じ台帳を見る）
  | "generate" // あらすじ・紹介文・キャッチコピー・プロット逆算・冒頭診断・感情曲線
  | "chat"; // 相談（相談パネル・設定の相談・検索語の生成・独り言）

/**
 * 機能の表示名。**画面に出す名前はここだけが持つ。**
 * 割当の選択画面・通知・ログのすべてがこれを読む。
 */
export const ASSIGNABLE_FEATURE_LABELS: Record<AssignableFeature, string> = {
  extract: "設定資料の抽出",
  typo: "誤字脱字",
  proofread: "推敲",
  contradiction: "矛盾検知",
  deviation: "プロットからの逸脱",
  foreshadow: "伏線の検知",
  generate: "あらすじ・紹介文・キャッチコピーなど",
  chat: "AIに相談",
};

/** 選択画面に並べる順。重い（＝手元AIの効きが大きい）ものから */
export const ASSIGNABLE_FEATURES: AssignableFeature[] = [
  "extract",
  "typo",
  "proofread",
  "contradiction",
  "deviation",
  "foreshadow",
  "generate",
  "chat",
];

export interface FeatureAssignment {
  provider: ProviderId;
  model: string;
}

/**
 * 保存されている割当。**キーが無い＝既定を使う。**
 *
 * 「機能別割当が有効か」のフラグは作らない（設計書6.28.7）。
 * フラグと中身の2か所が食い違うと、割り当てたのに効かない・
 * 外したのに効き続ける、という追いにくい状態ができる。
 */
export type FeatureAssignments = Partial<
  Record<AssignableFeature, FeatureAssignment>
>;

/**
 * 実行環境で選べないプロバイダを外す。
 *
 * **`AIRegistry.listProviders` から切り出した。** `canRunProcesses()` は
 * 実際のNode/ブラウザの違いでしか変わらないので、単体テストからは
 * どちらか一方（常にNode側）しか確かめられない。フィルタの中身だけを
 * 純粋な関数にして、両方の分岐をテストできるようにする。
 */
/**
 * 手元のPCで動くもの。**ブラウザ版では選ばせない。**
 *
 * `localhost` はブラウザからは（vscode.dev が動いているMicrosoftのサーバ
 * から見て）作者のPCではないので、選んでも必ず「接続できません」になる。
 */
const LOCAL_PROVIDERS = new Set<ProviderId>(["ollama", "lmstudio"]);

export function filterProvidersForRuntime(
  providers: AIProvider[],
  canRun: boolean
): AIProvider[] {
  return canRun ? providers : providers.filter((p) => !LOCAL_PROVIDERS.has(p.id));
}

/**
 * 使用するプロバイダとモデルを解決する。
 *
 * 設計方針として「1つだけ使う」を標準ケースとしており、
 * 既定では全機能が同じプロバイダ・モデルを使う。
 */
export class AIRegistry {
  private readonly providers = new Map<ProviderId, AIProvider>();
  /** 送信量を記録する包み。プロバイダごとに1つだけ作る */
  private readonly metered = new Map<ProviderId, AIProvider>();

  /**
   * 選択（プロバイダ・モデル）が変わったことを知らせる。
   *
   * 選択は `globalState` にあり、**変えても VS Code からは何の合図も出ない。**
   * そのため、開きっぱなしの相談パネルはエンジン表示を更新するきっかけが
   * 無く、切り替え前の名前を出し続けていた（0.22.15で判明。実際に送る側は
   * 毎回 `resolve()` し直すので、古かったのは表示だけ）。
   */
  private readonly selectionEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeSelection: vscode.Event<void> =
    this.selectionEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    // 並び順はそのまま選択画面に出る。無料で始められるものを先頭に置く
    for (const provider of [
      new OllamaProvider(),
      new LmStudioProvider(),
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
    this.selectionEmitter.fire();
  }

  async clear(): Promise<void> {
    await this.context.globalState.update(KEY_PROVIDER, undefined);
    await this.context.globalState.update(KEY_MODEL, undefined);
    this.selectionEmitter.fire();
  }

  /** 機能ごとの割当。**キーが無い機能は既定のAIを使う** */
  assignments(): FeatureAssignments {
    return (
      this.context.globalState.get<FeatureAssignments>(
        KEY_FEATURE_ASSIGNMENTS
      ) ?? {}
    );
  }

  async assign(
    feature: AssignableFeature,
    providerId: ProviderId,
    model: string
  ): Promise<void> {
    const next: FeatureAssignments = {
      ...this.assignments(),
      [feature]: { provider: providerId, model },
    };
    await this.context.globalState.update(KEY_FEATURE_ASSIGNMENTS, next);
    // 開きっぱなしのパネルのエンジン表示を追従させる（選択の変更と同じ扱い）
    this.selectionEmitter.fire();
  }

  async unassign(feature: AssignableFeature): Promise<void> {
    const next = { ...this.assignments() };
    delete next[feature];
    await this.context.globalState.update(KEY_FEATURE_ASSIGNMENTS, next);
    this.selectionEmitter.fire();
  }

  /**
   * その機能で使うプロバイダとモデルを解決する。未設定なら undefined。
   *
   * **引数は必須にしてある。** 既定値を持たせると、渡し忘れた場所が
   * 黙って既定のAIで動く。とくに `resolveModelInfo` の渡し忘れは、
   * 既定モデルのコンテキスト長で本文を切って割当先へ送ることになり、
   * 入力が黙って切り捨てられる（この作品でいちばん怖い形）。
   *
   * `"default"` は「どの機能でもない場所」用——版の表示・接続の確認など、
   * いま何を選んでいるかを見せるだけの所で使う。
   *
   * **返すのは送信量を記録する包み**（`MeteredProvider`）である。
   * AI機能はすべてここからプロバイダを受け取るので、包みを1つ挟むだけで
   * 10か所ある呼び出しを1行も変えずに記録できる。
   *
   * **有料の確認はここでは出さない。** 実行前の確認（設計書7.1.1）が
   * プロバイダ名・モデル名つきで必ず出るので、割当で有料AIへ回った場合も
   * そこで作者の目に入る。`resolve()` は画面の更新のたびに呼ばれるため、
   * ここでモーダルを出すと相談パネルを開いただけで確認が飛ぶ。
   */
  resolve(
    feature: AssignableFeature | "default"
  ): { provider: AIProvider; model: string } | undefined {
    const assigned =
      feature === "default" ? undefined : this.assignments()[feature];
    if (assigned) {
      const provider = this.providers.get(assigned.provider);
      if (provider && this.isUsableHere(provider)) {
        return { provider: this.meter(provider), model: assigned.model };
      }
      // 割当先が使えないときは既定へ落とす。**止めない。**
      // ブラウザ版で開いただけで全機能が死ぬのは、作者から見て
      // 「壊れた」としか見えない（設計書5.8の「消さずに理由を出す」）
      this.noteFallback(feature as AssignableFeature, assigned.provider);
    }

    const id = this.selectedProviderId;
    const model = this.selectedModel;
    if (!id || !model) return undefined;
    const provider = this.providers.get(id);
    if (!provider) return undefined;
    return { provider: this.meter(provider), model };
  }

  /** この実行環境で選べるプロバイダか（ブラウザ版では手元のAIが使えない） */
  private isUsableHere(provider: AIProvider): boolean {
    return (
      filterProvidersForRuntime([provider], canRunProcesses()).length > 0
    );
  }

  /**
   * 既定へ落としたことをログに残す。
   *
   * **同じ組み合わせは一度だけ書く。** `resolve()` は画面の更新のたびに
   * 呼ばれるので、毎回書くとログが同じ行で埋まって他が読めなくなる。
   * 割り当て直せばキーが変わるので、そのときは改めて記録される。
   */
  private readonly loggedFallbacks = new Set<string>();

  private noteFallback(
    feature: AssignableFeature,
    providerId: ProviderId
  ): void {
    const key = `${feature}:${providerId}`;
    if (this.loggedFallbacks.has(key)) return;
    this.loggedFallbacks.add(key);
    const name = this.providers.get(providerId)?.displayName ?? providerId;
    logStep(
      `${ASSIGNABLE_FEATURE_LABELS[feature]}: ` +
        `割当のAI（${name}）が使えないため、既定のAIで実行します`
    );
  }

  /**
   * 送信量を記録できる形にして返す。
   *
   * **同じプロバイダには同じ包みを返す。** `resolve()` は画面の更新の
   * たびに呼ばれるので、毎回作ると同じプロバイダが別物として増えていく。
   */
  private meter(provider: AIProvider): AIProvider {
    const existing = this.metered.get(provider.id);
    if (existing) return existing;
    const wrapped = new MeteredProvider(provider);
    this.metered.set(provider.id, wrapped);
    return wrapped;
  }

  /**
   * その機能で使うモデルの詳細（コンテキスト長など）を取得する。
   *
   * **機能キーを必ず渡すこと。** ここだけ渡し忘れると、既定モデルの
   * コンテキスト長でチャンクを切って割当先のモデルへ送ることになり、
   * 入力が黙って切り捨てられる（設計書6.28.7）。
   */
  async resolveModelInfo(
    feature: AssignableFeature | "default"
  ): Promise<ModelInfo | undefined> {
    const resolved = this.resolve(feature);
    if (!resolved) return undefined;
    const p = resolved.provider;
    // 個別取得できるプロバイダは一覧を引かずに済ませる（呼び出し回数の節約）
    if (p.getModel) return p.getModel(resolved.model);
    const all = await p.listModels();
    return all.find((m) => m.id === resolved.model);
  }
}

/** プロバイダとモデルが決まったときの結果 */
export interface ProviderAndModelPick {
  providerId: ProviderId;
  /**
   * 素のプロバイダ（送信量を記録する包みではない）。
   * 通知の名前と有料判定に使う
   */
  provider: AIProvider;
  /** 選ばれたモデルの詳細。`id` が実際に保存する値 */
  model: ModelInfo;
}

/**
 * プロバイダを選び、鍵を入れ、接続を確かめ、モデルを選び、
 * 実際に1回生成できるところまでを確かめる。
 *
 * **AI設定のウィザードから切り出した**（設計書7.1）。機能ごとの割当でも
 * 同じ手順が要るので、2つ目の実装を書かない。書くと、片方だけ直された
 * ときに「AI設定では通るのに割当では通らない」が起きる。
 *
 * ここでは**保存しない。** 何に使うか（既定にするのか、ある機能へ
 * 割り当てるのか）は呼び出し側が決める。
 */
export async function pickProviderAndModel(
  registry: AIRegistry
): Promise<ProviderAndModelPick | undefined> {
  const providers = registry.listProviders();

  const providerDescriptions: Partial<Record<ProviderId, string>> = {
    ollama: "無料・オフライン可。ローカル実行",
    lmstudio: "無料・オフライン可。ローカル実行",
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
  if (!providerPick || !("providerId" in providerPick)) return undefined;

  const provider = registry.getProvider(providerPick.providerId)!;

  // APIキーが要るプロバイダは、接続テストの前に入力してもらう
  if (isApiKeyProvider(provider)) {
    const ok = await ensureApiKey(provider);
    if (!ok) return undefined;
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
      return undefined;
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
    return undefined;
  }

  if (test.modelCount === 0) {
    vscode.window.showWarningMessage(test.message);
    return undefined;
  }

  // モデル一覧を取得
  const models = await withProgress("モデル情報を取得しています…", () =>
    provider.listModels()
  );

  if (models.length === 0) {
    vscode.window.showWarningMessage("利用可能なモデルが見つかりませんでした。");
    return undefined;
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
  if (!modelPick || !("model" in modelPick)) return undefined;

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
    return undefined;
  }

  return {
    providerId: providerPick.providerId,
    provider,
    model: modelPick.model,
  };
}

/**
 * AI設定のセットアップウィザード。
 * 未設定でAI機能を呼んだ場合にもここへ誘導する。
 *
 * 選ぶところは `pickProviderAndModel` が持つ。ここは**選んだものを
 * 既定として保存する**役目だけを持つ。
 */
export async function runSetupWizard(
  registry: AIRegistry
): Promise<boolean> {
  const picked = await pickProviderAndModel(registry);
  if (!picked) return false;

  await registry.select(picked.providerId, picked.model.id);

  const provider = picked.provider;
  const m = picked.model;
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

/**
 * AI機能の実行前に呼ぶ。未設定ならウィザードを出す。
 *
 * **機能キーは必須。** その機能に割当があればそれを使う（設計書6.28.7）。
 */
export async function ensureConfigured(
  registry: AIRegistry,
  feature: AssignableFeature | "default"
): Promise<{ provider: AIProvider; model: string } | undefined> {
  const resolved = registry.resolve(feature);
  if (resolved) return resolved;

  const answer = await vscode.window.showInformationMessage(
    "AIがまだ設定されていません。設定しますか？",
    "設定する",
    "後で"
  );
  if (answer !== "設定する") return undefined;

  const ok = await runSetupWizard(registry);
  return ok ? registry.resolve(feature) : undefined;
}

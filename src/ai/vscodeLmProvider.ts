import * as vscode from "vscode";
import {
  AIError,
  type AIProvider,
  type ConnectionTestResult,
  type GenerateParams,
  type GenerateResult,
  type CapabilityTier,
  type ModelInfo,
} from "./types";
import { withAiWork } from "../core/aiActivity";
import { logLine } from "../core/logger";

/**
 * VS Code のエディタが持っているAI（設計書6.87.11）。
 *
 * **作者の指示（2026-09-16）**：「既存の接続先に追加する方針で行きましょう」。
 *
 * ## これは何のためにあるか
 *
 * **内側から外部AIへ回す道**（引継ぎ書3章の「2番」）。ほかの接続先が
 * 「この製品がAIサービスを直に叩く」形なのに対し、ここは**VS Code が
 * 用意した口を通す**。鍵はこの製品ではなく VS Code 側が持つ。
 *
 * ## なぜ正規の口を使うのか（作者の裁定、2026-09-15）
 *
 * 定額のサブスクを製品の裏側として叩く形は、多くの規約で想定外か
 * 明示的に禁じられている。**`vscode.lm` は Microsoft が「拡張機能が
 * 利用者のAI契約を使う」ために用意した口**で、利用者の同意を求める
 * 仕組みが組み込まれている。**規約の問題を設計で回避できる。**
 *
 * ## ほかの接続先と違うところ
 *
 * | | |
 * |---|---|
 * | APIキー | **この製品は持たない**（VS Code 側に在る） |
 * | 形式の強制 | **できない**（`jsonSchema` に当たる口が無い） |
 * | 起点 | **作者の操作でしか呼べない**（下の断り書き） |
 * | 出力の上限 | 指定できない |
 *
 * **形式を強制できないのは、この口のいちばんの弱みである。** ほかの
 * 接続先はスキーマを渡してJSONを強制できるが、ここはプロンプトで頼む
 * しかない。**製品の検算はもともとAIの出力を信用しない作りなので壊れは
 * しないが、読めない応答が増えればそのチャンクは捨てられる**
 * （CLAUDE.md「AIの出力を信用しない」）。実データで測ってから、
 * どの機能に向くかを決めること。
 */

/**
 * **同意の求め方**（`sendRequest` の断り書き）。
 *
 * > this function must _only be called in response to a user action!_
 *
 * 初回は同意のダイアログが出る。**作者がボタンを押した流れの中でしか
 * 呼べない**ので、自動で走る処理（保存時の記録・裏での測定）には使えない。
 * 押して始まる機能（抽出・誤字脱字・推敲・相談）は、どれも起点が
 * 作者の操作なので問題ない。
 */
const CONSENT_NOTE =
  "この作品の本文を、VS Code のAIへ渡して読んでもらいます。";

/**
 * 一覧に出すときの名前。
 *
 * **提供元まで出す。** `vscode.lm` には Copilot だけでなく、VS Code 側へ
 * 鍵を入れた Anthropic・Google・OpenAI なども並ぶ（同梱の Copilot Chat が
 * まとめて出している）。どれを使うのかが分からないまま選ばせない。
 */
function describeModel(model: vscode.LanguageModelChat): string {
  return `${model.name}（${model.vendor}）`;
}

/**
 * 読める長さから、モデルの格を決める。
 *
 * **この口にはパラメータ数が来ない**ので、分かる値で決めるしかない。
 * 境目は Ollama 側（`inferTier`）と同じ考え方——**小説の本文を分けて
 * 送れるか**で分ける。
 *
 * - 32k 未満：**1チャンクに入る量が少ない**。軽量として扱う
 * - 200k 未満：ふつうに使える
 * - それ以上：まとめて読ませられる
 */
function tierForContextWindow(contextWindow: number): CapabilityTier {
  if (contextWindow < 32_000) return "light";
  if (contextWindow < 200_000) return "standard";
  return "high";
}

/**
 * 手元のAIを、VS Code 経由で又借りしている提供元。
 *
 * **落とす。** この製品は Ollama を**直に繋げる**（`OllamaProvider`）。
 * 又借りすると遠回りなうえ、**`num_ctx` を渡せず、JSONスキーマも渡せない**
 * ——CLAUDE.md 規則6の「`num_ctx` を必ず明示する」を満たせないので、
 * 入力が黙って切り捨てられる。**明確に劣る道を選択肢に残さない。**
 *
 * 作者の環境では、この2つで**16件**を占めていた（同じ8つが二重に出る）。
 */
const RELAYED_LOCAL_VENDORS = new Set(["ollama", "ollama-models"]);

/**
 * 本文を送れる最低限の長さ。
 *
 * **0 を返す提供元が実在する**（作者の環境の `copilotcli` の Auto）。
 * そこへ本文を送っても1文字も入らない。**選ばせてはいけない。**
 */
const MIN_USABLE_INPUT_TOKENS = 1000;

/**
 * 選ばせてよいモデルだけにする（作者の指摘、2026-09-16「選択肢が多すぎる」）。
 *
 * **落とす根拠は、全部ログの実物にある**——当て推量で消していない。
 *
 * 1. **本文が入らないもの**（`maxInputTokens` が極端に小さい）
 * 2. **手元のAIの又借り**（上の断り書き）
 * 3. **同じ実体の別名**——`version` が同じものは同じモデルである。
 *    作者の環境では `gpt-4o-mini` と `copilot-utility-small` が
 *    同じ `gpt-4o-mini-2024-07-18`、`gpt-5.6-luna` と
 *    `copilot-dictation-cleanup-luna` が同じ `gpt-5.6-luna` だった。
 *    **素直な名前のほうを残す**（`id` が短いほう）
 */
export function usableModels(
  models: readonly vscode.LanguageModelChat[]
): vscode.LanguageModelChat[] {
  const kept = models.filter(
    (model) =>
      !RELAYED_LOCAL_VENDORS.has(model.vendor) &&
      (model.maxInputTokens ?? 0) >= MIN_USABLE_INPUT_TOKENS
  );

  /*
    **同じ実体を畳む。** `version` が空のものは畳まない——
    空どうしを同じと見なすと、無関係なモデルまでまとめてしまう。
  */
  const byVersion = new Map<string, vscode.LanguageModelChat>();
  const noVersion: vscode.LanguageModelChat[] = [];
  for (const model of kept) {
    const version = model.version?.trim();
    if (!version) {
      noVersion.push(model);
      continue;
    }
    const found = byVersion.get(version);
    if (!found || model.id.length < found.id.length) {
      byVersion.set(version, model);
    }
  }

  // **元の並びを保つ**（提供元が意味のある順で返しているかもしれない）
  const survivors = new Set([...byVersion.values(), ...noVersion]);
  return kept.filter((model) => survivors.has(model));
}

/**
 * 提供元にまかせる「自動選択」か。
 *
 * **名前で見分ける。** 型（VS Code 1.90）には、そうと分かる欄が無い。
 * 外しても**順番が変わらないだけ**で、選択肢は落とさないので害は小さい
 * ——落とす判断に名前を使うのは危ういが、並べ替えなら許される。
 */
function isAutoModel(model: vscode.LanguageModelChat): boolean {
  return /\bauto\b/i.test(model.id) || /\bauto\b/i.test(model.family ?? "");
}

/**
 * 記録に出すための、そのままの姿。
 *
 * **型（VS Code 1.90 の定義）に無い欄も拾う。** 作者の VS Code は 1.137 で、
 * **新しい欄が増えている可能性がある**——「無料か有料か」「自動選択か」を
 * 見分ける手がかりがそこに在るかもしれない。無いと決めつけない
 * （CLAUDE.md「外の状態を文書だけで判断しない」）。
 *
 * **関数は落とす**（`sendRequest` などは記録にならない）。
 */
function plainModel(model: vscode.LanguageModelChat): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // 自分の欄と、継いでいる欄の両方を見る
  for (const key of new Set([
    ...Object.keys(model),
    ...Object.keys(Object.getPrototypeOf(model) ?? {}),
  ])) {
    const value = (model as unknown as Record<string, unknown>)[key];
    if (typeof value === "function") continue;
    out[key] = value;
  }
  return out;
}

/**
 * `vscode.lm` の失敗を、この製品の言葉へ直す。
 *
 * **3つを分ける**（CLAUDE.md 規則5「失敗の種別ごとに、次に取れる操作を
 * 1つ示す」）。どれも直し方が違う。
 *
 * - `NoPermissions`：同意していない → **もう一度実行して同意する**
 * - `Blocked`：枠を使い切った → **待つか、契約を見直す**
 * - `NotFound`：モデルが消えた → **選び直す**
 */
function toAiError(error: unknown, model: string): AIError {
  if (error instanceof vscode.LanguageModelError) {
    const code = error.code;
    if (code === "NoPermissions") {
      return new AIError(
        "VS Code のAIを使う許可がありません。もう一度実行して、出てくる確認で「許可」を選んでください。",
        "permission_denied",
        error.message
      );
    }
    if (code === "Blocked") {
      return new AIError(
        "VS Code のAIの利用枠を使い切ったか、要求が拒まれました。" +
          "しばらく待つか、手元のAI（Ollama）へ切り替えてください。",
        "insufficient_credit",
        error.message
      );
    }
    if (code === "NotFound") {
      return new AIError(
        `モデル「${model}」が見つかりません。AI設定で選び直してください。`,
        "model_not_found",
        error.message
      );
    }
    return new AIError(
      `VS Code のAIが応えませんでした（${code}）。`,
      "unknown",
      error.message
    );
  }
  if (error instanceof vscode.CancellationError) {
    return new AIError("中止しました。", "aborted");
  }
  const message = error instanceof Error ? error.message : String(error);
  return new AIError(
    `VS Code のAIが応えませんでした（${message}）。`,
    "unknown",
    message
  );
}

export class VsCodeLmProvider implements AIProvider {
  readonly id = "vscode-lm" as const;
  /**
   * 一覧に出す名前（作者の指示、2026-09-16「VScode経由でつなぐ」）。
   *
   * **提供元の名前にしない。** ここは Copilot 専用の口ではなく、
   * **VS Code 側に繋いであるAIを借りる口**である——Copilot でも、
   * VS Code へ鍵を入れた Anthropic・Google・OpenAI でも、同じここから出る。
   * 「Copilot」と名乗ると、鍵を入れた作者が見つけられない。
   */
  readonly displayName = "VS Code 経由でつなぐ";

  /**
   * **課金される扱いにする。**
   *
   * 実際に請求されるかは作者の契約次第だが、**無料枠には月あたりの
   * 上限がある**（Copilot Free はチャット50回／月）。手元のAIと同じ
   * 「いくら使っても同じ」ではないので、処理量の確認を出す側に倒す。
   */
  readonly isPaid = true;

  /**
   * **上限を送らない。**
   *
   * `LanguageModelChatRequestOptions` に出力の上限を渡す口が無い。
   * 送っていないのに「送った」と数えると、送信前の関所（`contextGuard`）が
   * 実際と違う見込みで判断する。
   */
  readonly capsOutput = false;

  /** 一覧を引き直す手間を省く。`onDidChangeChatModels` で捨てる */
  private cache: vscode.LanguageModelChat[] | undefined;

  constructor() {
    /*
      **モデルの顔ぶれは変わる**（サインイン・鍵の追加・契約の変更）。
      VS Code が知らせてくれるので、そのたびに覚えを捨てる。

      **`vscode.lm` が無くても壊れない形で触る。** 構築の時点で落ちると、
      **AI設定の一覧ごと開けなくなる**——この接続先が使えないだけでなく、
      Ollama も Gemini も選べなくなる。口そのものは VS Code 1.90 から
      在るが、**在ることを当てにしない**（作者の環境が古い場合や、
      口を塞いだ配布物がありうる）。知らせが来なくても、
      そのときは覚えを持たずに毎回引き直せばよい。
    */
    try {
      vscode.lm?.onDidChangeChatModels?.(() => {
        this.cache = undefined;
      });
    } catch {
      /* 知らせを受け取れないだけ。使えなくはならない */
    }
  }

  /** この道が使える状態か。**1つでもモデルが見えていれば使える** */
  async isConfigured(): Promise<boolean> {
    return (await this.chatModels()).length > 0;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const models = await this.chatModels();
    /*
      **見えたものを、そのまま記録へ出す**（作者の指摘、2026-09-16
      「選択肢が多すぎる」）。どう絞るかを決めるには、**いま何が返って
      いるのかを知る必要がある**——推測で絞ると、使えるものまで落とす。

      押したときの1回だけなので溜まらない。型（1.90）に無い欄も
      拾えるよう、そのまま並べる。
    */
    logLine(
      `VS Code 経由：${models.length}件のモデルが見えています\n` +
        models
          .map((model) => `  ${JSON.stringify(plainModel(model))}`)
          .join("\n")
    );
    if (models.length === 0) {
      return {
        ok: false,
        message:
          "VS Code のAIが1つも見つかりません。" +
          "GitHub Copilot にサインインするか、VS Code の設定でAIの鍵を入れてから、もう一度お試しください。",
      };
    }
    return {
      ok: true,
      message: `${models.length}件のモデルが使えます（${describeModel(models[0])} ほか）。`,
      modelCount: models.length,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    /*
      **自動選択を先頭に置く**（作者の指摘、2026-09-16「選択肢が多すぎる」
      「オート等使えるものだけ出したほうが良い」）。

      作者の環境では**23件**返った。その中の「Auto」は、**提供元が
      そのとき使えるモデルを選んでくれる**ので、契約や枠が変わっても
      外れにくい——Copilot の無料枠は**自動選択しか使えない**ので、
      個別のモデルを選ばせると枠を持たない作者が必ず失敗する。

      **落とさずに、順番だけ変える。** どれが使えるかを機械で見分ける
      手立てが（VS Code 1.90 の型には）無いので、**こちらの当て推量で
      選択肢を消さない**。読める長さや提供元は一覧に出るので、
      作者が選べる状態は保つ。
    */
    const usable = usableModels(await this.chatModels());
    const auto = usable.filter((model) => isAutoModel(model));
    const rest = usable.filter((model) => !isAutoModel(model));
    return [...auto, ...rest].map((model) => this.toModelInfo(model));
  }

  async getModel(id: string): Promise<ModelInfo | undefined> {
    const found = (await this.chatModels()).find((model) => model.id === id);
    return found ? this.toModelInfo(found) : undefined;
  }

  async generate(params: GenerateParams): Promise<GenerateResult> {
    return withAiWork(() => this.generateInner(params));
  }

  private async generateInner(
    params: GenerateParams
  ): Promise<GenerateResult> {
    const started = Date.now();
    const models = await this.chatModels();
    const model =
      models.find((one) => one.id === params.model) ??
      models.find((one) => one.name === params.model);
    if (!model) {
      throw new AIError(
        `モデル「${params.model}」が見つかりません。AI設定で選び直してください。`,
        "model_not_found"
      );
    }

    /*
      **形式はプロンプトで頼む**（この口にはスキーマを渡す先が無い）。
      製品の検算は読めない応答を捨てる作りなので壊れはしないが、
      **頼んでおかないと捨てる率が上がる。**
    */
    const userPrompt = params.jsonSchema
      ? `${params.userPrompt}\n\n※ 返事はJSONだけにしてください。説明文やコードの囲みは付けないでください。`
      : params.userPrompt;

    const messages = [
      /*
        **システムの指示も User として送る。** この口の
        `LanguageModelChatMessage` には System が無い（User と Assistant だけ）。
        指示を落とすと、作品の書き方も禁止事項も届かなくなるので、
        本文の前に置く。
      */
      vscode.LanguageModelChatMessage.User(params.systemPrompt),
      vscode.LanguageModelChatMessage.User(userPrompt),
    ];

    const source = new vscode.CancellationTokenSource();
    // 呼び出し側の中止（進捗表示の「中止」）をそのまま渡す
    const stop = params.signal?.addEventListener
      ? (() => {
          const onAbort = (): void => source.cancel();
          params.signal.addEventListener("abort", onAbort, { once: true });
          return () => params.signal?.removeEventListener("abort", onAbort);
        })()
      : undefined;

    try {
      const response = await model.sendRequest(
        messages,
        { justification: CONSENT_NOTE },
        source.token
      );

      let text = "";
      for await (const part of response.text) text += part;

      return {
        text,
        /*
          **使った量は数えられない。** この口は消費を返さない。
          0を入れると「測ったうえで0だった」に見えるので、入れない
          （`usage` を省く＝数えられない、の意味。`GenerateResult` の
          `cachedInputTokens` と同じ考え方）。
        */
        truncated: false,
        elapsedMs: Date.now() - started,
      };
    } catch (error) {
      throw toAiError(error, params.model);
    } finally {
      stop?.();
      source.dispose();
    }
  }

  private async chatModels(): Promise<vscode.LanguageModelChat[]> {
    if (this.cache) return this.cache;
    try {
      /*
        **絞り込まずに全部引く。** ベンダーを決め打ちすると、Copilot を
        持たない作者（VS Code 側に別の鍵を入れている作者）から選択肢が
        消える。並べて選ばせるほうが、この製品の作りに合っている。
      */
      // **口が無ければ「1つも見えない」とする**（上の断り書きと同じ理由）
      this.cache = (await vscode.lm?.selectChatModels?.()) ?? [];
    } catch {
      // **一覧すら引けないのは、まだ何も繋がっていないということ。**
      // ここで投げると、AI設定の画面がプロバイダの一覧ごと開けなくなる
      this.cache = [];
    }
    return this.cache;
  }

  private toModelInfo(model: vscode.LanguageModelChat): ModelInfo {
    /*
      **読める長さは向こうが教えてくれる**（`maxInputTokens`）。
      CLAUDE.md 規則6のとおり、教えてくれる値は必ずそちらを使う。
    */
    const contextWindow = model.maxInputTokens;
    return {
      id: model.id,
      displayName: describeModel(model),
      contextWindow,
      parameterSize: null,
      // 何ができるかは向こうが教えてくれない。分かるのは提供元と家系だけ
      capabilities: [model.vendor, model.family].filter(Boolean),
      /*
        **読める長さで決める**（作者の実機、2026-09-16）。

        ほかのクラウドは一律「高性能」でよいが、**この口には文脈 12k の
        モデルが混ざる**（GPT-4o mini）。印は**プロンプトとチャンクの
        大きさを決める**のに使うので、12k を高性能と扱うと送る量を見誤る。

        パラメータ数は教えてもらえないので、**分かる値で決める**。
        長さと能力は別物だが、この口に並ぶ顔ぶれでは概ね揃っている
        （小さいモデルほど文脈も短い）。
      */
      tier: tierForContextWindow(contextWindow),
    };
  }
}

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpToolError } from "./shared";
import { assertSamplingAllowed } from "./permission";

/**
 * 呼び出し元のAIに、考えてもらう（MCP の sampling。設計書6.87.12）。
 *
 * **作者の指示（2026-09-16）**：「２をすすめてください」＝ MCP の sampling。
 *
 * ## `runner: "claude"` と何が違うか
 *
 * | | 往復 | 検算 |
 * |---|---|---|
 * | `claude` | プロンプトを返す → 読む → `validate` へ戻す（**3回**） | 呼ぶ側が忘れうる |
 * | `sampling` | サーバーが頼んで答えを受け取る（**1回**） | **こちらで必ず通す** |
 *
 * **検算を迂回できないのが、いちばんの値打ち。** `claude` の道は、
 * `prompt` だけ呼んで `validate` を通さない使い方ができてしまう
 * ——それは**製品に無い不具合を見つけたことになる**（6.87.6 の3）。
 * sampling なら、サーバーの中で `prompt → 応答 → 検算` が閉じる。
 *
 * ## 規約の面
 *
 * **モデルを呼ぶのはクライアント自身**なので、作者の契約の中で完結する
 * （6.87.10 の裁定と同じ考え）。サーバーは「これを考えてほしい」と頼むだけで、
 * 鍵も持たなければ、どのAIが答えるかも選べない。
 *
 * ## 使えるとは限らない
 *
 * **クライアントが対応を宣言していなければ使えない。** 対応は実装ごとに違い、
 * **実際に繋いで訊くまで分からない**（CLAUDE.md の「外の状態を文書だけで
 * 判断しない」）。だから毎回 `getClientCapabilities()` を見て、
 * 無ければ**何を選べばよいかを添えて断る**。
 */

/**
 * 頼む相手（＝いま繋いでいるクライアント）。
 *
 * **転送層が渡す。** ここから `server.ts` を参照すると読み込みが循環するので、
 * 向こうから預けてもらう形にする。
 */
let host: Server | undefined;

export function setSamplingHost(server: Server): void {
  host = server;
}

/** 試験から差し替えるための口。**本番では転送層しか呼ばない** */
export function clearSamplingHost(): void {
  host = undefined;
}

/**
 * この道が使えるか。
 *
 * **宣言を見る。** 使えないのに投げると、呼んだ側には「失敗した」としか
 * 見えない——**選び直せる道を示すために、先に確かめる。**
 */
export function samplingAvailable(): boolean {
  return Boolean(host?.getClientCapabilities()?.sampling);
}

/**
 * 断りの文面。**ここが唯一の定義**（写すとずれる）。
 *
 * **何ができないか・なぜか・代わりに何を選ぶか**の3つを書く。
 */
export const SAMPLING_UNAVAILABLE =
  "この呼び出し元は sampling（サーバーから考えを頼む仕組み）に対応していません。" +
  "runner を ollama（手元のOllamaで検算まで通す）か claude（プロンプトを返すので、" +
  "読んだ応答を validate へ戻す）にしてください。";

export interface SamplingRequest {
  /**
   * どの作品か。**許可を確かめるために要る**（設計書6.87.12）。
   *
   * **読ませる許可とは別に、考えさせる許可が要る**（作者の指示、
   * 2026-09-16「ここでも、初期は閉鎖」）。渡さなければ断る。
   */
  folder: string | undefined;
  systemPrompt: string;
  userPrompt: string;
  /**
   * 書いてよい上限。
   *
   * **仕様で必須**（`maxTokens`）。呼ぶ側が決められないときのために既定を持つ
   * ——抽出のJSONは長くなるので、短く見積もると**途中で切れて、その
   * チャンクが丸ごと捨てられる**（設計書6.58.2と同じ事情）。
   */
  maxTokens?: number;
  /** 揺らぎ。検算にかける用途では低くする */
  temperature?: number;
}

export interface SamplingReply {
  text: string;
  /** 答えたモデル。**こちらでは選べない**ので、記録のために受け取る */
  model: string;
  /** 途中で切れたか（`maxTokens` に当たった） */
  truncated: boolean;
}

/** 既定の上限。抽出の応答が入る程度に大きく取る */
const DEFAULT_MAX_TOKENS = 8192;

/**
 * 呼び出し元に考えてもらう。
 *
 * **本文はクライアントへ渡る。** どのAIが答えるかはクライアントが決めるので、
 * **原稿の行き先を製品側では約束できない**——ツールの説明にそう書く。
 */
export async function askSampling(
  request: SamplingRequest
): Promise<SamplingReply> {
  /*
    **作者が許しているか、先に確かめる**（設計書6.87.12。作者の指示、
    2026-09-16）。**既定は拒否。** 読ませる許可とは別で、こちらは
    **本文が呼び出し元の選んだAIへ渡る**——許可の重みが違う。

    **呼ぶ前に断る**ので、断られた回は本文がどこへも出ない。
  */
  assertSamplingAllowed(request.folder);

  if (!host || !samplingAvailable()) {
    throw new McpToolError(SAMPLING_UNAVAILABLE);
  }

  const reply = await host.createMessage({
    messages: [
      {
        role: "user",
        content: { type: "text", text: request.userPrompt },
      },
    ],
    // **システムの指示は専用の欄へ**（クライアントが省くこともある、と仕様にある）
    systemPrompt: request.systemPrompt,
    maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
    /*
      **ほかのサーバーの文脈を混ぜない**（`includeContext: "none"`）。
      混ぜると、**測っているものが製品のプロンプトでなくなる**——
      同じ材料で比べられなくなるので、既定のまま明示する。
    */
    includeContext: "none",
  });

  /*
    **文字以外が返ることがある**（画像・音声）。製品が読めるのは文字だけなので、
    そこは黙って空にせず断る——空の応答として検算へ流すと、
    「AIが何も見つけなかった」と区別が付かない。
  */
  const content = reply.content;
  if (!content || content.type !== "text" || typeof content.text !== "string") {
    throw new McpToolError(
      `呼び出し元が文字以外で答えました（${content?.type ?? "不明"}）。検算できません。`
    );
  }

  return {
    text: content.text,
    model: reply.model,
    truncated: reply.stopReason === "maxTokens",
  };
}

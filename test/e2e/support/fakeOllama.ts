/**
 * 偽の Ollama（画面の自動テストが「AI の答えが出たあとの画面」を見るための口。設計書6.113）。
 *
 * **本物の AI は呼ばない。** 127.0.0.1 の空いている口で小さな HTTP サーバーを立て、
 * Ollama と同じ形（`/api/tags`・`/api/show`・`/api/chat`）で、テストが決めた答えを返す。
 * 作者の画面・作者の Ollama には触れない（行き先は VS Code の設定 `novelai.ollama.endpoint`
 * で一時的に向ける。使い捨ての user-data の中だけ）。
 *
 * 見られるのは「答えが返ったあとの配線と画面」だけで、**答えの出来（見逃し・誤検出）は
 * 見えない**——それは実機の AI での測定（`→〔AIの測定〕`）の仕事。
 *
 * 使い方：
 *   const fake = await startFakeOllama((request) => "答えの文");
 *   withVsCode(..., body, { ...FAKE_OLLAMA_LAUNCH(fake) });
 *   await fake.close();
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "playwright-core";
import type { LaunchOptions } from "./vscodeApp";
import { dialogText, pressDialogButton } from "./workbenchDom";

/** 見本の埋め込みが数える語（話の筋を分ける語）。この語の出方だけでベクトルができる */
const EMBEDDING_WORDS = ["駅", "切符", "駅員", "雨", "改札", "港", "船", "海", "灯台", "漁師", "城", "騎士", "王", "魔法", "市場", "老人", "地図"] as const;

/**
 * 見本の埋め込み。語ごとに1つの次元を持ち、出た回数を数えて長さを1に揃える。
 * 語が1つも出ない文は、全部を同じ向きの小さなベクトルにする（0 のベクトルを避ける）
 */
export function fakeEmbedding(text: string): number[] {
  const counts = EMBEDDING_WORDS.map((word) => text.split(word).length - 1);
  const vector = [...counts, 0.05];
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / length);
}

/** 偽のモデル名（作者のモデルと取り違えない名前にする） */
export const FAKE_OLLAMA_MODEL = "e2e-fake:1b";

export interface FakeOllamaRequest {
  /** system の発言（無ければ空） */
  system: string;
  /** 最後の user の発言 */
  user: string;
  /** `format` に JSON スキーマが渡されたか（構造化出力を求められた呼び出しか） */
  structured: boolean;
  /**
   * 最後の user の発言に添えられた写真の数（`images`。無ければ 0）。
   * 写真の書き起こし（設計書6.117）で、1ページに写真が1枚ずつ届いたかを見るのに使う
   */
  images: number;
  /**
   * 頼みに載っていたモデル名（`/api/chat` の `model`）。
   * 機能ごとの割当（推敲と相談を別のモデルにするなど）で、どのモデルへ送られたかを見張るのに使う
   */
  model: string;
}

export interface FakeOllama {
  /** `http://127.0.0.1:<port>` */
  endpoint: string;
  /** 受けた `/api/chat` の中身（古い順）。何が送られたかを確かめるのに使う */
  requests: FakeOllamaRequest[];
  /**
   * 受けた `/api/embed` の入力（1回の呼び出しごとに、送られた文の並び。古い順）。
   * `/api/chat` の `requests` とは別に数える——索引づくりの件は埋め込みだけを呼ぶので、
   * 同じ並びに混ぜると「AI が呼ばれた」の数え方が件ごとに崩れる
   */
  embedRequests: string[][];
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * 偽の Ollama を立てる。`respond` が `/api/chat` の答え（本文）を返す。
 * 構造化出力を求められた呼び出し（`structured`）には JSON の文字列を返すこと。
 *
 * **答えを約束（Promise）で返してもよい。** 答えが返るまでの画面（考えている間に
 * ボタンが押せなくなるか、など）を見る件は、テストが解くまで答えを止めておける
 * （一瞬で返すと、その間の画面を見る隙が無い）
 */
export async function startFakeOllama(
  respond: (request: FakeOllamaRequest) => string | Promise<string>,
  /** 一覧に足す別のモデル名（モデルを選び替える場面を見るとき）。答え方は同じ */
  options: {
    extraModels?: readonly string[];
    /**
     * 申告する大きさ（`parameter_size`）。既定は "1B"。製品が頼み方を大きいモデル向けに
     * 切り替える場面（20B 以上）を見るときに "25.2B" などを渡す
     */
    parameterSize?: string;
    /**
     * 埋め込み（`/api/embed`）に答える**前に**呼ぶ門。約束を返せば、解けるまで答えを止める。
     *
     * 索引づくりの「途中で中止」（実機確認リスト 64）を作るのに使う：止めている間に
     * ステータスバーの［中止］を押し、押したあとで門を開ける。一瞬で返すと、中止を押す隙が無い
     */
    beforeEmbed?: (inputs: readonly string[]) => void | Promise<void>;
    /**
     * `/api/show` が申告する読める長さ（トークン）。既定は 32,768。
     *
     * 申告より短いところで頭打ちになるモデル（実機確認リスト 309、J3）を作るときに、
     * 下の `promptTokens` の頭打ちと組で渡す
     */
    contextLength?: number;
    /**
     * `/api/chat` が答える入力トークン数（`prompt_eval_count`）の決め方。省くと今までどおり 10 に固定。
     *
     * 渡すと「送った字数（全発言の字数の合計）× `perChar` を切り上げ、`cap` で頭打ち」にする。
     * 製品は読める長さを**入力トークン数の伸びが止まるところ**で測る（`core/contextProbe.ts`）ので、
     * `cap` が偽のモデルの「本当に読める長さ」になる。製品の「桁違い」の線（1字4トークン）を
     * 超えないよう、`perChar` は 1 前後にする
     */
    promptTokens?: { perChar: number; cap: number };
    /**
     * `/api/tags`・`/api/show` が申告する `capabilities`。既定は `["completion"]`（文字だけのモデル）。
     *
     * 写真の書き起こし（設計書6.117）を見る件は `["completion", "vision"]` を渡す。製品は
     * `vision` の申告で「写真を読める」と決める（`ai/ollamaProvider.ts`・`ai/imageInput.ts`）ので、
     * 無いと［書き起こす］が押せず、向きも尋ねない
     */
    capabilities?: readonly string[];
  } = {}
): Promise<FakeOllama> {
  const requests: FakeOllamaRequest[] = [];
  const embedRequests: string[][] = [];
  const capabilities = options.capabilities ?? ["completion"];
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? "/";
      const sendJson = (value: unknown): void => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (url.startsWith("/api/tags")) {
        sendJson({
          models: [FAKE_OLLAMA_MODEL, ...(options.extraModels ?? [])].map((name) => ({
            name,
            size: 1_000_000,
            details: { parameter_size: options.parameterSize ?? "1B", quantization_level: "Q4_0" },
            capabilities: [...capabilities],
          })),
        });
        return;
      }
      if (url.startsWith("/api/embed")) {
        // 埋め込み（検索索引・似た場面の検出が使う）。**決まった語の出方で作る見本のベクトル**で、
        // 同じ語の出る文どうしは近く、出ない文とは遠い。本物の埋め込みの出来は見えない
        const body = JSON.parse(await readBody(request)) as { input?: string[] | string };
        const inputs = Array.isArray(body.input) ? body.input : [String(body.input ?? "")];
        embedRequests.push(inputs);
        await options.beforeEmbed?.(inputs);
        sendJson({ model: FAKE_OLLAMA_MODEL, embeddings: inputs.map((text) => fakeEmbedding(text)) });
        return;
      }
      if (url.startsWith("/api/show")) {
        sendJson({
          capabilities: [...capabilities],
          details: { parameter_size: options.parameterSize ?? "1B" },
          // 製品は `.context_length` で終わる鍵を読む（`ai/ollamaProvider.ts`）
          model_info: { "fake.context_length": options.contextLength ?? 32768 },
        });
        return;
      }
      if (url.startsWith("/api/chat")) {
        const body = JSON.parse(await readBody(request)) as {
          messages?: Array<{ role: string; content: string; images?: string[] }>;
          stream?: boolean;
          format?: unknown;
          model?: string;
        };
        const messages = body.messages ?? [];
        const system = messages.find((message) => message.role === "system")?.content ?? "";
        const lastUser = [...messages].reverse().find((message) => message.role === "user");
        const user = lastUser?.content ?? "";
        const parsed: FakeOllamaRequest = {
          system,
          user,
          structured: body.format !== undefined,
          images: lastUser?.images?.length ?? 0,
          model: body.model ?? "",
        };
        requests.push(parsed);
        const text = await respond(parsed);
        // 製品が数える送った字数は system＋user の字数の合計（`measureContext.ts` の `promptChars`）。
        // 全発言を足せば同じ数になる（JS の length どうしで数える）
        const sentChars = messages.reduce((sum, message) => sum + (message.content ?? "").length, 0);
        const promptEvalCount =
          options.promptTokens === undefined
            ? 10
            : Math.min(Math.ceil(sentChars * options.promptTokens.perChar), options.promptTokens.cap);
        const tail = { model: FAKE_OLLAMA_MODEL, done: true, done_reason: "stop", prompt_eval_count: promptEvalCount, eval_count: 10 };
        if (body.stream === true) {
          response.writeHead(200, { "content-type": "application/x-ndjson" });
          response.write(JSON.stringify({ model: FAKE_OLLAMA_MODEL, message: { role: "assistant", content: text }, done: false }) + "\n");
          response.end(JSON.stringify({ ...tail, message: { role: "assistant", content: "" } }) + "\n");
        } else {
          sendJson({ ...tail, message: { role: "assistant", content: text } });
        }
        return;
      }
      // 版の問い合わせ・生存確認など、そのほかは「動いている」とだけ答える
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("Ollama is running");
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    requests,
    embedRequests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * 「手元のAIへ送る前に確かめてください」の確認が出ていれば［このまま送る］で進める。
 *
 * **これは製品の関所（`features/localAiGate.ts`）で、この機械の GPU の使用率が高いと
 * 実際に出る**（2026-10-09、別の用で GPU が 98% のとき相談の送信で出た）。偽の Ollama でも
 * 手元のAI扱いなので同じ関所を通る。出る・出ないは機械の状態しだいなので、
 * 待つ側（`waitUntil` の条件の中）から呼んで、出ていたら通す。出ていなければ何もしない
 */
export async function passLocalAiGate(page: Page): Promise<void> {
  const text = await dialogText(page);
  if (text === undefined || !text.includes("手元のAIへ送る前に確かめてください")) return;
  await pressDialogButton(page, "このまま送る").catch(() => undefined);
}

/** 偽の Ollama を使う件が `withVsCode` の起こし方へ足すもの（AI の選択と行き先） */
export function fakeOllamaLaunch(fake: FakeOllama, extra: LaunchOptions = {}): LaunchOptions {
  return {
    ...extra,
    globalState: {
      "novelai.ai.provider": "ollama",
      "novelai.ai.model": FAKE_OLLAMA_MODEL,
      ...extra.globalState,
    },
    settings: {
      "novelai.ollama.endpoint": fake.endpoint,
      ...extra.settings,
    },
  };
}

/**
 * 受けた頼みの並び（落ちた文に添える用）。順番・構造化出力か・system と user の頭（各80字、改行は ⏎）。
 *
 * 「AI が呼ばれた／呼ばれない」「何が送られた」で落ちたとき、件数だけでは、同じファイルの前の件の頼みが
 * 残っていたのか、製品が本当に呼んだのか、場面探しの検索語づくり（P-22）が先に走ったのかを分けられない
 * （2026-10-12 ノートPC の plotModeAiEntrances・chatLocateAndMain）。`from` より前は「前の件の分」として数えない
 */
export function describeFakeRequests(requests: readonly FakeOllamaRequest[], from = 0): string {
  const head = (text: string): string => text.replace(/\r?\n/g, "⏎").slice(0, 80);
  const lines = requests.map(
    (request, index) =>
      `#${index + 1}${index < from ? "（前の件）" : ""}${request.structured ? "（構造化）" : ""} モデル「${request.model}」 system「${head(request.system)}」 user「${head(request.user)}」`
  );
  return `偽のAIへの頼み：この件で${requests.length - from}件・全体で${requests.length}件：${lines.length > 0 ? lines.join(" ／ ") : "なし"}`;
}

import { z } from "zod";
import { bundledTuningByKey, type BundledTuning } from "../../core/bundledTuning";
import {
  applyStreamLine,
  emptyStreamedChat,
  takeCompleteLines,
} from "../../ai/ollamaStream";
import { localFetch } from "../../ai/fetchTimeouts";
import { McpToolError, describeError } from "./shared";

/**
 * 手元の Ollama へ投げる（設計書6.87.8 の4）／何が入っているかを見る
 * （6.87.15 の柱2の2）。
 *
 * **`num_ctx` を必ず明示する**（CLAUDE.md 規則6）。指定しないと既定の短い
 * コンテキストで動き、**入力が黙って切り捨てられる。** 128k対応のモデルでも
 * 同じで、切り捨てられたことは応答からは分からない。
 *
 * **`temperature` も必ず明示する**（2026-09-19）。ここに既定（0.2）を置いて
 * いたせいで、**製品が 0.0 で回している誤字脱字を、0.2 で測っていた。**
 * 製品の値は `prompts/*.ts` の `*_TEMPERATURE` にあり、`novel.run` は
 * そこから渡す——この道具は素の口なので、呼ぶ側が決める。
 *
 * **`format` にスキーマを渡す**と形式が強制でき、パース失敗がほぼ無くなる。
 * **`think: false`** は、取り出すだけの仕事に思考モードが要らないため。
 *
 * **宛先が手元でなければ断る**（6.87.6 の2）。原稿が機械の外へ出るのは、
 * 作者が `allowRemote` で明示したときだけにする。
 *
 * **ただし `ollama.models` に `allowRemote` は要らない。** 何が入っているかを
 * 読むだけで、**作者の原稿は1文字も送らない**——送るものが無いのだから、
 * 作者に「外へ出してよいか」を問う筋が無い。
 */

export const DEFAULT_ENDPOINT = "http://localhost:11434";

/**
 * この道具が Ollama の応答を待つ上限（30分）。
 *
 * この道具は自分で打ち切る仕組みを持たない（止めるのは呼ぶ側）。
 * それでも Node の通信部品は既定300秒で勝手に諦めるので、そこだけは
 * **製品で作者が選びうる長さ（台帳で1800秒の実例がある）より短くしない。**
 * 無期限にしないのは、落ちた Ollama を永久に待たないため。
 */
export const MCP_OLLAMA_WAIT_MS = 30 * 60 * 1000;

/** 手元とみなす宛先。ここ以外は `allowRemote` が要る */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const OLLAMA_GENERATE_INPUT = {
  endpoint: z
    .string()
    .optional()
    .describe(`Ollama の場所。既定は ${DEFAULT_ENDPOINT}`),
  model: z.string().describe("モデル名（`ollama list` で出るもの）"),
  systemPrompt: z.string().describe("システムプロンプト"),
  userPrompt: z.string().describe("本文を含むプロンプト"),
  schema: z
    .unknown()
    .optional()
    .describe("応答のJSONスキーマ。渡すと形式が強制される（format）"),
  numCtx: z
    .number()
    .int()
    .positive()
    .describe("num_ctx。**省略できません**（既定値で動くと入力が黙って切れます）"),
  temperature: z
    .number()
    .describe(
      "温度。**省略できません**" +
        "（製品の機能を回すなら novel.run を使ってください。あちらは機能ごとの温度を自分で渡します）"
    ),
  allowRemote: z
    .boolean()
    .optional()
    .describe("手元以外の宛先へ本文を送ることを明示的に許す"),
};

export interface OllamaGenerateInput {
  endpoint?: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  schema?: unknown;
  numCtx: number;
  /**
   * 温度。**省略できない**（2026-09-19）。
   *
   * 0.66 までは既定 0.2 を噛ませていたが、**製品は機能ごとに違う値を渡して
   * いる**（誤字脱字は 0.0）。ここに既定があると、`novel.run` が渡し忘れても
   * 動いてしまい、**製品より揺れた条件で測ったことに誰も気づけない**
   * ——実際 2026-09-18 の誤字脱字と推敲の測定がその状態だった。
   */
  temperature: number;
  allowRemote?: boolean;
}

/**
 * 宛先が手元か確かめる。
 *
 * **「手元でない」ときに止めるのであって、「外部だ」と当てにいくのではない。**
 * 読み取れない宛先も手元とはみなさない（安全側）。
 */
export function assertLocalOrAllowed(endpoint: string, allowRemote?: boolean) {
  if (allowRemote === true) return;
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    throw new McpToolError(`Ollama の場所を読み取れません: ${endpoint}`);
  }
  if (LOCAL_HOSTS.has(host)) return;
  throw new McpToolError(
    `${endpoint} は手元ではありません。本文をそこへ送ってよければ allowRemote: true を付けてください` +
      "（手元の Ollama へ投げるかぎり、原稿はこの機械から出ません）"
  );
}

export interface OllamaGenerateResult {
  /** 応答の本文（スキーマを渡していればJSONの文字列） */
  text: string;
  model: string;
  endpoint: string;
  /** 何ミリ秒かかったか。遅いモデルを見分けるため */
  elapsedMs: number;
}

export async function ollamaGenerate(
  input: OllamaGenerateInput
): Promise<OllamaGenerateResult> {
  const endpoint = (input.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  assertLocalOrAllowed(endpoint, input.allowRemote);

  const startedAt = Date.now();
  let response: Response;
  try {
    /*
      **Node の待ち時間（既定300秒）をこちらへ揃える**（設計書6.63。2026-09-23）。

      下の注記のとおり流す形にしたが、それで避けられるのは「生成の間」だけで
      ある。Ollama は**本文を読み終えて1字目を出すまで**応答の頭を返さないので、
      CPUだけの機械で長い本文を読むと、流していても300秒で切られる。

      **手元の口（`localFetch`）で投げる**のは製品と揃えるため。この道具は
      MCPサーバー（素の Node）で動くので VS Code の差し替えは無いが、
      渡し方を2通りに書き分けない（`fetchTimeouts.ts`）。
    */
    response = await localFetch(`${endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        /*
          **流しながら受け取る**（設計書6.63.1。0.67.2 でここも揃えた）。

          `stream: false` だと、**応答ヘッダーは生成が全部終わってから届く**。
          Node の通信部品は「ヘッダーを待つ上限」を既定300秒で持っているので、
          生成が300秒を超えると**こちらが待つ前に切られる**——しかも
          `fetch failed` としか分からないので、**「Ollama へ繋がりませんでした」
          と出る**（2026-09-18、事実の照合を測ろうとして5件すべてがこれで落ちた。
          25分待って0件という記録が残った）。

          流す形ならヘッダーは即座に届くので、この上限に当たらない。
          組み立ては製品と同じ部品（`ai/ollamaStream.ts`）を通すので、
          呼ぶ側から見た形は `stream: false` のときと変わらない。
        */
        stream: true,
        // 抽出の仕事に思考モードは要らない（遅くなるだけ）
        think: false,
        ...(input.schema === undefined ? {} : { format: input.schema }),
        options: {
          // **これを外さない。** 既定の短いコンテキストで動くと、
          // 入力が黙って切り捨てられる
          num_ctx: input.numCtx,
          // **既定を持たない**（上の `temperature` の注記）。製品の値は
          // `prompts/*.ts` にあり、呼ぶ側がそこから渡す
          temperature: input.temperature,
        },
        messages: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.userPrompt },
        ],
      }),
    }, MCP_OLLAMA_WAIT_MS);
  } catch (error) {
    throw new McpToolError(
      `Ollama へ繋がりませんでした（${endpoint}）: ${describeError(error)}`
    );
  }

  if (!response.ok) {
    // **本文を捨てない**（CLAUDE.md 規則5）。原因はここにしか書かれていない
    const detail = await response.text().catch(() => "");
    throw new McpToolError(
      `Ollama がエラーを返しました（HTTP ${response.status}）: ${detail.slice(0, 500)}`
    );
  }

  const streamed = await readStream(response);
  // **Ollama が返したエラー文を捨てない**（CLAUDE.md 規則5）。
  // 流す形では HTTP 200 のまま本文の中で失敗を知らせてくることがある
  if (streamed.error) {
    throw new McpToolError(`Ollama がエラーを返しました: ${streamed.error}`);
  }
  if (!streamed.content) {
    throw new McpToolError("Ollama の応答に本文がありません。");
  }

  return {
    text: streamed.content,
    model: input.model,
    endpoint,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * NDJSON を1行ずつ取り込む。
 *
 * **行の途中で切れて届く**ので、改行までを溜めてから解く。ここを手を抜くと、
 * 日本語が半分に割れた行で JSON の解析に失敗する（`ai/ollamaStream.ts`）。
 */
async function readStream(
  response: Response
): Promise<ReturnType<typeof emptyStreamedChat>> {
  const result = emptyStreamedChat();
  const reader = response.body?.getReader();
  if (!reader) throw new McpToolError("Ollama の応答を読み取れません。");

  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // **多バイト文字の途中で切れた断片を持ち越す**（`{ stream: true }`）
      buffer += decoder.decode(value, { stream: true });
      const taken = takeCompleteLines(buffer);
      buffer = taken.rest;
      for (const line of taken.lines) applyStreamLine(result, line);
    }
  } catch (error) {
    throw new McpToolError(
      `Ollama の応答が途中で切れました: ${describeError(error)}`
    );
  }
  // 最後の行に改行が付かないことがある
  buffer += decoder.decode();
  applyStreamLine(result, buffer);
  return result;
}

/* ── 手元に何が入っているか（設計書6.87.15 の柱2の2）───────────── */

export const OLLAMA_MODELS_INPUT = {
  endpoint: z
    .string()
    .optional()
    .describe(`Ollama の場所。既定は ${DEFAULT_ENDPOINT}`),
};

export interface OllamaModelsInput {
  endpoint?: string;
}

export interface OllamaModelSummary {
  /** `run` の `model` へそのまま渡せる名前 */
  name: string;
  sizeBytes: number | null;
  parameterSize: string | null;
  family: string | null;
  quantization: string | null;
  modifiedAt: string | null;
  /** そのモデルが申告する読める長さ（トークン）。取れなければ null */
  contextLength: number | null;
  /** `completion` が無ければ、文章を書かせても返らない（埋め込み用など） */
  capabilities: string[];
  /** 同梱の実測（`core/bundledTuning.ts`）。無ければ null */
  bundled: BundledTuning | null;
}

export interface OllamaModelsResult {
  endpoint: string;
  models: OllamaModelSummary[];
  /** 詳細を取れなかったモデル。**1つの失敗で全体を止めない** */
  failures: Array<{ model: string; reason: string }>;
  note: string;
}

interface TagsEntry {
  name?: unknown;
  size?: unknown;
  modified_at?: unknown;
  details?: {
    family?: unknown;
    parameter_size?: unknown;
    quantization_level?: unknown;
  };
}

interface ShowDetail {
  contextLength: number | null;
  capabilities: string[];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * `/api/show` から読める長さと対応機能を取る。
 *
 * **`ollamaProvider.ts` の同じ読み取りは借りられない**——あちらは `vscode` を
 * 静的に import しているので、この束へ持ち込むと**読み込んだ瞬間に落ちる**
 * （`test/unit/mcpReach.test.ts` が見張っている）。純粋な部分だけを切り出す
 * にはあのファイルを割る必要があり、それは今回の範囲を越えるので、
 * ここでは小さく書いた。
 */
async function showModel(endpoint: string, model: string): Promise<ShowDetail> {
  let response: Response;
  try {
    response = await fetch(`${endpoint}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
  } catch (error) {
    throw new McpToolError(describeError(error));
  }
  if (!response.ok) {
    // **本文を捨てない**（CLAUDE.md 規則5）
    const detail = await response.text().catch(() => "");
    throw new McpToolError(`HTTP ${response.status}: ${detail.slice(0, 200)}`);
  }

  const payload = (await response.json()) as {
    capabilities?: unknown;
    model_info?: Record<string, unknown>;
  };
  const info = payload.model_info ?? {};

  /*
    読める長さの鍵は `<アーキテクチャ>.context_length`（`gemma4.context_length`）
    である。**アーキ名はモデルごとに違う**ので、まず `general.architecture` を
    読んで組み立てる。取れなければ末尾一致で拾う——古い版の Ollama は
    `general.architecture` を返さないことがあり、そこで諦めると
    「読める長さが分からない」に倒れる（製品の `showModel` も末尾一致で拾う）。
  */
  let contextLength: number | null = null;
  const architecture = info["general.architecture"];
  if (typeof architecture === "string") {
    const value = info[`${architecture}.context_length`];
    if (typeof value === "number") contextLength = value;
  }
  if (contextLength === null) {
    for (const [key, value] of Object.entries(info)) {
      if (key.endsWith(".context_length") && typeof value === "number") {
        contextLength = value;
        break;
      }
    }
  }

  const capabilities = Array.isArray(payload.capabilities)
    ? payload.capabilities.filter(
        (item): item is string => typeof item === "string"
      )
    : [];

  return { contextLength, capabilities };
}

const MODELS_NOTE = [
  "読める長さの台帳（作者の実測。もとの設定名は `novelai.modelTuning`、0.66.6 からは拡張機能の保管庫のファイル）は、この束からは読めません。ここに出る実測は同梱の値（bundled）だけです。",
  "`capabilities` に `completion` が無いモデル（埋め込み用など）は `run` に使えません。",
  "`numCtx` は `contextLength` 以下にしてください。実際に VRAM へ載る範囲は、測るまで分かりません。",
].join("\n");

/**
 * 手元の Ollama に入っているモデルを返す。
 *
 * **モデル名を同梱の一覧から当てにいかない**（CLAUDE.md 規則6）。
 * `/api/tags` と `/api/show` が言うことだけを返し、同梱の実測は
 * `bundled` として**出どころが分かる形**で添える。
 */
export async function ollamaModels(
  input: OllamaModelsInput
): Promise<OllamaModelsResult> {
  const endpoint = (input.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");

  let response: Response;
  try {
    response = await fetch(`${endpoint}/api/tags`);
  } catch (error) {
    throw new McpToolError(
      `Ollama へ繋がりませんでした（${endpoint}）: ${describeError(error)}`
    );
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new McpToolError(
      `Ollama がエラーを返しました（HTTP ${response.status}）: ${detail.slice(0, 500)}`
    );
  }

  const payload = (await response.json()) as { models?: unknown };
  const entries: TagsEntry[] = Array.isArray(payload.models)
    ? (payload.models as TagsEntry[])
    : [];

  /*
    **並行で問い合わせる。** モデルが10個あれば `/api/show` も10回で、
    順に待つと一覧を出すだけで何秒もかかる。
    **1つの失敗で全体を止めない**（チャンク単位の失敗と同じ作法）
    ——詳細が取れなくても、名前だけは返せば `run` には使える。
  */
  const gathered = await Promise.all(
    entries.map(async (entry) => {
      const name = stringOrNull(entry?.name);
      if (!name) return null;

      let detail: ShowDetail = { contextLength: null, capabilities: [] };
      let failure: { model: string; reason: string } | null = null;
      try {
        detail = await showModel(endpoint, name);
      } catch (error) {
        failure = { model: name, reason: describeError(error) };
      }

      const summary: OllamaModelSummary = {
        name,
        sizeBytes: typeof entry.size === "number" ? entry.size : null,
        parameterSize: stringOrNull(entry.details?.parameter_size),
        family: stringOrNull(entry.details?.family),
        quantization: stringOrNull(entry.details?.quantization_level),
        modifiedAt: stringOrNull(entry.modified_at),
        contextLength: detail.contextLength,
        capabilities: detail.capabilities,
        bundled: bundledTuningByKey(`ollama/${name}`) ?? null,
      };
      return { summary, failure };
    })
  );

  const models: OllamaModelSummary[] = [];
  const failures: Array<{ model: string; reason: string }> = [];
  for (const item of gathered) {
    if (!item) continue;
    models.push(item.summary);
    if (item.failure) failures.push(item.failure);
  }

  return { endpoint, models, failures, note: MODELS_NOTE };
}

import { z } from "zod";
import { McpToolError, describeError } from "./shared";
import { askSampling } from "./sampling";

/**
 * `run` ツールの返し方（設計書6.87.8 の5・6）。
 *
 * **`runner` に既定を作らない。** `ollama` なら原稿はこの機械から出ないが、
 * `claude` は本文が Anthropic へ渡る。どちらも一長一短で、選ぶのは作者である。
 *
 * **`ollama` のときは検算まで通した結果しか返さない。** プロンプトだけ呼んで
 * `validate` を通さない使い方は、**製品に無い不具合を見つけたことになる**
 * （CLAUDE.md の「繰り返し起きた失敗」5番）。
 */

/**
 * 本文の行き先（設計書6.87.8 の5、6.87.12）。
 *
 * **ここが唯一の定義。** 道具ごとに書くと、選択肢を増やしたときに
 * **直し漏れた道具だけが古い顔ぶれのまま**になる（実際、`sampling` を
 * 足したときに8か所を直すことになった）。入力の形（`RUNNER_INPUT`）と
 * 突き合わせるテストが `mcpRunner.test.ts` にある。
 */
export type RunnerKind = "ollama" | "claude" | "sampling";

/** 選べる行き先。**入力の形（`RUNNER_INPUT`）と突き合わせる** */
export const RUNNER_KINDS: readonly RunnerKind[] = [
  "ollama",
  "claude",
  "sampling",
];

/**
 * 行き先が指定されているか確かめる。
 *
 * **既定で埋めない**（設計書6.87.8 の5）。手元へ投げるのと、本文を
 * 呼び出し元やAnthropicへ渡すのとでは、**作者にとっての意味がまるで違う**。
 *
 * **断り文句もここに1つだけ置く。** 道具ごとに書くと、選択肢を増やしたときに
 * 古い顔ぶれを案内し続ける道具が残る（`sampling` を足したときに実際、
 * 8か所が「ollama か claude で指定してください」と言ったままになった）。
 */
export function assertRunner(runner: unknown): asserts runner is RunnerKind {
  if (RUNNER_KINDS.includes(runner as RunnerKind)) return;
  throw new McpToolError(
    "runner を指定してください（既定はありません）。" +
      "ollama＝手元のOllamaで検算まで通す（原稿は外へ出ない）／" +
      "claude＝プロンプトだけ返す（読んだ応答を validate へ戻す）／" +
      "sampling＝呼び出し元に考えてもらい、検算まで通す。"
  );
}

/** `validate` へ戻してもらうときの決まり文句。ツールの説明にも出す */
export const VALIDATE_NOTE =
  "検算（validate）を通していない結果は、製品の結果ではありません。";

export function claudeNote(validateWith: string): string {
  return `プロンプトだけを返しました。AIの応答は ${validateWith} へ戻してください。${VALIDATE_NOTE}`;
}

/** `validate` に渡す応答。**文字列のまま受ける**（製品の解析器へ通すため） */
export function responseInput() {
  return z
    .string()
    .describe(`AIの応答（JSONの文字列）。${VALIDATE_NOTE}`);
}

export function chunkIdInput() {
  return z
    .string()
    .describe("`prompt` か `run` が返した chunkId。そのまま渡してください");
}

export interface ClaudeRunResult<P> {
  runner: "claude";
  note: string;
  systemPrompt: string;
  schema: unknown;
  validateWith: string;
  chunks: P[];
}

export interface OllamaRunResult<R> {
  runner: "ollama";
  note: string;
  model: string;
  results: R[];
  /** 失敗したチャンク。**黙って飛ばさない**（件数だけでは何も分からない） */
  failures: Array<{ chunkId: string; reason: string }>;
}

/**
 * 呼び出し元に考えてもらった結果（設計書6.87.12）。
 *
 * **`ollama` と同じ形にする。** どちらも「検算まで通した結果だけを返す」
 * 道なので、受け取る側が分岐せずに読めるほうがよい。違うのは
 * **モデルをこちらで選べない**ことで、`model` は**答えた側の申告**である。
 */
export interface SamplingRunResult<R> {
  runner: "sampling";
  note: string;
  /** 答えたモデル（呼び出し元が選ぶ）。**こちらでは指定できない** */
  model: string;
  results: R[];
  failures: Array<{ chunkId: string; reason: string }>;
}

export type RunOutcome<P, R> =
  | ClaudeRunResult<P>
  | OllamaRunResult<R>
  | SamplingRunResult<R>;

/** 行き先と、その行き先に要る指定 */
export interface RunnerContext {
  runner: RunnerKind;
  /**
   * どの作品か。**考えさせる許可を確かめるために要る**（設計書6.87.12）。
   * 道具の入力にはもともと入っているので、そのまま渡せば足りる。
   */
  folder?: string;
  /** 手元の Ollama の宛先 */
  endpoint?: string;
  /** `ollama` のときだけ要る */
  model?: string;
  allowRemote?: boolean;
  /**
   * 読み込む長さ。**呼ぶ側が決める**（CLAUDE.md 規則6「`num_ctx` を必ず
   * 明示する」）。道具によって既定が違う（表記ゆれは 8192）ので、
   * ここで埋めない——埋めると、**指定したつもりの値が黙って置き換わる**。
   */
  numCtx: number;
}

/** `run` が組み立てたプロンプト一式 */
export interface RunnerPrompts<P> {
  systemPrompt: string;
  schema: unknown;
  chunks: P[];
}

/**
 * 行き先に応じて回す（設計書6.87.8 の5、6.87.12）。
 *
 * **8つの道具が同じ分岐を書いていたので、1つにまとめた。** 写しのままだと、
 * **行き先を1つ足すたびに8か所を直す**ことになる——実際 `sampling` を
 * 足したとき、直し漏れた道具だけが「ollama か claude で指定してください」と
 * 言い続ける形になりかけた。
 *
 * **検算は呼ぶ側から渡してもらう**（`validate`）。道具ごとに材料が違う
 * （辞書・作法・プロット）ので、ここでは持てない。**ただし通す場所は
 * ここに固定する**——`ollama` と `sampling` は、**必ず検算まで通した結果
 * しか返さない**（6.87.6 の3）。
 */
export async function runByRunner<
  P extends { chunkId: string; userPrompt: string },
  R,
>(
  context: RunnerContext,
  prompts: RunnerPrompts<P>,
  validateWith: string,
  validate: (chunkId: string, responseText: string) => R,
  ask: (params: {
    endpoint?: string;
    model: string;
    systemPrompt: string;
    userPrompt: string;
    schema: unknown;
    numCtx: number;
    allowRemote?: boolean;
  }) => Promise<{ text: string }>
): Promise<RunOutcome<P, R>> {
  // **省略を既定で埋めない。** 行き先で作者にとっての意味がまるで違う
  assertRunner(context.runner);

  if (context.runner === "claude") {
    return {
      runner: "claude",
      note: claudeNote(validateWith),
      systemPrompt: prompts.systemPrompt,
      schema: prompts.schema,
      validateWith,
      chunks: prompts.chunks,
    };
  }

  if (context.runner === "sampling") {
    return runChunksBySampling(prompts.chunks, async (item) => {
      const reply = await askSampling({
        folder: context.folder,
        systemPrompt: prompts.systemPrompt,
        userPrompt: item.userPrompt,
      });
      return {
        model: reply.model,
        result: validate(item.chunkId, reply.text),
      };
    });
  }

  const model = context.model;
  if (!model) {
    throw new McpToolError("runner が ollama のときは model が要ります。");
  }
  return runChunks(model, prompts.chunks, async (item) => {
    const response = await ask({
      endpoint: context.endpoint,
      model,
      systemPrompt: prompts.systemPrompt,
      userPrompt: item.userPrompt,
      schema: prompts.schema,
      numCtx: context.numCtx,
      allowRemote: context.allowRemote,
    });
    return validate(item.chunkId, response.text);
  });
}

/**
 * チャンクごとに回す。
 *
 * **1つ失敗しても全体を止めない**（CLAUDE.md の実装スタイル）。理由を
 * 残して次へ進み、最後にまとめて返す。
 */
export async function runChunks<P extends { chunkId: string }, R>(
  model: string,
  items: readonly P[],
  ask: (item: P) => Promise<R>
): Promise<OllamaRunResult<R>> {
  const results: R[] = [];
  const failures: Array<{ chunkId: string; reason: string }> = [];
  for (const item of items) {
    try {
      results.push(await ask(item));
    } catch (error) {
      failures.push({ chunkId: item.chunkId, reason: describeError(error) });
    }
  }
  return {
    runner: "ollama",
    note: `手元の Ollama で検算まで通しました（原稿はこの機械から出ていません）。${VALIDATE_NOTE}`,
    model,
    results,
    failures,
  };
}

/**
 * 呼び出し元に考えてもらいながら、チャンクごとに回す（設計書6.87.12）。
 *
 * **`runChunks` と同じ守り方**——1つ失敗しても止めず、理由を残して次へ進む。
 * 違うのは**モデルをこちらで選べない**ことで、答えた側の申告を集めて返す。
 *
 * **検算を迂回できないのが、この道の値打ちである。** `claude` の道は
 * `prompt` だけ呼んで `validate` を通さない使い方ができてしまうが、
 * ここは呼ぶ・受け取る・検算するが1つの流れに閉じている。
 */
export async function runChunksBySampling<
  P extends { chunkId: string },
  R,
>(
  items: readonly P[],
  ask: (item: P) => Promise<{ result: R; model: string }>
): Promise<SamplingRunResult<R>> {
  const results: R[] = [];
  const failures: Array<{ chunkId: string; reason: string }> = [];
  const models = new Set<string>();
  for (const item of items) {
    try {
      const answered = await ask(item);
      results.push(answered.result);
      models.add(answered.model);
    } catch (error) {
      failures.push({ chunkId: item.chunkId, reason: describeError(error) });
    }
  }
  return {
    runner: "sampling",
    /*
      **どのAIが答えたかを、こちらでは選べない。** 呼び出し元が決めるので、
      申告された名前をそのまま返す（複数あれば並べる）。
      **原稿の行き先も約束できない**ので、そこも断る。
    */
    note:
      "呼び出し元に考えてもらい、検算まで通しました" +
      "（本文は呼び出し元へ渡っており、その先は呼び出し元の設定によります）。" +
      VALIDATE_NOTE,
    model: models.size > 0 ? [...models].join(" / ") : "（不明）",
    results,
    failures,
  };
}

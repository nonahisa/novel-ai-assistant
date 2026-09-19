import { z } from "zod";
import { McpToolError, describeError } from "./shared";
import { askSampling } from "./sampling";
import { ollamaGenerate } from "./ollama";
import { openChunkCache } from "./chunkCacheFile";
import type { CacheKeyBase } from "../../core/chunkCacheStore";

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

/**
 * 応答をどこへ戻すか（0.66.7、設計書6.87.15 の柱1）。
 *
 * **道具が束ねられたので、戻し先は `novel.validate` の1つだけ**になった。
 * ただ「novel.validate へ」と言うだけでは、**どの feature で戻すのかが
 * 抜ける**——feature を取り違えると、別の検算に掛かる。
 *
 * **組み立てはここ1か所。** 道具ごとに書き写すと、名前を変えたときに
 * 直し漏れた機能だけが「もう無い道具」を案内し続ける（0.66.6 まで
 * 実際に `typo.validate` のような名前を14か所が書いていた）。
 */
export function validateWith(feature: string): string {
  return `novel.validate（feature: ${feature}）`;
}

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
  /** 製品と同じ条件で投げてもらうための温度（`prompts/*.ts` の値） */
  temperature: number;
  validateWith: string;
  chunks: P[];
}

export interface OllamaRunResult<R> {
  runner: "ollama";
  note: string;
  model: string;
  /**
   * 実際に送った温度（2026-09-19）。
   *
   * **`num_ctx` と同じ扱いにする。** 何で測ったのかが結果に残っていないと、
   * あとから数字を並べても比べられない——0.66 までは既定の 0.2 で回って
   * おり、**誤字脱字（製品は 0.0）を製品より揺れた条件で測っていた**のに、
   * 記録からはそれが読めなかった。
   */
  temperature: number;
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
  /**
   * **頼んだ**温度。`ollama` と違い「送った値」とは言い切れない
   * ——仕様では任意の指定で、呼び出し元が無視することもある。
   * それでも残すのは、**何を頼んで測ったのかが分からなくなるほうが困る**ため。
   */
  temperature: number;
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
  /**
   * 温度を明示して測りたいとき（2026-09-19）。
   *
   * **省略すれば製品と同じ値になる**（`RunnerPrompts.temperature`）。
   * ここを埋めるのは「揺らして測る」ためだけで、**埋めた回は製品の
   * 条件ではない**——記録にもその旨が残るようにしてある。
   */
  temperature?: number;
}

/**
 * どこへ貯めるか（作者の裁定 2026-09-19「読み書き両方使う」、設計書6.87.17）。
 *
 * **拡張機能とまったく同じ鍵で読み書きする。** 鍵がずれると、拡張機能が
 * 貯めたぶんを外部AIが使えない（逆も同じ）——同じ本文を同じモデルへ二度
 * 送ることになり、実装ルール4（処理量を節約する）に反する。
 *
 * **渡すのは道具ごとに違うところだけ。** feature 名と版は製品（`features/*.ts`）
 * の `cacheKeyBase` と揃える。**製品の鍵に材料の指紋や台帳の指紋が混ざって
 * いる機能は、ここを渡さない**（矛盾検知・伏線の回収判定）——こちらでは
 * 同じ指紋を組み立てていないので、渡すと「当たらない鍵」を貯めるだけになる。
 */
export interface RunChunkCache {
  /** 作品フォルダー（`.aiwriter/cache/chunks.json` の置き場所） */
  folder: string;
  /** 製品と同じ feature 名（`features/checkTypos.ts` なら `typo_check`） */
  feature: string;
  /** 製品と同じプロンプト版（`prompts/*.ts` の `_VERSION`） */
  promptVersion: string;
  /** chunkId から、そのチャンクの内容ハッシュを引く（鍵の一部） */
  hashOf: (chunkId: string) => string;
  /**
   * 応答を、**製品がキャッシュへ入れるのと同じ形**へ変える。
   *
   * 製品が入れているのは生の応答ではなく、読み取ったあとの形
   * （`parseTypoCheckResult` などの返り値）である。ここで生の文字列を
   * 入れると、拡張機能が当てたときに別の形が返って壊れる。
   */
  parse: (responseText: string) => unknown;
}

/** キャッシュの鍵に入れるプロバイダID。`runner: ollama` は手元のOllama */
const OLLAMA_PROVIDER_ID = "ollama";

/** `run` が組み立てたプロンプト一式 */
export interface RunnerPrompts<P> {
  systemPrompt: string;
  schema: unknown;
  /**
   * 製品がそのプロンプトで使う温度（2026-09-19）。
   *
   * **写しを持たない。** 値は `prompts/*.ts` の `*_TEMPERATURE` にあり、
   * 製品（`features/*.ts`）も測定台（ここ）も同じ定数を見る——ここへ
   * 数字を書き並べると、**片方だけ直す日が来る。**
   */
  temperature: number;
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
    temperature: number;
    allowRemote?: boolean;
  }) => Promise<{ text: string }>,
  /**
   * 結果を貯める先。**省略できる**（製品の鍵を組み立てられない機能がある）。
   * 詳しくは `RunChunkCache` の断り書き。
   */
  cache?: RunChunkCache
): Promise<RunOutcome<P, R>> {
  // **省略を既定で埋めない。** 行き先で作者にとっての意味がまるで違う
  assertRunner(context.runner);

  // **明示が無ければ製品と同じ**（2026-09-19）。ここで 0.2 のような
  // 決め打ちを噛ませていたせいで、誤字脱字（製品は 0.0）を製品より
  // 揺れた条件で測っていた
  const temperature = temperatureFor(context, prompts.temperature);

  if (context.runner === "claude") {
    return {
      runner: "claude",
      note: claudeNote(validateWith),
      systemPrompt: prompts.systemPrompt,
      schema: prompts.schema,
      // **プロンプトだけ返す道でも温度は渡す。** 受け取った側が自分で
      // 投げるので、ここを省くと**その側の既定で測られる**
      temperature,
      validateWith,
      chunks: prompts.chunks,
    };
  }

  if (context.runner === "sampling") {
    /*
      **ここではキャッシュを使わない。** 鍵にはモデル名が要るが、
      考えるのは呼び出し元で、**どのモデルが答えるかは聞いてみるまで
      分からない**（`reply.model` は答えたあとの申告である）。読むときに
      鍵を作れない以上、書いても二度と当たらない。
    */
    return runChunksBySampling(prompts.chunks, temperature, async (item) => {
      const reply = await askSampling({
        folder: context.folder,
        systemPrompt: prompts.systemPrompt,
        userPrompt: item.userPrompt,
        temperature,
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

  /*
    **手元のOllamaで回すときだけ、キャッシュが効く**（設計書6.87.17）。
    鍵に要るもの（プロバイダIDとモデル名）が、投げる前に揃うのはこの道だけ
    である。`claude` はプロンプトを返すだけで結果を持たず、`sampling` は
    答えるモデルが聞いてみるまで分からない。
  */
  const store = cache ? openChunkCache(cache.folder) : undefined;
  const keyBase: CacheKeyBase | undefined =
    cache && {
      feature: cache.feature,
      promptVersion: cache.promptVersion,
      providerId: OLLAMA_PROVIDER_ID,
      model,
    };
  if (store) await store.load();

  const outcome = await runChunks(
    model,
    temperature,
    prompts.chunks,
    async (item) => {
      const chunkHash =
        store && cache ? cache.hashOf(item.chunkId) : undefined;
      if (store && keyBase && chunkHash !== undefined) {
        const hit = store.get(chunkHash, keyBase);
        if (hit !== undefined) {
          // **貯めてあるのは「読み取ったあとの形」**なので、文字列へ戻して
          // 製品と同じ検算へ通す。迂回すると、製品に無い不具合を見つけた
          // ことになる（CLAUDE.md の「繰り返し起きた失敗」5番）
          return validate(item.chunkId, JSON.stringify(hit));
        }
      }
      const response = await ask({
        endpoint: context.endpoint,
        model,
        systemPrompt: prompts.systemPrompt,
        userPrompt: item.userPrompt,
        schema: prompts.schema,
        numCtx: context.numCtx,
        temperature,
        allowRemote: context.allowRemote,
      });
      // **検算が通ってから貯める。** 読み取れない応答を貯めると、
      // 次からその壊れた答えが返り続ける
      const result = validate(item.chunkId, response.text);
      if (store && cache && keyBase && chunkHash !== undefined) {
        const parsed = cache.parse(response.text);
        if (parsed !== undefined && parsed !== null) {
          await store.set(chunkHash, keyBase, parsed);
        }
      }
      return result;
    }
  );

  if (store) {
    try {
      await store.save();
    } catch (error) {
      /*
        **貯められなくても、出た結果は返す。** ここで投げると、AIを回した
        ぶんが丸ごと無かったことになる（次に回せば同じ時間がまた要る）。
        黙って捨てはしない——理由は標準エラーへ残す。
      */
      process.stderr.write(
        `チャンクキャッシュを保存できませんでした: ${describeError(error)}\n`
      );
    }
  }
  return outcome;
}

/**
 * どの温度で投げるかを決める（設計書6.87.16）。
 *
 * **決め方はここ1か所。** 道具ごとに `?? 既定` を書くと、**直し漏れた
 * 道具だけが別の温度で回る**——0.66 までの `ollama.generate` の既定
 * （0.2）が、まさにその形で製品と食い違っていた。
 *
 * **明示は残す。** 温度を振って出来の変わり方を見たいことがあるためで、
 * そのときは呼ぶ側が意図して打つ。省略すれば製品と同じ値になる。
 */
export function temperatureFor(
  context: { temperature?: number },
  productTemperature: number
): number {
  return context.temperature ?? productTemperature;
}

/**
 * 1回で1つの答えを出す道具の入力（チャンクに切らないもの）。
 *
 * **作品を丸ごと見て1つ答える機能**——各話あらすじ・逸脱・単話プロット
 * （6.87.8）と、0.66.0 で足した冒頭診断・名前の候補・プロット逆算・
 * 章立て・紹介文がこれにあたる。
 */
export interface RunnerInput {
  runner: RunnerKind;
  /** どの作品か。**考えさせる許可を確かめるために要る**（設計書6.87.12） */
  folder?: string;
  endpoint?: string;
  model?: string;
  allowRemote?: boolean;
  numCtx?: number;
  /** 温度を明示して測りたいとき。**省略すれば製品と同じ値**（6.87.16） */
  temperature?: number;
}

export type OnceOutcome<T> =
  | {
      runner: "claude";
      note: string;
      systemPrompt: string;
      userPrompt: string;
      schema: unknown;
      temperature: number;
      validateWith: string;
    }
  | { runner: "ollama"; model: string; temperature: number; result: T }
  | { runner: "sampling"; model: string; temperature: number; result: T };

/** `runOnce` が `ollama` のときに使う読み込み長さ */
const ONCE_DEFAULT_NUM_CTX = 16384;

/**
 * 1回だけ通す（設計書6.87.8）。
 *
 * **チャンクが無いので `runChunks` は使わない**（1回で1つの答え）。
 * 8つの機能が同じ形なので、ここへ寄せてある——**写しのままだと、行き先を
 * 1つ足すたびに全部を直すことになる**（`sampling` を足したときに実際、
 * 直し漏れそうになった）。
 */
export async function runOnce<T>(
  input: RunnerInput,
  prompt: {
    systemPrompt: string;
    schema: unknown;
    userPrompt: string;
    /** 製品がそのプロンプトで使う温度（`prompts/*.ts` の `*_TEMPERATURE`） */
    temperature: number;
    validateWith: string;
  },
  validate: (response: string) => T
): Promise<OnceOutcome<T>> {
  assertRunner(input.runner);
  const temperature = temperatureFor(input, prompt.temperature);
  if (input.runner === "claude") {
    return {
      runner: "claude",
      note: claudeNote(prompt.validateWith),
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      schema: prompt.schema,
      temperature,
      validateWith: prompt.validateWith,
    };
  }
  if (input.runner === "sampling") {
    /*
      **呼び出し元に考えてもらい、検算まで通す**（設計書6.87.12）。
      ここも `claude` と違って往復が要らず、**検算を迂回する道が無い**。
    */
    const reply = await askSampling({
      folder: input.folder,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      temperature,
    });
    return {
      runner: "sampling",
      model: reply.model,
      temperature,
      result: validate(reply.text),
    };
  }

  const model = input.model;
  if (!model) {
    throw new McpToolError("runner が ollama のときは model が要ります。");
  }
  const response = await ollamaGenerate({
    endpoint: input.endpoint,
    model,
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    schema: prompt.schema,
    numCtx: input.numCtx ?? ONCE_DEFAULT_NUM_CTX,
    temperature,
    allowRemote: input.allowRemote,
  });
  return {
    runner: "ollama",
    model,
    temperature,
    result: validate(response.text),
  };
}

/**
 * チャンクごとに回す。
 *
 * **1つ失敗しても全体を止めない**（CLAUDE.md の実装スタイル）。理由を
 * 残して次へ進み、最後にまとめて返す。
 */
export async function runChunks<P extends { chunkId: string }, R>(
  model: string,
  temperature: number,
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
    note: describeOutcome({
      done: results.length,
      failed: failures.length,
      where: "手元の Ollama で",
      aside: "原稿はこの機械から出ていません",
    }),
    model,
    temperature,
    results,
    failures,
  };
}

/**
 * 何が起きたかを、起きたとおりに書く（2026-09-16、実機で見つけた）。
 *
 * **通していないのに「通しました」と書かない。** 全件が許可で断られた回にも
 * 「検算まで通しました」と返しており、**呼んだ側からは成功したように
 * 見えていた**——結果は空なので害は出ないが、失敗を数えない報告は報告ではない。
 *
 * **行き先の断りは、1件でも呼んだときだけ添える。** 1件も通っていないときに
 * 「本文は呼び出し元へ渡っており」と書くと、**渡っていないのに渡ったこと**に
 * なる（許可で断れば、本文はどこへも出ていない）。
 */
export function describeOutcome(options: {
  done: number;
  failed: number;
  /** どこで通したか（「手元の Ollama で」「呼び出し元に考えてもらい、」） */
  where: string;
  /** 本文の行き先についての断り */
  aside: string;
}): string {
  if (options.failed === 0) {
    return `${options.where}検算まで通しました（${options.aside}）。${VALIDATE_NOTE}`;
  }
  if (options.done === 0) {
    return `1件も通せませんでした（${options.failed}件すべて失敗）。理由は failures にあります。`;
  }
  return (
    `${options.where}${options.done}件を検算まで通しました（${options.aside}）。` +
    `${options.failed}件は失敗しています（理由は failures）。${VALIDATE_NOTE}`
  );
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
  temperature: number,
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
    note: describeOutcome({
      done: results.length,
      failed: failures.length,
      where: "呼び出し元に考えてもらい、",
      aside: "本文は呼び出し元へ渡っており、その先は呼び出し元の設定によります",
    }),
    model: models.size > 0 ? [...models].join(" / ") : "（不明）",
    temperature,
    results,
    failures,
  };
}

// さくらのAI（クラウド）で測るための部品（設計書6.87.15 の柱3）。
//
// **`measure.mjs` から切り出してある。** ここは fetch とプロンプトの受け渡しだけを
// 引き受け、束も引数の解釈も持たない——**偽の fetch を渡せば、本物へ繋がずに
// 形を確かめられる**（`test/unit/measureSakura.test.ts`）。
//
// **3段で回す**（MCP の `claude` 経路と同じ形）。
//   1. `novel.prompt` でプロンプトを受け取る
//   2. ここから さくらへ投げる（OpenAI互換の `chat/completions`）
//   3. `novel.validate` へ応答を戻し、**製品の検算を通す**
//
// **`prompt` だけ呼んで `validate` を通さない測り方はしない**（スキル
// `field-check`）。迂回すると、製品に無い不具合を見つけたことになる。
//
// **鍵の扱いがこのファイルのいちばん大事なところ。**
//   - 鍵は環境変数からだけ読む（引数でもファイルでも対話でも受け取らない）
//   - 鍵は `Authorization` ヘッダにしか載せない。**本文にも記録にも載せない**
//   - 失敗の本文は残すが（実装ルール5）、**ヘッダは1つも残さない**
import { SAKURA_AI_CHAT_COMPLETIONS_ENDPOINT } from "./sakuraAiSmoke.mjs";
import { resultsOfResponse } from "./measureScoring.mjs";

/** 鍵を読む環境変数。**ここ以外から鍵を受け取らない** */
export const SAKURA_TOKEN_ENV = "SAKURA_AI_ACCOUNT_TOKEN";

/** 宛先。`sakuraAiSmoke.mjs` と同じものを使う（写しを持たない） */
export const SAKURA_ENDPOINT = SAKURA_AI_CHAT_COMPLETIONS_ENDPOINT;

/**
 * 1チャンクあたりの待ち時間。**クラウドは遅いことがある。**
 *
 * 手元の Ollama なら詰まったらすぐ分かるが、クラウドは混み具合で
 * 何十秒も返らないことがある。短くすると、**遅いだけの回を失敗として数える。**
 */
export const DEFAULT_SAKURA_TIMEOUT_MS = 180_000;

/**
 * 受け取る出力の上限。`src/ai/outputLimit.ts` の `DEFAULT_MAX_OUTPUT_TOKENS` と同じ値。
 *
 * **小さすぎると応答が途中で切れ、そのチャンクが丸ごと捨てられる**——
 * 呼び出し1回ぶんが無駄になるので、節約しすぎない。
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

/* ── 鍵 ───────────────────────────────────────────────── */

/**
 * 鍵を環境変数から読む。**無ければ測らずに止める。**
 *
 * **鍵を尋ねない・引数で受け取らない・ファイルから読まない。** 尋ねると
 * 会話の記録に残り、引数で受け取るとコマンド履歴に残る。環境変数なら
 * 「作者が置いたものを、この一度だけ読む」で済む。
 */
export function readSakuraToken(env = process.env) {
  const raw = env?.[SAKURA_TOKEN_ENV];
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  throw new Error(
    `環境変数 ${SAKURA_TOKEN_ENV} を設定してください` +
      "（さくらのAIの鍵は、引数でもファイルでも受け取りません）。"
  );
}

/* ── スキーマの方言 ───────────────────────────────────── */

/**
 * OpenAI の構造化出力（strict）向けに直す。
 *
 * **`src/ai/jsonSchema.ts` の `toOpenAIJsonSchema` と同じ直し方**でなければ、
 * 製品と違う形のスキーマで測ることになる。**同じ結果になるかは
 * `test/unit/measureSakura.test.ts` が製品の関数と突き合わせて見張る**
 * ——写しを置いたまま片方だけ直る、をここで止める。
 */
export function toOpenAIJsonSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toOpenAIJsonSchema);
  if (schema === null || typeof schema !== "object") return schema;

  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    // 件数の制約は strict が受け付けない。入っているとスキーマごと拒まれる
    if (key === "maxItems" || key === "minItems") continue;
    out[key] = toOpenAIJsonSchema(value);
  }

  if (out.type === "object" || out.properties !== undefined) {
    out.additionalProperties = false;
    if (
      typeof out.properties === "object" &&
      out.properties !== null &&
      !Array.isArray(out.properties)
    ) {
      out.required = Object.keys(out.properties);
    }
  }
  return out;
}

/* ── さくらへ投げる ───────────────────────────────────── */

/** 応答の本文を、記録に載せてよい長さへ詰める（鍵は元から入らない） */
function compact(text) {
  return String(text ?? "").replace(/\s+/g, " ").slice(0, 500);
}

/** その指定が未対応だと言われたか（`src/ai/openaiProvider.ts` と同じ見方） */
export function mentionsUnsupported(detail, parameter) {
  const text = String(detail ?? "");
  return (
    text.includes(parameter) &&
    /unsupported|not supported|does not support/i.test(text)
  );
}

/**
 * 1回だけ投げる。**例外にせず、通ったかどうかを返す**
 * （呼ぶ側が「指定を外して出し直す」を決められるように）。
 *
 * **ヘッダは返り値にも失敗の説明にも入れない。** 入れた瞬間に、鍵が
 * 記録とログへ流れる。
 */
async function postOnce({ body, token, endpoint, fetchImpl, timeoutMs }) {
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      // Node 24 にはあるが、偽の fetch を渡す試験では使わない
      signal:
        typeof AbortSignal?.timeout === "function"
          ? AbortSignal.timeout(timeoutMs)
          : undefined,
    });
  } catch (error) {
    // **原因を当てにいかない**（実装ルール5）。起きたことだけを書く
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `さくらのAIへ繋がりませんでした: ${reason}` };
  }

  if (!response.ok) {
    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    // **本文を捨てない**（実装ルール5）。どの項目が悪いかはここにしか無い
    return {
      ok: false,
      detail: `さくらのAI HTTP ${response.status}${text ? `: ${compact(text)}` : ""}`,
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, detail: "さくらのAIの応答をJSONとして読めませんでした。" };
  }

  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.trim() === "") {
    const finish = payload?.choices?.[0]?.finish_reason ?? "unknown";
    return {
      ok: false,
      detail: `さくらのAIから空の応答が返りました（finish_reason=${finish}）。`,
    };
  }
  return { ok: true, text, usage: payload?.usage ?? null };
}

/**
 * さくらへ1チャンク投げて、応答の本文を受け取る。
 *
 * **断られた指定だけを外して出し直す**（実装ルール5）。どれが駄目かを
 * エラー文から当てにいかず、`response_format` を1つ外して試すだけにする
 * ——形式の強制が効かなくても、製品の解析器はコードフェンス付きの応答も読める。
 */
export async function askSakura({
  token,
  model,
  systemPrompt,
  userPrompt,
  schema,
  endpoint = SAKURA_ENDPOINT,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_SAKURA_TIMEOUT_MS,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
  log,
}) {
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error(`${SAKURA_TOKEN_ENV} が空です。`);
  }
  if (typeof model !== "string" || model.trim() === "") {
    throw new Error("--model を指定してください（さくらのモデル名）。");
  }

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    // **測定なので揺れを抑える**（同じ台で2度測ったときに比べられるように）
    temperature: 0,
    max_tokens: maxOutputTokens,
    stream: false,
  };
  if (schema !== undefined && schema !== null) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "novelai_result",
        strict: true,
        schema: toOpenAIJsonSchema(schema),
      },
    };
  }

  let droppedResponseFormat = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outcome = await postOnce({ body, token, endpoint, fetchImpl, timeoutMs });
    if (outcome.ok) {
      return {
        text: outcome.text,
        usage: outcome.usage,
        droppedResponseFormat,
      };
    }
    if (
      body.response_format !== undefined &&
      mentionsUnsupported(outcome.detail, "response_format")
    ) {
      delete body.response_format;
      droppedResponseFormat = true;
      log?.(
        "さくらのAI: JSON形式の強制が受け付けられなかったため、外して出し直します。"
      );
      continue;
    }
    throw new Error(outcome.detail);
  }
  throw new Error("さくらのAIへの要求が受け付けられませんでした。");
}

/* ── 3段で回す ────────────────────────────────────────── */

/**
 * `novel.prompt` の返り値から、投げる単位を取り出す。
 *
 * **形が2つある。** チャンクに切る機能（推敲・誤字脱字など）は `chunks[]` を、
 * 話を丸ごと1回で見る機能（逸脱・各話あらすじ）は `userPrompt` を1つ返す。
 * 後者には `chunkId` が無く、検算にも要らない。
 */
export function promptChunksOf(response) {
  if (Array.isArray(response?.chunks)) {
    return response.chunks.map((chunk, at) => ({
      chunkId: typeof chunk?.chunkId === "string" ? chunk.chunkId : null,
      userPrompt: String(chunk?.userPrompt ?? ""),
      label: chunk?.chunkId ?? chunk?.chapterLabel ?? `#${at}`,
    }));
  }
  if (typeof response?.userPrompt === "string") {
    return [
      { chunkId: null, userPrompt: response.userPrompt, label: "（話まるごと）" },
    ];
  }
  throw new Error(
    "novel.prompt の返り値に chunks も userPrompt もありません（測る形が変わった可能性があります）。"
  );
}

/**
 * `novel.validate` へ渡す引数を組む。
 *
 * **要る項目だけを選ぶ**（`NOVEL_VALIDATE_INPUT`）。`numCtx` や `chunkIndex` は
 * 検算では使わない——`chunkId` から切り直すので、切り方はそちらに入っている。
 * 余った項目を渡すと、**渡ったつもりで黙って捨てられる**。
 */
const VALIDATE_KEYS = ["folder", "feature", "filePath", "chapter", "options"];

export function validateArgsOf(baseArgs, { chunkId, response }) {
  const args = {};
  for (const key of VALIDATE_KEYS) {
    if (baseArgs?.[key] !== undefined) args[key] = baseArgs[key];
  }
  // **チャンクに切らない機能では渡さない**（空文字を渡すと検算が断る）
  if (typeof chunkId === "string" && chunkId !== "") args.chunkId = chunkId;
  args.response = response;
  return args;
}

/**
 * 検算の返り値を、数え方（`measureScoring.mjs`）が読む形にほぐす。
 *
 * **`novel.run` と形が違う。** `run` は `results[]`／`result` に包んで返すが、
 * `validate` は**結果そのもの**（`{ chunkId, accepted, rejected }`）を返す。
 * 包まれていないので、`resultsOfResponse` だけでは 0 件として数えてしまう。
 */
export function resultsOfValidated(validated, label) {
  const wrapped = resultsOfResponse(validated, label);
  if (wrapped.length > 0) return wrapped;
  if (validated && typeof validated === "object") {
    // `chunkId` を持っていればそちらが勝つ（後ろの展開が前を上書きする）
    return [{ chunkId: label, ...validated }];
  }
  return [];
}

/**
 * 1つの対象（1話ぶん）を、3段で回す。
 *
 * **1チャンクの失敗で全体を止めない**（実装ルール5）。理由を `failures` に
 * 残して次のチャンクへ進む——ここで止めると、1つのタイムアウトで
 * 測定が丸ごと消える。
 *
 * @param promptResponse `novel.prompt` の返り値
 * @param baseArgs その対象を指す引数（`folder`・`feature`・`filePath` など）
 * @param ask さくらへ投げる関数（試験では偽物を渡す）
 * @param validate `novel.validate` を呼ぶ関数
 */
export async function runSakuraChunks({
  promptResponse,
  baseArgs,
  ask,
  validate,
  log,
}) {
  const chunks = promptChunksOf(promptResponse);
  const results = [];
  const failures = [];
  const raw = [];

  for (const chunk of chunks) {
    const label = chunk.label;
    try {
      const answered = await ask({
        systemPrompt: promptResponse.systemPrompt,
        userPrompt: chunk.userPrompt,
        schema: promptResponse.schema,
      });
      const validated = await validate(
        validateArgsOf(baseArgs, {
          chunkId: chunk.chunkId,
          response: answered.text,
        })
      );
      for (const item of resultsOfValidated(validated, label)) results.push(item);
      // **生のまま残す。**「提案なし 3」の正体は、生の応答を見て初めて分かった
      raw.push({
        target: label,
        aiText: answered.text,
        droppedResponseFormat: answered.droppedResponseFormat === true,
        usage: answered.usage ?? null,
        validated,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push({ chunkId: label, reason });
      raw.push({ target: label, error: reason });
      log?.(`    × ${label}: ${reason}`);
    }
  }

  return { results, failures, raw };
}

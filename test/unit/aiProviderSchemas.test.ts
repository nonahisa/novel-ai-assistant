import { describe, expect, test } from "vitest";
import { toGeminiSchema, toOpenAIJsonSchema } from "../../src/ai/jsonSchema";
import { isChatModel, isUnsupportedParameter } from "../../src/ai/openaiProvider";
import {
  geminiAttemptPlan,
  isInvalidArgument,
} from "../../src/ai/geminiProvider";
import { parseRetryAfterMs, toStatusError } from "../../src/ai/httpClient";
import {
  claudeAttemptPlan,
  toClaudeJsonSchema,
} from "../../src/ai/claudeProvider";
import { clampToModelLimit } from "../../src/ai/outputLimit";
import { AIError, validateApiKeyFormat } from "../../src/ai/types";
import { CHARACTER_EXTRACT_SCHEMA } from "../../src/prompts/characterExtract";
import {
  buildExtractionCostNotice,
  describeRateLimitGiveUp,
  rateLimitWaitMs,
} from "../../src/features/extractCharacters";

describe("OpenAI向けスキーマ変換", () => {
  test("すべてのobjectに additionalProperties: false を付ける", () => {
    const converted = toOpenAIJsonSchema({
      type: "object",
      properties: { name: { type: "string" } },
    }) as Record<string, unknown>;

    expect(converted.additionalProperties).toBe(false);
  });

  test("省略可能だった項目もrequiredへ入れる", () => {
    // strictモードには「省略可能な項目」が無い。
    // 入れないとスキーマ自体を400で拒否される
    const converted = toOpenAIJsonSchema({
      type: "object",
      properties: { name: { type: "string" }, role: { type: "string" } },
      required: ["name"],
    }) as Record<string, unknown>;

    expect(converted.required).toEqual(["name", "role"]);
  });

  test("入れ子のobjectと配列の中まで変換する", () => {
    const converted = toOpenAIJsonSchema({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "object", properties: { id: { type: "string" } } },
        },
      },
    }) as Record<string, unknown>;

    const items = (converted.properties as Record<string, unknown>).items as Record<
      string,
      unknown
    >;
    const element = items.items as Record<string, unknown>;
    expect(element.additionalProperties).toBe(false);
    expect(element.required).toEqual(["id"]);
  });

  test("null許容の配列表記はそのまま残す", () => {
    // OpenAIは type: ["string", "null"] を受け付ける
    const converted = toOpenAIJsonSchema({
      type: "object",
      properties: { role: { type: ["string", "null"] } },
    }) as Record<string, unknown>;

    const role = (converted.properties as Record<string, unknown>).role;
    expect(role).toEqual({ type: ["string", "null"] });
  });

  test("実際の抽出スキーマを変換できる", () => {
    const converted = toOpenAIJsonSchema(CHARACTER_EXTRACT_SCHEMA) as Record<
      string,
      unknown
    >;

    expect(converted.additionalProperties).toBe(false);
    expect(Array.isArray(converted.required)).toBe(true);
    // 変換結果がJSONとして送れること
    expect(() => JSON.stringify(converted)).not.toThrow();
  });
});

describe("Gemini向けスキーマ変換", () => {
  test("typeを大文字にする", () => {
    const converted = toGeminiSchema({ type: "string" }) as Record<string, unknown>;

    expect(converted.type).toBe("STRING");
  });

  test("null許容は nullable: true で表す", () => {
    // GeminiのresponseSchemaはOpenAPI形式で、typeに配列を書けない
    const converted = toGeminiSchema({ type: ["string", "null"] }) as Record<
      string,
      unknown
    >;

    expect(converted).toEqual({ type: "STRING", nullable: true });
  });

  test("additionalProperties を落とす", () => {
    // 残すとスキーマごと拒否される
    const converted = toGeminiSchema({
      type: "object",
      additionalProperties: false,
      properties: { name: { type: "string" } },
    }) as Record<string, unknown>;

    expect(converted.additionalProperties).toBeUndefined();
    expect(converted.type).toBe("OBJECT");
  });

  test("入れ子の中まで変換する", () => {
    const converted = toGeminiSchema({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "object", properties: { id: { type: ["string", "null"] } } },
        },
      },
    }) as Record<string, unknown>;

    const items = (converted.properties as Record<string, unknown>).items as Record<
      string,
      unknown
    >;
    const element = items.items as Record<string, unknown>;
    const id = (element.properties as Record<string, unknown>).id;

    expect(items.type).toBe("ARRAY");
    expect(id).toEqual({ type: "STRING", nullable: true });
  });

  test("requiredやenumはそのまま残す", () => {
    const converted = toGeminiSchema({
      type: "object",
      properties: { kind: { type: "string", enum: ["a", "b"] } },
      required: ["kind"],
    }) as Record<string, unknown>;

    expect(converted.required).toEqual(["kind"]);
    const kind = (converted.properties as Record<string, unknown>).kind as Record<
      string,
      unknown
    >;
    expect(kind.enum).toEqual(["a", "b"]);
  });

  test("実際の抽出スキーマを変換できる", () => {
    const converted = toGeminiSchema(CHARACTER_EXTRACT_SCHEMA);

    expect(JSON.stringify(converted)).not.toContain("additionalProperties");
    // 型指定が配列のまま残っていると送信時に弾かれる
    expect(JSON.stringify(converted)).not.toMatch(/"type":\s*\[/);
  });
});

describe("ChatGPTのモデル絞り込み", () => {
  test("文章生成に使えないモデルを外す", () => {
    expect(isChatModel("text-embedding-3-small")).toBe(false);
    expect(isChatModel("whisper-1")).toBe(false);
    expect(isChatModel("dall-e-3")).toBe(false);
    expect(isChatModel("tts-1")).toBe(false);
    expect(isChatModel("omni-moderation-latest")).toBe(false);
  });

  test("判断が付かないモデルは残す", () => {
    // 個別の名前で許可リストを作ると、新しいモデルが一覧に出なくなる
    expect(isChatModel("gpt-4o")).toBe(true);
    expect(isChatModel("gpt-6-turbo-2027-01-01")).toBe(true);
    expect(isChatModel("o5-mini")).toBe(true);
    expect(isChatModel("まだ知らないモデル")).toBe(true);
  });
});

describe("HTTPステータスの種別分け", () => {
  test.each([
    [401, "authentication_failed"],
    [403, "permission_denied"],
    [404, "model_not_found"],
    [429, "rate_limited"],
    [500, "bad_response"],
    [400, "bad_response"],
  ] as const)("HTTP %i を %s として扱う", (status, kind) => {
    expect(toStatusError(status, "detail", "ChatGPT").kind).toBe(kind);
  });

  test("詳細は長すぎないよう切り詰める", () => {
    const error = toStatusError(400, "x".repeat(2000), "Gemini");

    expect(error.detail?.length).toBe(500);
  });
});

describe("APIキーの検査", () => {
  test.each([
    // Google AI Studio が新しく発行する形式。以前は AIza だった
    "AQ.Ab8RN6JuQEwhj-nHcgmJ6ArXecZZxy6OynqOGvTrd2tZlEUYvw",
    // OpenAI のプロジェクトキー
    "sk-proj-abcdef123456",
    "sk-ant-api03-abcdef",
    "これから各社が使うかもしれない未知の形式",
  ])("接頭辞で弾かない: %s", (key) => {
    // 接頭辞を必須にすると、発行元が形式を変えた瞬間に
    // 正しいキーを登録できなくなる（Geminiで実際に起きた）。
    // 形式が正しいかは接続テストが実際にAPIを叩いて確かめる
    expect(validateApiKeyFormat(key)).toBeUndefined();
  });

  test("空欄は入力を促す", () => {
    expect(validateApiKeyFormat("   ")).toBe("APIキーを入力してください。");
  });

  test("途中に空白が混ざっていたら知らせる", () => {
    // 貼り付け時に改行が混ざるのはよくある失敗で、
    // これは接続テストを待たずに指摘できる
    expect(validateApiKeyFormat("sk-abc def")).toContain("貼り付け直して");
  });

  test("前後の空白は問題にしない", () => {
    expect(validateApiKeyFormat("  sk-abcdef  ")).toBeUndefined();
  });
});

describe("実行前の料金表示", () => {
  const chunk = {
    filePath: "c:\\novels\\work\\本文\\001.txt",
    text: "本文",
    hash: "h1",
    chapterStart: 1,
    chapterEnd: 1,
    index: 0,
    total: 1,
  };

  test("手元で動かすものは無料と示す", () => {
    expect(buildExtractionCostNotice("ollama", false, [chunk], [], 4096)).toContain(
      "無料・手元で実行"
    );
  });

  test("LM Studio も無料と示す", () => {
    // **課金されないのに課金の目安が出ていた。** 判定が
    // `providerId === "ollama"` の文字列一致だったため、同じく
    // 手元で動く LM Studio が漏れていた（設計書6.28）
    const notice = buildExtractionCostNotice("lmstudio", false, [chunk], [], 4096);

    expect(notice).toContain("無料・手元で実行");
    expect(notice).not.toContain("課金対象");
  });

  test.each([
    ["claude", "Claude API"],
    ["openai", "OpenAI API"],
    ["gemini", "Gemini API"],
  ] as const)("%s はサービス名を出して利用量を予告する", (id, serviceName) => {
    // 新しく足したプロバイダーで警告が消えると、
    // 作者が課金に気づかないまま73万字を流してしまう
    const notice = buildExtractionCostNotice(id, true, [chunk], [], 4096);

    expect(notice).toContain("【課金対象トークン量の目安（上限寄り）】");
    expect(notice).toContain(`${serviceName}は実行すると利用量が加算されます`);
  });
});

describe("未対応パラメータの検出", () => {
  test("temperatureを拒否されたと分かる", () => {
    const error = new AIError(
      "ChatGPTがエラーを返しました (HTTP 400)。",
      "bad_response",
      `{"error":{"message":"Unsupported value: 'temperature' does not support 0.2 with this model."}}`
    );

    expect(isUnsupportedParameter(error, "temperature")).toBe(true);
  });

  test("無関係のエラーを取り違えない", () => {
    const error = new AIError("失敗", "bad_response", "rate limit reached");

    expect(isUnsupportedParameter(error, "temperature")).toBe(false);
  });

  test("認証失敗は再試行の対象にしない", () => {
    const error = new AIError("失敗", "authentication_failed", "temperature");

    expect(isUnsupportedParameter(error, "temperature")).toBe(false);
  });

});

/** スキーマ全体で「properties にあるのに required に無い」項目を数える */
function countOptionalProperties(schema: unknown): number {
  if (Array.isArray(schema)) {
    return schema.reduce<number>(
      (total, item) => total + countOptionalProperties(item),
      0
    );
  }
  if (schema === null || typeof schema !== "object") return 0;

  const node = schema as Record<string, unknown>;
  let count = 0;
  if (node.properties && typeof node.properties === "object") {
    const names = Object.keys(node.properties as Record<string, unknown>);
    const required = Array.isArray(node.required)
      ? (node.required as string[])
      : [];
    count += names.filter((name) => !required.includes(name)).length;
  }
  for (const value of Object.values(node)) {
    count += countOptionalProperties(value);
  }
  return count;
}

describe("Claudeの要求不正の扱い", () => {
  test("まず1つずつ外し、どれでも直らないときだけまとめて外す", () => {
    // 積み上げ式に外すと、原因が最後の1つ（JSONスキーマ）でも、
    // 先に外した effort と 思考の無効化 まで「非対応」として覚えてしまう。
    // 実際にそうなり、スキーマ無し・思考ONのまま呼び続ける状態になった
    const plan = claudeAttemptPlan(
      { effort: true, thinking: true, jsonSchema: true },
      ["effort", "thinking", "jsonSchema"]
    );

    expect(plan.map((attempt) => attempt.dropped)).toEqual([
      [],
      ["effort"],
      ["thinking"],
      ["jsonSchema"],
      ["effort", "thinking", "jsonSchema"],
    ]);
    // 1つだけ外した試行では、他の指定は付いたまま
    expect(plan[3].support).toEqual({
      effort: true,
      thinking: true,
      jsonSchema: false,
    });
  });

  test("送っていない指定は外す候補にしない", () => {
    // 送ってもいない指定を「非対応」と覚えると、次に必要になったとき失う
    const plan = claudeAttemptPlan(
      { effort: true, thinking: true, jsonSchema: true },
      ["thinking"]
    );

    expect(plan.map((attempt) => attempt.dropped)).toEqual([[], ["thinking"]]);
  });

  test("すでに非対応と分かっている指定は試し直さない", () => {
    const plan = claudeAttemptPlan(
      { effort: false, thinking: true, jsonSchema: true },
      ["effort", "thinking", "jsonSchema"]
    );

    expect(plan.map((attempt) => attempt.dropped)).toEqual([
      [],
      ["thinking"],
      ["jsonSchema"],
      ["thinking", "jsonSchema"],
    ]);
  });

  test("必須でない項目を残さない（Anthropicの上限で弾かれる）", () => {
    // 実データで拒否された応答：
    // 「Schemas contains too many optional parameters (26) … (limit: 24)」
    // 個別の指定ではなくスキーマ全体が受け取ってもらえていなかった
    const converted = toClaudeJsonSchema(CHARACTER_EXTRACT_SCHEMA);

    expect(countOptionalProperties(converted)).toBe(0);
  });

  test("必須にしても「読み取れなかった」は表せる", () => {
    // null許容の項目は anyOf に null を含むので、必須にしても意味は変わらない
    const converted = toClaudeJsonSchema({
      type: "object",
      properties: { reading: { type: ["string", "null"] } },
    }) as Record<string, unknown>;

    expect(converted.required).toEqual(["reading"]);
    expect(
      (converted.properties as Record<string, { anyOf: unknown }>).reading.anyOf
    ).toEqual([{ type: "string" }, { type: "null" }]);
  });

  test("文字数の制約は最初から送らない", () => {
    // Anthropicの構造化出力は minLength / maxLength を受け付けない。
    // 試すだけ無駄なうえ、その400が他の指定への濡れ衣になる
    const converted = JSON.stringify(
      toClaudeJsonSchema({
        type: "object",
        properties: {
          summary: { type: "string", maxLength: 50 },
          evidence: { type: "string", minLength: 1 },
        },
      })
    );

    expect(converted).not.toContain("maxLength");
    expect(converted).not.toContain("minLength");
    // 型の情報までは落とさない
    expect(converted).toContain("string");
  });

  test("null許容にした項目からは文字数の制約を外す", () => {
    // anyOf と併記できないため、残すと要求ごと拒否される
    const converted = toClaudeJsonSchema({
      type: ["string", "null"],
      maxLength: 50,
    }) as Record<string, unknown>;

    expect(converted.anyOf).toEqual([{ type: "string" }, { type: "null" }]);
    expect(converted.maxLength).toBeUndefined();
  });
});

describe("Geminiの引数不正の扱い", () => {
  test("項目名が書かれていなくても引数不正だと分かる", () => {
    // Geminiはどの項目が悪いのか教えてくれない。
    // エラー文に thinking のような語が含まれることを当てにしてはいけない
    const actual = new AIError(
      "Geminiがエラーを返しました (HTTP 400)。",
      "bad_response",
      `{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}`
    );

    expect(isInvalidArgument(actual)).toBe(true);
  });

  test("上限や認証の失敗を引数不正と取り違えない", () => {
    // これらは指定を外しても直らないので、再試行してはいけない
    expect(
      isInvalidArgument(new AIError("失敗", "rate_limited", "quota"))
    ).toBe(false);
    expect(
      isInvalidArgument(new AIError("失敗", "authentication_failed", "bad key"))
    ).toBe(false);
  });

  test("思考の無効化から先に外し、JSONスキーマは最後まで残す", () => {
    // スキーマは抽出の質に直結するので、できるだけ手放さない。
    // Claudeと同じく、まず1つずつ外して犯人を特定する
    const plan = geminiAttemptPlan(
      { thinkingConfig: true, responseSchema: true },
      ["thinkingConfig", "responseSchema"]
    );

    expect(plan.map((attempt) => attempt.dropped)).toEqual([
      [],
      ["thinkingConfig"],
      ["responseSchema"],
      ["thinkingConfig", "responseSchema"],
    ]);
    // 思考だけを外した試行では、スキーマは付いたまま
    expect(plan[1].support).toEqual({
      thinkingConfig: false,
      responseSchema: true,
    });
  });

  test("スキーマを渡していない呼び出しでは、スキーマを外す試行をしない", () => {
    const plan = geminiAttemptPlan(
      { thinkingConfig: true, responseSchema: true },
      ["thinkingConfig"]
    );

    expect(plan.map((attempt) => attempt.dropped)).toEqual([
      [],
      ["thinkingConfig"],
    ]);
  });
});

describe("出力上限の丸め", () => {
  test("モデルの上限を超えたら丸める", () => {
    expect(clampToModelLimit(16384, 8192)).toBe(8192);
  });

  test("モデルの上限が分からなければ設定値をそのまま使う", () => {
    expect(clampToModelLimit(16384, undefined)).toBe(16384);
    expect(clampToModelLimit(16384, 0)).toBe(16384);
  });

  test("小さくしすぎない", () => {
    // これ以下だと抽出のJSONが収まらず、
    // 応答が切れてそのチャンクの結果が丸ごと捨てられる
    expect(clampToModelLimit(16384, 100)).toBe(1024);
  });
});

describe("レート上限の待ち時間", () => {
  test("ヘッダーの秒数を読む", () => {
    expect(parseRetryAfterMs("30", "")).toBe(30000);
  });

  test("Geminiが本文に入れてくる待ち時間を読む", () => {
    // Geminiは Retry-After ヘッダーを付けず、本文にしか書かない
    const body = `{"error":{"message":"Quota exceeded ... Please retry in 6.499650674s.","status":"RESOURCE_EXHAUSTED"}}`;

    expect(parseRetryAfterMs(null, body)).toBeCloseTo(6499.65, 0);
  });

  test("retryDelay 形式も読む", () => {
    const body = `{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"13s"}]}}`;

    expect(parseRetryAfterMs(null, body)).toBe(13000);
  });

  const fresh = () => ({ waits: 0, totalWaitedMs: 0 });

  test("待ち時間の指定が無ければ待たない", () => {
    // 当てずっぽうで待つと、いつ終わるか分からない処理になる
    expect(parseRetryAfterMs(null, "just an error")).toBeUndefined();
    expect(
      rateLimitWaitMs(new AIError("上限", "rate_limited", "detail"), fresh())
    ).toBeUndefined();
  });

  test("指定があれば少し余裕を足して待つ", () => {
    const error = new AIError("上限", "rate_limited", "detail", 6500);

    expect(rateLimitWaitMs(error, fresh())).toBe(7500);
  });

  test("1回が長すぎる指定には従わない", () => {
    const error = new AIError("上限", "rate_limited", "detail", 600_000);

    expect(rateLimitWaitMs(error, fresh())).toBeUndefined();
  });

  test("合計3分を超えるなら待たずに諦める", () => {
    // 無料枠には1日あたりの上限もあり、使い切っていると待っても回復しない。
    // 回数で区切ると1回の長さ次第で何十分にもなるため、合計時間で区切る
    const error = new AIError("上限", "rate_limited", "detail", 60_000);

    expect(
      rateLimitWaitMs(error, { waits: 2, totalWaitedMs: 130_000 })
    ).toBeUndefined();
    expect(
      rateLimitWaitMs(error, { waits: 2, totalWaitedMs: 110_000 })
    ).toBe(61_000);
  });

  test("上限以外の失敗では待たない", () => {
    const error = new AIError("失敗", "bad_response", "detail", 5000);

    expect(rateLimitWaitMs(error, fresh())).toBeUndefined();
  });

  test("諦めたときは次にすべきことを示す", () => {
    const message = describeRateLimitGiveUp({ waits: 3, totalWaitedMs: 180_000 });

    expect(message).toContain("180 秒待ちました");
    expect(message).toContain("1日あたりの上限");
    expect(message).toContain("Ollama");
    expect(message).toContain("完了済みのチャンクは次回再利用されます");
  });
});

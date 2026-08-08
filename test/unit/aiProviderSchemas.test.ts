import { describe, expect, test } from "vitest";
import { toGeminiSchema, toOpenAIJsonSchema } from "../../src/ai/jsonSchema";
import { isChatModel, isUnsupportedParameter } from "../../src/ai/openaiProvider";
import {
  dropNextOption,
  isInvalidArgument,
} from "../../src/ai/geminiProvider";
import { parseRetryAfterMs, toStatusError } from "../../src/ai/httpClient";
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

  test("ローカル実行は無料と示す", () => {
    expect(buildExtractionCostNotice("ollama", [chunk], [], 4096)).toContain(
      "無料・ローカル実行"
    );
  });

  test.each([
    ["claude", "Claude API"],
    ["openai", "OpenAI API"],
    ["gemini", "Gemini API"],
  ] as const)("%s はサービス名を出して利用量を予告する", (id, serviceName) => {
    // 新しく足したプロバイダーで警告が消えると、
    // 作者が課金に気づかないまま73万字を流してしまう
    const notice = buildExtractionCostNotice(id, [chunk], [], 4096);

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
    // スキーマは抽出の質に直結するので、できるだけ手放さない
    const support = { thinkingConfig: true, responseSchema: true };

    expect(dropNextOption(support)).toBe("思考の無効化");
    expect(support).toEqual({ thinkingConfig: false, responseSchema: true });

    expect(dropNextOption(support)).toBe("JSONスキーマ");
    expect(support).toEqual({ thinkingConfig: false, responseSchema: false });

    // 外せるものが無くなったら諦める（無限に試さない）
    expect(dropNextOption(support)).toBeUndefined();
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

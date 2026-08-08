/**
 * プロバイダごとのJSONスキーマ変換。
 *
 * 抽出プロンプトのスキーマ（`prompts/characterExtract.ts`）はOllama向けに書いてある。
 * これを直接書き換えると `_VERSION` を上げることになり、
 * 処理済みチャンクのキャッシュが全部無効になって作品全体を再処理させてしまう。
 * そのため送信直前にプロバイダごとの方言へ変換する。
 *
 * Claude向けの変換だけは歴史的な経緯で `claudeProvider.ts` にある。
 */

/**
 * OpenAIの構造化出力（Structured Outputs）向けに変換する。
 *
 * strictモードには以下の制約がある。
 *   - すべてのobjectに additionalProperties: false が必要
 *   - **すべてのプロパティを required に列挙する必要がある**
 *     （省略可能な項目という概念が無い。null許容で表現する）
 *   - type: ["string", "null"] の配列形式は使える
 */
export function toOpenAIJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toOpenAIJsonSchema);
  if (schema === null || typeof schema !== "object") return schema;

  const source = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = toOpenAIJsonSchema(value);
  }

  if (out.type === "object" || out.properties !== undefined) {
    out.additionalProperties = false;
    // 元のスキーマで省略可能だった項目もrequiredへ入れる。
    // 入れないとOpenAIがスキーマ自体を400で拒否する。
    if (isRecord(out.properties)) {
      out.required = Object.keys(out.properties);
    }
  }

  return out;
}

/**
 * Geminiの responseSchema 向けに変換する。
 *
 * GeminiはOpenAPIのSchemaを使うため、JSON Schemaと食い違う点がある。
 *   - type に配列を書けない。null許容は nullable: true で表す
 *   - additionalProperties を受け付けない
 *   - type は大文字（STRING / OBJECT）で書く
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema === null || typeof schema !== "object") return schema;

  const source = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    // Geminiが解釈できない語は落とす。残すとスキーマごと拒否される
    if (key === "additionalProperties" || key === "$schema") continue;

    if (key === "type") {
      const types = Array.isArray(value) ? value : [value];
      const concrete = types.filter((entry) => entry !== "null");
      if (types.length !== concrete.length) out.nullable = true;
      // 具体的な型が無い（null のみ）ときは型指定を諦める
      if (concrete.length > 0) {
        out.type = String(concrete[0]).toUpperCase();
      }
      continue;
    }

    out[key] = toGeminiSchema(value);
  }

  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

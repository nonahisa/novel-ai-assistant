import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import {
  claudeSchemaFingerprint,
  normalizeStoredSupport,
  rememberedSupport,
  toClaudeJsonSchema,
} from "../../../src/ai/claudeProvider";
import { OPENING_CHECK_SCHEMA } from "../../../src/prompts/openingCheck";
import { READER_TARGET_SCHEMA } from "../../../src/prompts/readerTarget";
import { parseReaderTargetReading } from "../../../src/core/readerTargetValidation";
import { PLOT_REVERSE_SCHEMA } from "../../../src/prompts/plotReverse";
import { WORK_CHAT_SCHEMA } from "../../../src/prompts/workChat";
import { SYNOPSIS_SCHEMA } from "../../../src/prompts/synopsis";
import { SETTINGS_KINDS } from "../../../src/core/settingsSummary";

/**
 * Claude の構造化出力が受け付けない形を、**全機能のスキーマで**見張る。
 *
 * 2026-10-10 01:54、相談（`WORK_CHAT_SCHEMA`）が
 * 「For 'anyOf', 'items' is not supported」で断られた。null 許容の配列
 * （`type: ["array","null"]` ＋ `items`）を anyOf に書き換えたとき、`items` が
 * anyOf の横に取り残されていた。製品はスキーマを外して通し、それを覚えたため、
 * 続く冒頭診断がスキーマ無しで呼ばれて答えの形がずれた。
 *
 * 制限の出どころは Anthropic の公式文書（構造化出力の「JSON Schema limitations」）：
 * - minLength / maxLength・minimum / maximum / multipleOf は非対応
 * - 配列の件数制約は minItems の 0 と 1 だけ
 * - object は additionalProperties: false が必須
 * - 省略可能な項目は全体で24まで、union（anyOf か type 配列）は全体で16まで
 */

const PROMPTS_DIR = path.resolve(__dirname, "../../../src/prompts");

/** 引数が要る組み立て関数に渡す、代表の引数 */
const BUILDER_ARGS: Record<string, unknown[][]> = {
  buildNotationAdviceSchema: [
    [
      {
        label: "良い ↔ よい",
        forms: [
          { surface: "良い", count: 3, excerpts: [] },
          { surface: "よい", count: 2, excerpts: [] },
        ],
      },
    ],
  ],
  buildEnrichSchema: SETTINGS_KINDS.map((kind) => [kind]),
};

async function collectSchemas(): Promise<Array<{ name: string; schema: unknown }>> {
  const found: Array<{ name: string; schema: unknown }> = [];
  const files = fs
    .readdirSync(PROMPTS_DIR)
    .filter((file) => file.endsWith(".ts"))
    .sort();
  for (const file of files) {
    const mod = (await import(
      pathToFileURL(path.join(PROMPTS_DIR, file)).href
    )) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (/_SCHEMA$/.test(name) && isRecord(value)) {
        found.push({ name: `${file}:${name}`, schema: value });
      } else if (/^build\w*Schema$/.test(name) && typeof value === "function") {
        const argSets = BUILDER_ARGS[name] ?? [[]];
        for (const args of argSets) {
          found.push({
            name: `${file}:${name}(${args.map((a) => (typeof a === "string" ? a : "…")).join(",")})`,
            schema: (value as (...a: unknown[]) => unknown)(...args),
          });
        }
      }
    }
  }
  return found;
}

/** anyOf の横に置いてよい語（注釈だけ） */
const ANYOF_SIBLINGS_OK = new Set(["anyOf", "description", "title", "default"]);
const UNSUPPORTED_KEYS = [
  "minLength",
  "maxLength",
  "maxItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
];

interface Inspection {
  problems: string[];
  unions: number;
}

/**
 * スキーマの木を歩いて、受け付けない形を集める。
 * `properties` の下は「項目名 → スキーマ」の表なので、表そのものは検査しない。
 */
function inspect(schema: unknown): Inspection {
  const problems: string[] = [];
  let unions = 0;
  const visit = (node: unknown, where: string): void => {
    if (!isRecord(node)) return;
    if (Array.isArray(node.type)) {
      problems.push(`${where}: type が配列のまま`);
    }
    if (Array.isArray(node.anyOf)) {
      unions += 1;
      const extra = Object.keys(node).filter((key) => !ANYOF_SIBLINGS_OK.has(key));
      if (extra.length > 0) {
        problems.push(`${where}: anyOf の横に ${extra.join("・")}`);
      }
      node.anyOf.forEach((branch, index) => visit(branch, `${where}.anyOf[${index}]`));
    }
    for (const key of UNSUPPORTED_KEYS) {
      if (key in node) problems.push(`${where}: ${key} が残っている`);
    }
    if ("minItems" in node && node.minItems !== 0 && node.minItems !== 1) {
      problems.push(`${where}: minItems=${String(node.minItems)}`);
    }
    if (node.type === "object" || node.properties !== undefined) {
      if (node.additionalProperties !== false) {
        problems.push(`${where}: additionalProperties が false でない`);
      }
      const keys = isRecord(node.properties) ? Object.keys(node.properties) : [];
      const required = Array.isArray(node.required) ? node.required : [];
      const optional = keys.filter((key) => !required.includes(key));
      if (optional.length > 0) {
        problems.push(`${where}: 必須でない項目 ${optional.join("・")}`);
      }
    }
    if (isRecord(node.properties)) {
      for (const [key, child] of Object.entries(node.properties)) {
        visit(child, `${where}.${key}`);
      }
    }
    if (node.items !== undefined) visit(node.items, `${where}[]`);
  };
  visit(schema, "$");
  return { problems, unions };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("Claude 向けのスキーマ変換：null 許容の配列・object", () => {
  test("null 許容の配列は items を配列の枝の中へ入れる（anyOf の横に残さない）", () => {
    // 実際に断られた形の再現。相談のスキーマの options
    const converted = toClaudeJsonSchema({
      type: ["array", "null"],
      items: { type: "string" },
      description: "選択肢",
    }) as Record<string, unknown>;

    expect(converted).toEqual({
      description: "選択肢",
      anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
    });
  });

  test("null 許容の object は properties・required・additionalProperties を枝の中へ入れる", () => {
    const converted = toClaudeJsonSchema({
      type: ["object", "null"],
      properties: {
        target: { type: "string" },
        label: { type: ["string", "null"] },
      },
      required: ["target"],
    }) as Record<string, unknown>;

    expect(converted).toEqual({
      anyOf: [
        {
          type: "object",
          properties: {
            target: { type: "string" },
            label: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          // 省略可能な項目の上限（24）があるので、Claude 向けはすべて必須にする
          required: ["target", "label"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    });
  });

  test("null 許容の文字列の enum は、文字列の枝へ入れて null を外す", () => {
    const converted = toClaudeJsonSchema({
      type: ["string", "null"],
      enum: ["a", "b", null],
    }) as Record<string, unknown>;

    expect(converted).toEqual({
      anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }],
    });
  });

  test.each([
    ["相談（WORK_CHAT_SCHEMA）", WORK_CHAT_SCHEMA],
    ["プロット逆算（PLOT_REVERSE_SCHEMA）", PLOT_REVERSE_SCHEMA],
    ["あらすじ（SYNOPSIS_SCHEMA）", SYNOPSIS_SCHEMA],
  ])("%s を変換しても anyOf の横に型の語が残らない", (_label, schema) => {
    expect(inspect(toClaudeJsonSchema(schema)).problems).toEqual([]);
  });
});

describe("Claude 向けのスキーマ変換：全機能のスキーマ", () => {
  test("src/prompts のスキーマを1つ残らず拾えている", async () => {
    const schemas = await collectSchemas();
    // 拾い損ねて0件で通る見張りにしない
    expect(schemas.length).toBeGreaterThanOrEqual(40);
  });

  test("どのスキーマも、Claude が受け付けない形を含まない", async () => {
    const schemas = await collectSchemas();
    const failures = schemas
      .map(({ name, schema }) => ({
        name,
        problems: inspect(toClaudeJsonSchema(schema)).problems,
      }))
      .filter((entry) => entry.problems.length > 0);

    expect(failures).toEqual([]);
  });

  test("union（anyOf）の数が Anthropic の上限（16）を超えるスキーマの一覧", async () => {
    // **上限を超えているものは、いまは記録として持つ**（直し方は null の扱いを
    // 変える設計判断になるので、変換では直さない）。一覧が変わったら
    // ここが落ちて気づける——増えたら、そのスキーマは Claude で弾かれる見込み
    const schemas = await collectSchemas();
    const over = schemas
      .map(({ name, schema }) => ({
        name,
        unions: inspect(toClaudeJsonSchema(schema)).unions,
      }))
      .filter((entry) => entry.unions > 16)
      .map((entry) => `${entry.name}=${entry.unions}`);

    expect(over).toEqual(KNOWN_OVER_UNION_LIMIT);
  });
});

/**
 * union の上限（16）を超えているスキーマ。実測（2026-10-10）。
 *
 * **この2つが実際に Claude で断られるかは、まだ撃って確かめていない**
 * （公式の表は「strict なスキーマ全体で16」と書くが、出力のスキーマにも
 * 数えるのかは明記が無い）。断られても、スキーマの記憶はスキーマ単位なので
 * ほかの機能は巻き込まない。直すなら null 許容の扱いを変える設計判断になる。
 */
const KNOWN_OVER_UNION_LIMIT: string[] = [
  "characterExtract.ts:CHARACTER_EXTRACT_SCHEMA=33",
  "workChat.ts:WORK_CHAT_SCHEMA=19",
];

describe("スキーマ受理の覚え方（モデル×スキーマ）", () => {
  test("同じスキーマなら同じ指紋、違うスキーマなら違う指紋", () => {
    const a = claudeSchemaFingerprint(WORK_CHAT_SCHEMA);
    expect(claudeSchemaFingerprint(WORK_CHAT_SCHEMA)).toBe(a);
    expect(claudeSchemaFingerprint(PLOT_REVERSE_SCHEMA)).not.toBe(a);
  });

  test("相談のスキーマを外して通っても、冒頭診断のスキーマは外さない", () => {
    // 2026-10-10 01:54〜01:56 の再現。相談で「スキーマを外すと通った」を覚えた
    // あとの冒頭診断が、スキーマ無しで呼ばれて答えの形がずれた
    const chat = claudeSchemaFingerprint(WORK_CHAT_SCHEMA);
    const opening = claudeSchemaFingerprint(OPENING_CHECK_SCHEMA);
    const afterChat = rememberedSupport(
      normalizeStoredSupport(undefined),
      { effort: true, thinking: true, jsonSchema: false },
      chat
    );

    expect(afterChat.rejectedSchemas).toEqual([chat]);
    expect(afterChat.rejectedSchemas).not.toContain(opening);
    // effort・思考はモデル単位のまま
    expect(afterChat.effort).toBe(true);
    expect(afterChat.thinking).toBe(true);
  });

  test("相談のスキーマを外して通っても、ターゲット読者のスキーマは外さない", () => {
    // 2026-10-10 02:09 の再現。読者像の読み取りがスキーマ無しで呼ばれ、
    // 「軸が1つも返りませんでした」で止まった（プロンプトは axes などの鍵を書かず、
    // 形を伝えているのはスキーマだけ）
    const afterChat = rememberedSupport(
      normalizeStoredSupport(undefined),
      { effort: true, thinking: true, jsonSchema: false },
      claudeSchemaFingerprint(WORK_CHAT_SCHEMA)
    );
    expect(afterChat.rejectedSchemas).not.toContain(
      claudeSchemaFingerprint(READER_TARGET_SCHEMA)
    );
    // 読者像のスキーマそのものも、Claude が受け付けない形を含まない
    expect(inspect(toClaudeJsonSchema(READER_TARGET_SCHEMA)).problems).toEqual([]);
  });

  test("スキーマが外れて形がずれると、読者像の検算は軸を1つも拾えない（スキーマを外せない機能である）", () => {
    // 外した回に返りうる、鍵の違う答え
    const reading = parseReaderTargetReading(
      { familiarity: { score: 4 }, posture: { score: 2 }, craving: { score: 3 } },
      "冒頭の本文"
    );
    expect(reading.notes).toContain("軸が1つも返りませんでした。");
  });

  test("付けたまま通ったら、そのスキーマの「通らない」を取り消す", () => {
    const chat = claudeSchemaFingerprint(WORK_CHAT_SCHEMA);
    const next = rememberedSupport(
      { effort: true, thinking: true, rejectedSchemas: [chat, "other"] },
      { effort: true, thinking: true, jsonSchema: true },
      chat
    );
    expect(next.rejectedSchemas).toEqual(["other"]);
  });

  test("スキーマを送らなかった回は、スキーマの記録を動かさない", () => {
    const next = rememberedSupport(
      { effort: true, thinking: true, rejectedSchemas: ["a"] },
      { effort: false, thinking: true, jsonSchema: true },
      undefined
    );
    expect(next).toEqual({ effort: false, thinking: true, rejectedSchemas: ["a"] });
  });

  test("古い形（モデル単位の jsonSchema）は読まない", () => {
    // v5 の記録がもし読まれても、スキーマ全部を外す判定にはしない
    expect(
      normalizeStoredSupport({ effort: true, thinking: false, jsonSchema: false })
    ).toEqual({ effort: true, thinking: false, rejectedSchemas: [] });
  });
});

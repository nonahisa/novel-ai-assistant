import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { DEFAULT_TIMEOUT_SECONDS } from "../../../src/core/modelTuning";

/**
 * AIの1回の呼び出しで待つ秒数の既定（作者の裁定 2026-10-26「300秒に揃える」。設計書6.48）。
 *
 * それまでは Ollama・LM Studio・Claude が300秒、ChatGPT・Gemini・さくらが180秒で、
 * さらに Ollama と LM Studio はコード側の既定（180）が package.json（300）と食い違っていた。
 * 設定が宣言されていれば VS Code が package.json の既定を返すので実行時には表に出ないが、
 * 宣言の無い場面（試験・MCP の束）でだけ待ち時間が変わる。3か所を1つの値で縛る。
 */
const PROVIDERS = ["ollama", "lmstudio", "claude", "openai", "gemini", "sakura"] as const;

function readRepoFile(relative: string): string {
  return readFileSync(new URL(`../../../${relative}`, import.meta.url), "utf8");
}

interface SettingDeclaration {
  default?: unknown;
}

function declaredSettings(): Record<string, SettingDeclaration> {
  const manifest = JSON.parse(readRepoFile("package.json")) as {
    contributes: {
      configuration:
        | { properties: Record<string, SettingDeclaration> }
        | Array<{ properties: Record<string, SettingDeclaration> }>;
    };
  };
  const sections = Array.isArray(manifest.contributes.configuration)
    ? manifest.contributes.configuration
    : [manifest.contributes.configuration];
  return Object.assign({}, ...sections.map((section) => section.properties));
}

describe("AIの待ち時間の既定は全プロバイダ300秒", () => {
  test("既定の定数は300秒", () => {
    expect(DEFAULT_TIMEOUT_SECONDS).toBe(300);
  });

  test.each(PROVIDERS)("package.json の novelai.%s.timeoutSeconds の既定が定数と同じ", (id) => {
    const setting = declaredSettings()[`novelai.${id}.timeoutSeconds`];
    expect(setting, `novelai.${id}.timeoutSeconds が宣言されていない`).toBeDefined();
    expect(setting.default).toBe(DEFAULT_TIMEOUT_SECONDS);
  });

  test.each(PROVIDERS)("%s のプロバイダは、既定を数で書かず定数を渡す", (id) => {
    const source = readRepoFile(`src/ai/${id}Provider.ts`);
    const calls = source.match(/resolveTimeoutMs\([^)]*\)/gu) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toContain("DEFAULT_TIMEOUT_SECONDS");
    }
  });
});

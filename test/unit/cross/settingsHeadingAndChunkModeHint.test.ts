import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * 設定画面（Ctrl+,）に出る見出しと、英語の設定名に添えた日本語の言い方
 * （実機確認リスト 0.122.0 の 371 行の「設定画面の見出し」と 375 行を機械へ移した。作者の判断 2026-11-02）。
 *
 * - 拡張機能の設定の見出し（`contributes.configuration.title`）が製品名「統合小説執筆環境」
 * - 「Chunk Chars」「Merge Chunk Chars」の説明に出てくる英語の設定名「Chunk Size Mode」に、
 *   日本語の言い方「（1回に送る量の決め方）」が添えてある。設定画面は英語の設定名を見出しに出すので、
 *   説明の中で別の設定を英語の名前だけで呼ぶと、作者にはどの設定のことか分からない
 *
 * 設定画面は package.json のこの値をそのまま描く（拡張機能の側で組み立てない）ので、ここを見れば足りる。
 * 画面での読みやすさは作者の手に残す。
 */

interface ConfigurationProperty {
  description?: string;
  markdownDescription?: string;
}

interface Configuration {
  title?: string;
  properties?: Record<string, ConfigurationProperty>;
}

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
  contributes: { configuration: Configuration | Configuration[] };
};
const configurations = Array.isArray(manifest.contributes.configuration)
  ? manifest.contributes.configuration
  : [manifest.contributes.configuration];

function descriptionOf(key: string): string {
  for (const configuration of configurations) {
    const property = configuration.properties?.[key];
    if (property) return property.markdownDescription ?? property.description ?? "";
  }
  throw new Error(`package.json に設定 ${key} がありません`);
}

describe("設定画面の見出しと説明", () => {
  test("拡張機能の設定の見出しは「統合小説執筆環境」", () => {
    expect(configurations.map((configuration) => configuration.title)).toEqual(["統合小説執筆環境"]);
  });

  test("「Chunk Chars」「Merge Chunk Chars」の説明は「Chunk Size Mode」に日本語の言い方を添えて呼ぶ", () => {
    for (const key of ["novelai.chunkChars", "novelai.mergeChunkChars"]) {
      const text = descriptionOf(key);
      expect(text, `${key} の説明`).toContain("「Chunk Size Mode」（1回に送る量の決め方）");
    }
  });

  test("説明の中で「Chunk Size Mode」を言い方を添えずに呼んでいる設定が無い", () => {
    const bare: string[] = [];
    for (const configuration of configurations) {
      for (const [key, property] of Object.entries(configuration.properties ?? {})) {
        const text = property.markdownDescription ?? property.description ?? "";
        const mentions = text.split("Chunk Size Mode").length - 1;
        const explained = text.split("「Chunk Size Mode」（1回に送る量の決め方）").length - 1;
        if (mentions > explained) bare.push(key);
      }
    }
    expect(bare).toEqual([]);
  });
});

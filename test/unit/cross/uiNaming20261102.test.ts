import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findAction } from "../../../src/core/actionTree";

/**
 * 画面に出る呼び名をそろえる（使いにくい所の洗い出し2回目。作者の判断 2026-11-02）。
 *
 * 同じものが場所によって別の名前で出ると、作者は別のものだと思って探す。
 * ID と保存されている値は変えない（名前だけ）。
 */
const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "../../../package.json"), "utf8")
) as {
  contributes: {
    commands: { command: string; title: string; category?: string }[];
    configuration: { title: string; properties: Record<string, { description?: string; markdownDescription?: string }> };
  };
};
const titleOf = (command: string): string | undefined =>
  manifest.contributes.commands.find((entry) => entry.command === command)?.title;

describe("呼び名をそろえる", () => {
  test("能力：命令の題にも詳細メニューにも「スキル」を使わない", () => {
    expect(titleOf("novelai.extractAbilitiesOnly")).toBe("能力抽出");
    expect(findAction("novelai.extractAbilitiesOnly")?.label).toBe("能力抽出");
    for (const entry of manifest.contributes.commands) {
      expect(entry.title, entry.command).not.toContain("スキル");
    }
  });

  test("素のエディターの右クリックは「原稿エディターで開く」", () => {
    expect(titleOf("novelai.openVertical")).toBe("原稿エディターで開く");
    expect(
      manifest.contributes.configuration.properties["novelai.manuscriptEditor.vertical"]
        ?.description
    ).not.toContain("縦書き表示");
  });

  test("製品名：設定画面の見出しと命令の頭は「統合小説執筆環境」", () => {
    expect(manifest.contributes.configuration.title).toBe("統合小説執筆環境");
    for (const entry of manifest.contributes.commands) {
      if (entry.category === undefined) continue;
      expect(entry.category, entry.command).toBe("統合小説執筆環境");
    }
  });

  test("相談の入口は「AIに相談」で始まる", () => {
    expect(titleOf("novelai.openChat")).toBe("AIに相談");
    expect(titleOf("novelai.openChatPanel")).toBe("AIに相談（大きく開く）");
  });

  test("設定の説明に英語の見出しだけを書かない（日本語の言い方を併記する）", () => {
    for (const key of ["novelai.mergeChunkChars", "novelai.chunkChars"]) {
      const text = manifest.contributes.configuration.properties[key]?.markdownDescription ?? "";
      if (!text.includes("Chunk Size Mode")) continue;
      expect(text, key).toMatch(/Chunk Size Mode」?（[^）]+）/);
    }
  });
});

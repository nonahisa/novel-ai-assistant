import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SETTINGS_DOC_CHOICES } from "../../../src/core/settingsDocChoices";

/**
 * 種類ごとの「一覧を生成」4つ（人物・場所・能力・世界観）を、「設定資料集出力」の
 * 中で種類を選ぶ形にまとめる。組織も選べるようにする（作者の判断 2026-11-02。
 * 洗い出し2回目の9）。
 *
 * パレットに「人物一覧を生成」「場所一覧を生成」…と「設定資料集出力」が並び、
 * どれを押せばよいか分からなかった。しかも組織だけ入口が無かった。
 */
const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "../../../package.json"), "utf8")
) as {
  contributes: {
    commands: { command: string; title: string }[];
    menus: Record<string, { command: string; when?: string }[]>;
  };
};

const FOUR = [
  "novelai.generateCharacterDocs",
  "novelai.generateLocationDocs",
  "novelai.generateAbilityDocs",
  "novelai.generateWorldDocs",
];

describe("設定資料集出力で種類を選ぶ", () => {
  test("先頭は「すべて」（Enter だけで今までどおり全部を書き出す）", () => {
    expect(SETTINGS_DOC_CHOICES[0].label).toBe("すべて");
    expect(SETTINGS_DOC_CHOICES[0].kinds).toBeUndefined();
  });

  test("人物・場所・能力・組織・世界観・各話あらすじを1つずつ選べる（組織を含む）", () => {
    expect(
      SETTINGS_DOC_CHOICES.slice(1).map((choice) => [choice.label, choice.kinds])
    ).toEqual([
      ["人物", ["characters"]],
      ["場所", ["locations"]],
      ["能力", ["abilities"]],
      ["組織", ["organizations"]],
      ["世界観", ["world"]],
      ["各話あらすじ", ["synopses"]],
    ]);
  });

  test("種類ごとの4つは、パレットから外し、命令は残す", () => {
    const declared = new Set(manifest.contributes.commands.map((c) => c.command));
    const palette = manifest.contributes.menus.commandPalette;
    for (const command of FOUR) {
      expect(declared.has(command), command).toBe(true);
      expect(
        palette.find((entry) => entry.command === command)?.when,
        command
      ).toBe("false");
    }
  });
});

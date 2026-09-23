import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { COMMAND_FORWARDS } from "../../../src/core/commandForwards";

/**
 * 転送だけをする旧コマンド（作者の裁定、2026-09-23「ターゲットシートと
 * 3つの輪は完全統合。読者診断はそのままでいい」）。
 *
 * 見るのは3つ。
 *
 * 1. 旧「ターゲットシート」「3つの輪」は「ターゲット読者」へ転送する
 * 2. **「ターゲット読者診断」は転送しない**（そのまま残すと裁定された）
 * 3. コマンドパレットの名前で、**押すと別の入口が開くと分かる**
 *    （名前だけ見て押した作者が、別の画面が開いて戸惑わないように）
 */

interface CommandContribution {
  command: string;
  title: string;
}

const commands = (
  JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
  ) as { contributes: { commands: CommandContribution[] } }
).contributes.commands;

function titleOf(command: string): string | undefined {
  return commands.find((entry) => entry.command === command)?.title;
}

describe("旧コマンドの転送", () => {
  test("ターゲットシートと3つの輪は、ターゲット読者へ転送する", () => {
    const map = new Map(COMMAND_FORWARDS.map((entry) => [entry.from, entry.to]));
    expect(map.get("novelai.openTargetSheet")).toBe("novelai.openTargetReader");
    expect(map.get("novelai.showThreeCircles")).toBe("novelai.openTargetReader");
  });

  test("ターゲット読者診断は転送しない（そのまま残す）", () => {
    expect(
      COMMAND_FORWARDS.some(
        (entry) => entry.from === "novelai.runReaderTargetDiagnosis"
      )
    ).toBe(false);
  });

  test("転送元も転送先も package.json に実在する", () => {
    for (const entry of COMMAND_FORWARDS) {
      expect(titleOf(entry.from), entry.from).toBeDefined();
      expect(titleOf(entry.to), entry.to).toBeDefined();
    }
  });

  test("転送元の名前に、開く先の名前が「（〜へ）」で入っている", () => {
    for (const entry of COMMAND_FORWARDS) {
      const to = titleOf(entry.to) ?? "";
      expect(titleOf(entry.from), entry.from).toContain(`（${to}へ）`);
    }
  });
});

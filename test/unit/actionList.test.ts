import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  ACTION_GROUPS,
  groupedActions,
  visibleActions,
} from "../../src/views/actionList";

interface PackageManifest {
  contributes: { commands: Array<{ command: string }> };
}

describe("操作メニューの分類", () => {
  test("決めた順に分類を並べる", () => {
    // 作業の流れで並べる。実装単位ではない
    expect(groupedActions(true).map((entry) => entry.group)).toEqual([
      ...ACTION_GROUPS,
    ]);
  });

  test("すべての操作がどれかの分類に入る", () => {
    const grouped = groupedActions(true).flatMap((entry) => entry.actions);

    expect(grouped).toHaveLength(visibleActions(true).length);
  });

  test("中身が無い分類は出さない", () => {
    // 作品未登録では「資料」「整える」「書き出す」が空になる
    const groups = groupedActions(false).map((entry) => entry.group);

    expect(groups).toEqual(["AI設定", "困ったとき"]);
    expect(groupedActions(false).every((entry) => entry.actions.length > 0)).toBe(
      true
    );
  });
});

describe("操作メニューの一覧", () => {
  test("作品が未登録なら作品向けの操作を出さない", () => {
    // 押しても「作品が登録されていません」と言われるだけの項目は、
    // 押せない理由が作者に伝わらないので最初から並べない
    const commands = visibleActions(false).map((action) => action.command);

    expect(commands).not.toContain("novelai.extractSettings");
    expect(commands).not.toContain("novelai.generateSettingsDocs");
    expect(commands).not.toContain("novelai.showWorkStats");
  });

  test("作品が未登録でもAIの設定は出す", () => {
    // 作品を登録する前にAIを設定しておける
    const commands = visibleActions(false).map((action) => action.command);

    expect(commands).toContain("novelai.setupAI");
    expect(commands).toContain("novelai.testAI");
  });

  test("作品があれば全部の操作を出す", () => {
    expect(visibleActions(true).length).toBeGreaterThan(
      visibleActions(false).length
    );
    expect(visibleActions(true).map((action) => action.command)).toContain(
      "novelai.extractSettings"
    );
  });

  test("コマンドIDが重複していない", () => {
    const commands = visibleActions(true).map((action) => action.command);

    expect(new Set(commands).size).toBe(commands.length);
  });

  test("並べた操作はすべてpackage.jsonに登録されている", () => {
    // 一覧はコマンドIDを文字列で持つため、コマンドを改名すると
    // 何も起きないボタンが残る。実際に改名して壊した経験があるので固定する
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8")
    ) as PackageManifest;
    const declared = new Set(
      manifest.contributes.commands.map((entry) => entry.command)
    );

    for (const action of visibleActions(true)) {
      expect(declared, `${action.command} が package.json にない`).toContain(
        action.command
      );
    }
  });
});

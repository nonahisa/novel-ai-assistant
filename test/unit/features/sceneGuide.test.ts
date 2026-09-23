import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { window } from "vscode";
import { PROCEDURES } from "../../../src/core/procedures";
import { startTour } from "../../../src/core/guidedTour";
import { procedureActionLookup } from "../../../src/features/featureGuide";
import {
  pickScene,
  SCENE_GUIDE_COMMAND,
  SCENE_GUIDE_LABEL,
  sceneChoices,
  sceneQuickPickItems,
} from "../../../src/features/sceneGuide";
import {
  ACTION_TREE,
  allActions,
  findAction,
  REQUIRES_WORK_HINT,
} from "../../../src/views/actionList";
import { STEP_MENU } from "../../../src/views/stepMenu";
import { buildUserManual } from "../../../src/features/openManual";

/**
 * 場面別案内（作者の依頼、2026-09-23「利用シーンごとのチュートリアルが欲しい」）。
 *
 * 相談の「画面で案内してもらう」と**同じ手順書き・同じ案内の仕組み**を、
 * ヘルプから直接選べるようにしたもの。ここで守るのは3つ。
 *
 * 1. メニュー（詳細・簡単ステップ・コマンドパレット）に出る
 * 2. 手順書きの全部が選べて、作品が要る場面と要らない場面が分かれる
 * 3. 案内の中に出る名前が、いまのメニューの名前と一致している
 */

const manifest = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
) as { contributes: { commands: Array<{ command: string; title: string }> } };

const originalQuickPick = window.showQuickPick;
const originalInfo = window.showInformationMessage;

afterEach(() => {
  window.showQuickPick = originalQuickPick;
  window.showInformationMessage = originalInfo;
});

describe("メニューに出る", () => {
  test("詳細メニューの「ヘルプ」で、使い方のすぐ下にある", () => {
    const help = ACTION_TREE.find((group) => group.label === "ヘルプ");
    const commands = (help?.entries ?? []).map((entry) =>
      entry.kind === "action" ? entry.command : entry.label
    );
    const manual = commands.indexOf("novelai.openManual");
    expect(commands[manual + 1]).toBe(SCENE_GUIDE_COMMAND);

    const item = findAction(SCENE_GUIDE_COMMAND);
    expect(item?.label).toBe(SCENE_GUIDE_LABEL);
    // 場面を選ぶ画面は、作品が無くても開ける（作品が要るかは場面ごとに分ける）
    expect(item?.requiresWork).toBe(false);
    expect(item?.hiddenFromActionList).toBeFalsy();
  });

  test("名前は短い体言止め（コマンドパレットでも同じ名前）", () => {
    expect(SCENE_GUIDE_LABEL).toBe("場面別案内");
    const declared = manifest.contributes.commands.find(
      (entry) => entry.command === SCENE_GUIDE_COMMAND
    );
    expect(declared?.title).toBe(SCENE_GUIDE_LABEL);
  });

  test("簡単ステップメニューの「ヘルプ」にも、使い方のすぐ下に出る", () => {
    const help = STEP_MENU[STEP_MENU.length - 1];
    const commands = help.entries.map((entry) =>
      entry.kind === "action" ? entry.command : entry.label
    );
    const manual = commands.indexOf("novelai.openManual");
    expect(commands[manual + 1]).toBe(SCENE_GUIDE_COMMAND);
  });

  test("使い方の文書から、場面別案内への入口がある", () => {
    expect(buildUserManual()).toContain(`ヘルプ → ${SCENE_GUIDE_LABEL}`);
  });
});

describe("場面を選ぶ", () => {
  test("手順書きの全部が、同じ順で選べる", () => {
    const choices = sceneChoices();
    expect(choices.map((choice) => choice.key)).toEqual(
      PROCEDURES.map((procedure) => procedure.key)
    );
    expect(choices).toHaveLength(7);
    for (const choice of choices) {
      const procedure = PROCEDURES.find((entry) => entry.key === choice.key);
      // 段が1つも欠けずに案内できる（欠けると、画面に無い段を飛ばした案内になる）
      expect(choice.steps, choice.key).toBe(procedure?.steps.length);
      expect(choice.title).toBe(procedure?.title);
    }
  });

  test("作品を作る・登録する場面だけは、作品が無くても始められる", () => {
    const needsWork = Object.fromEntries(
      sceneChoices().map((choice) => [choice.key, choice.needsWork])
    );
    expect(needsWork).toEqual({
      newWork: false,
      importWork: false,
      polish: true,
      consistency: true,
      posting: true,
      readerTarget: true,
      targetSheet: true,
    });
  });

  test("作品が無いときは、作品が要る場面に理由を添える（消さない）", () => {
    const withoutWork = sceneQuickPickItems(sceneChoices(), false);
    expect(withoutWork).toHaveLength(7);
    for (const item of withoutWork) {
      const expected = item.choice.needsWork;
      expect(item.description.includes(REQUIRES_WORK_HINT), item.label).toBe(
        expected
      );
    }
    const withWork = sceneQuickPickItems(sceneChoices(), true);
    expect(
      withWork.some((item) => item.description.includes(REQUIRES_WORK_HINT))
    ).toBe(false);
  });

  test("選んだ場面の鍵を返す", async () => {
    window.showQuickPick = (async (items: unknown) =>
      (items as Array<{ choice?: { key: string } }>).find(
        (item) => item.choice?.key === "polish"
      )) as typeof window.showQuickPick;
    expect(await pickScene(true)).toBe("polish");
  });

  test("作品が無いのに作品が要る場面を選んだら、始めずに理由と次の手を出す", async () => {
    window.showQuickPick = (async (items: unknown) =>
      (items as Array<{ choice?: { key: string } }>).find(
        (item) => item.choice?.key === "polish"
      )) as typeof window.showQuickPick;
    const shown: string[] = [];
    window.showInformationMessage = (async (message: string) => {
      shown.push(message);
      return undefined;
    }) as typeof window.showInformationMessage;

    expect(await pickScene(false)).toBeUndefined();
    expect(shown.join("\n")).toContain(REQUIRES_WORK_HINT);
  });

  test("理由の窓から、作品を用意する場面へ移れる", async () => {
    window.showQuickPick = (async (items: unknown) =>
      (items as Array<{ choice?: { key: string } }>).find(
        (item) => item.choice?.key === "consistency"
      )) as typeof window.showQuickPick;
    window.showInformationMessage = (async (
      _message: string,
      ...buttons: unknown[]
    ) => buttons.find((button) => button === "書いてある作品を登録して整える")) as typeof window.showInformationMessage;

    expect(await pickScene(false)).toBe("importWork");
  });

  test("何も選ばずに閉じたら、何も始めない", async () => {
    window.showQuickPick = (async () => undefined) as typeof window.showQuickPick;
    expect(await pickScene(true)).toBeUndefined();
  });
});

describe("案内の中の名前が、いまのメニューの名前と一致する", () => {
  test("各段の名前は、詳細メニューの名前そのもの", () => {
    for (const procedure of PROCEDURES) {
      const tour = startTour(procedure, procedureActionLookup);
      expect(tour?.steps.map((step) => step.command), procedure.key).toEqual(
        procedure.steps.map((step) => step.command)
      );
      for (const step of tour?.steps ?? []) {
        expect(step.label, step.command).toBe(findAction(step.command)?.label);
      }
    }
  });

  test("文の中で「」に入れて引いている名前は、いまあるメニュー名だけ", () => {
    // メニュー名ではない語（ターゲットシートの欄の名前）。**増やすときは
    // メニュー名でないことを確かめる**——改名で古くなった名前をここへ逃がさない
    const notMenuNames = new Set(["狙い"]);
    const labels = new Set(allActions().map((item) => item.label));
    const stale: string[] = [];
    for (const procedure of PROCEDURES) {
      const texts = [
        procedure.title,
        procedure.whenToRead,
        ...procedure.steps.flatMap((step) => [step.why, step.check]),
      ];
      for (const text of texts) {
        for (const match of text.matchAll(/「([^」]+)」/g)) {
          const quoted = match[1];
          if (!labels.has(quoted) && !notMenuNames.has(quoted)) {
            stale.push(`${procedure.key}: 「${quoted}」`);
          }
        }
      }
    }
    expect(stale).toEqual([]);
  });
});

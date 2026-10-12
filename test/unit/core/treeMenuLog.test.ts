import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  describeTreeMenuCall,
  treeMenuCommandsFrom,
} from "../../../src/core/treeMenuLog";

/**
 * 作品一覧の右クリックの品書きから来た命令を、操作ログへ1行残す（0.105.2）。
 *
 * 遅い機械で、品書きを押したのに何も起きない・「作品を選択」が出る、が
 * 続いた（2026-10-12）。押下が命令まで届いたのか、届いたが行が渡らなかったのか、
 * そもそも届かなかったのかを、あとからログで分けられるようにする。
 * **本文も作品名もファイル名も書かない**——行の種類だけで足りる。
 */

const packageJson = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
) as unknown;

describe("treeMenuCommandsFrom", () => {
  test("作品一覧の右クリックの品書きに並ぶ命令を拾う（今回空振りした3つを含む）", () => {
    const commands = treeMenuCommandsFrom(packageJson, "novelai.works");

    expect(commands.has("novelai.openPlotMode")).toBe(true);
    // 話の行の「ここから章を始める」「この話の前に挿入」
    const menus = (packageJson as {
      contributes: { menus: Record<string, { command: string; when?: string }[]> };
    }).contributes.menus["view/item/context"];
    for (const entry of menus) {
      if (/view == novelai\.works\b/.test(entry.when ?? "")) {
        expect(commands.has(entry.command), entry.command).toBe(true);
      }
    }
  });

  test("ほかの一覧（詳細メニューなど）の品書きは拾わない", () => {
    const commands = treeMenuCommandsFrom({
      contributes: {
        menus: {
          "view/item/context": [
            { command: "a.works", when: "view == novelai.works && viewItem == work" },
            { command: "a.actions", when: "view == novelai.actions" },
            { command: "a.worksX", when: "view == novelai.worksX" },
          ],
        },
      },
    }, "novelai.works");

    expect([...commands]).toEqual(["a.works"]);
  });

  test("形の違う値でも落ちず、空を返す", () => {
    expect(treeMenuCommandsFrom(undefined, "novelai.works").size).toBe(0);
    expect(treeMenuCommandsFrom({ contributes: {} }, "novelai.works").size).toBe(0);
  });
});

describe("describeTreeMenuCall", () => {
  test("行が渡れば、行の種類だけを書く（作品名・ファイル名は書かない）", () => {
    const line = describeTreeMenuCall("novelai.openPlotMode", {
      type: "work",
      work: { id: "w1", title: "秘密の題", folderPath: "C:/秘密の場所" },
    });

    expect(line).toContain("novelai.openPlotMode");
    expect(line).toContain("作品の行");
    expect(line).not.toContain("秘密");
  });

  test("話の行", () => {
    expect(
      describeTreeMenuCall("novelai.insertEpisodeBefore", {
        type: "episode",
        episode: { fileName: "第2話_秘密.txt" },
      })
    ).toContain("話の行");
  });

  test("行が渡らなければ「行なし」と書く（undefined も null も）", () => {
    expect(describeTreeMenuCall("novelai.openPlotMode", undefined)).toContain("行なし");
    expect(describeTreeMenuCall("novelai.openPlotMode", null)).toContain("行なし");
  });

  test("行でない値（コマンドパレットや別の画面から渡された値）はそうと書く", () => {
    expect(describeTreeMenuCall("novelai.openPlotMode", "文字")).toContain("行以外");
    expect(describeTreeMenuCall("novelai.openPlotMode", { type: "なにか" })).toContain("行以外");
  });
});

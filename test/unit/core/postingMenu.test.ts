import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  POSTING_MENU_COMMAND,
  POSTING_MENU_ENTRIES,
} from "../../../src/core/postingMenu";

/**
 * 作品の右クリックの投稿まわり6つを「投稿と読者の反応…」1つにまとめる
 * （作者の判断 2026-11-02。洗い出し2回目の7）。
 *
 * 右クリックの品書きが長く、執筆の操作と投稿の操作が同じ段に並んでいた。
 * 入口を1つにし、押すと中の6つを選ぶ。**6つの命令は残す**——コマンドパレット・
 * 詳細メニュー・相談から今までどおり呼ぶ。
 */

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "../../../package.json"), "utf8")
) as {
  contributes: {
    commands: { command: string; title: string }[];
    menus: Record<string, { command: string; when?: string; group?: string }[]>;
  };
};

const SIX = [
  "novelai.postNewEpisode",
  "novelai.configurePostingSites",
  "novelai.recordRanking",
  "novelai.importReaderStats",
  "novelai.recordReaderStats",
  "novelai.setWorkCompletion",
];

describe("投稿と読者の反応の入口", () => {
  const items = manifest.contributes.menus["view/item/context"];

  test("中に並ぶのは投稿まわりの6つ（順も作者が見慣れた右クリックの順）", () => {
    expect(POSTING_MENU_ENTRIES.map((entry) => entry.command)).toEqual(SIX);
  });

  test("中の名前は、それぞれの命令の題と同じ", () => {
    for (const entry of POSTING_MENU_ENTRIES) {
      const title = manifest.contributes.commands.find(
        (command) => command.command === entry.command
      )?.title;
      expect(entry.label, entry.command).toBe(title);
      expect(entry.description.length, entry.command).toBeGreaterThan(0);
    }
  });

  test("作品の右クリックには入口1つだけが並び、6つは並ばない", () => {
    const onWork = items.filter((entry) => /\^work-/.test(entry.when ?? ""));
    for (const command of SIX) {
      expect(
        onWork.some((entry) => entry.command === command),
        `${command} が作品の右クリックに残っている`
      ).toBe(false);
    }
    const hub = onWork.filter((entry) => entry.command === POSTING_MENU_COMMAND);
    expect(hub).toHaveLength(1);
    // 6つと同じ条件で出す（どの種類の作品にも出ていた）
    expect(hub[0].when).toBe("view == novelai.works && viewItem =~ /^work-/");
  });

  test("入口の題は「投稿と読者の反応…」", () => {
    expect(
      manifest.contributes.commands.find(
        (command) => command.command === POSTING_MENU_COMMAND
      )?.title
    ).toBe("投稿と読者の反応…");
  });

  test("6つの命令は残り、パレットから外していない", () => {
    const declared = new Set(manifest.contributes.commands.map((c) => c.command));
    const hiddenInPalette = new Set(
      (manifest.contributes.menus.commandPalette ?? [])
        .filter((entry) => entry.when === "false")
        .map((entry) => entry.command)
    );
    for (const command of SIX) {
      expect(declared.has(command), command).toBe(true);
      expect(hiddenInPalette.has(command), command).toBe(false);
    }
  });
});

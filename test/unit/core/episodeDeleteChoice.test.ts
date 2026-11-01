import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canRenumberOnDelete,
  EPISODE_DELETE_CHOICES,
  RENUMBERABLE_EPISODE_CONTEXT,
  routeOfDeleteAnswer,
} from "../../../src/core/episodeDeleteChoice";
import { workTypeContextValue } from "../../../src/core/workTypeVisibility";

/**
 * 話の右クリックの「ファイルを削除」と「この話を削除（話数を詰める）」を、
 * 「この話を削除」1つにする（作者の判断 2026-11-02。洗い出し2回目の4）。
 *
 * 2つ並ぶと、作者はどちらを押せばよいか迷う（どちらも消す）。押してから
 * 「話数を詰める／詰めない（ファイルだけ消す）」を訊く。
 */

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "../../../package.json"), "utf8")
) as {
  contributes: {
    commands: { command: string; title: string }[];
    menus: Record<string, { command: string; when?: string }[]>;
  };
};

describe("この話を削除の問い", () => {
  test("話数を詰められる話だけ、詰めるかを訊く", () => {
    expect(canRenumberOnDelete(workTypeContextValue("episode", "long"))).toBe(true);
    expect(canRenumberOnDelete(workTypeContextValue("episode", "script"))).toBe(true);
    expect(canRenumberOnDelete(workTypeContextValue("episode", undefined))).toBe(true);
    expect(canRenumberOnDelete(workTypeContextValue("episode", "sns"))).toBe(false);
    expect(canRenumberOnDelete(workTypeContextValue("episode", "memo"))).toBe(false);
  });

  test("答えの言葉から、どちらの道かを決める", () => {
    expect(routeOfDeleteAnswer(EPISODE_DELETE_CHOICES.renumber)).toBe("renumber");
    expect(routeOfDeleteAnswer(EPISODE_DELETE_CHOICES.fileOnly)).toBe("fileOnly");
    expect(routeOfDeleteAnswer(undefined)).toBeUndefined();
    expect(routeOfDeleteAnswer("キャンセル")).toBeUndefined();
  });

  test("選択肢の言葉は作者の指定どおり", () => {
    expect(EPISODE_DELETE_CHOICES.renumber).toBe("話数を詰める");
    expect(EPISODE_DELETE_CHOICES.fileOnly).toBe("詰めない（ファイルだけ消す）");
  });

  test("詰められる話の見分けは、話の挿入の右クリックと同じ条件", () => {
    // 同じ「番号で数える話」を指す。片方だけ直すと、挿入できるのに詰められない話が出る
    const insert = manifest.contributes.menus["view/item/context"].find(
      (entry) => entry.command === "novelai.insertEpisodeBefore"
    );
    expect(insert?.when).toContain(
      `viewItem =~ /${RENUMBERABLE_EPISODE_CONTEXT.source}/`
    );
  });
});

describe("話の右クリックの削除は1つ", () => {
  const items = manifest.contributes.menus["view/item/context"];

  test("「この話を削除」だけが並び、話数を詰める削除は品書きから外れている", () => {
    expect(
      items.filter((entry) => entry.command === "novelai.deleteEpisodeFile")
    ).toHaveLength(1);
    expect(
      items.filter((entry) => entry.command === "novelai.removeEpisodeAndRenumber")
    ).toHaveLength(0);
    const title = manifest.contributes.commands.find(
      (entry) => entry.command === "novelai.deleteEpisodeFile"
    )?.title;
    expect(title).toBe("この話を削除");
  });
});

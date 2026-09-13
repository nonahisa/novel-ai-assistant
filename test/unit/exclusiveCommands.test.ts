import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  EXCLUSIVE_COMMANDS,
  exclusiveLabelOf,
} from "../../src/core/exclusiveCommands";
import { beginCommand, endCommand } from "../../src/core/runningCommands";

/**
 * 同じ操作の二重起動を塞ぐ一覧（作者の報告 2026-09-12。設計書6.17.4の末尾）。
 *
 * 見張るのは2つ。
 *
 * 1. **一覧のIDが実在すること。** ただの文字列なので綴り違いは型検査を
 *    素通りし、塞げていないまま気づかれない（`EDITOR_ALLOWED` で実際に
 *    起きた。0.47.3）。実際この一覧でも、指示にあった
 *    `novelai.extractCharacters` が実在せず、ここで見つかった
 * 2. **`finally` で必ず解けること。** 解き忘れると、その操作が二度と
 *    押せなくなる——重複起動より重い壊れ方である
 */
describe("二重起動を塞ぐ一覧", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  ) as { contributes: { commands: { command: string }[] } };
  const declared = new Set(manifest.contributes.commands.map((c) => c.command));

  test("一覧のIDはすべて package.json に実在する", () => {
    for (const entry of EXCLUSIVE_COMMANDS) {
      // 落ちたときに、どのIDが無いのかがそのまま分かるようにする
      expect(
        declared.has(entry.id),
        `${entry.id} が package.json の contributes.commands にない`
      ).toBe(true);
    }
  });

  test("同じIDを二度並べない", () => {
    const ids = EXCLUSIVE_COMMANDS.map((entry) => entry.id);

    expect(ids.length).toBe(new Set(ids).size);
  });

  test("断りの文言に出す名前が、すべて入っている", () => {
    for (const entry of EXCLUSIVE_COMMANDS) {
      expect(entry.label.length, `${entry.id} の label が空`).toBeGreaterThan(0);
    }
  });

  test("画面を開くだけのものは塞がない", () => {
    // 同じ画面を2回開いても害が無い。押せないほうが困る
    for (const id of [
      "novelai.openSettingsPanel",
      "novelai.showLog",
      "novelai.openManual",
      "novelai.refresh",
    ]) {
      expect(exclusiveLabelOf(id), `${id} が塞ぐ対象に入っている`).toBeUndefined();
    }
  });

  test("作者が報告した「まとめて同期」は塞ぐ", () => {
    expect(exclusiveLabelOf("novelai.syncAllWorks")).toBe("作品をすべて同期");
  });
});

describe("走っているものを覚える", () => {
  test("1本目は始められ、2本目は断られる", () => {
    const running = new Set<string>();

    expect(beginCommand(running, "novelai.syncAllWorks")).toBe(true);
    expect(beginCommand(running, "novelai.syncAllWorks")).toBe(false);
  });

  test("終われば、また押せる", () => {
    const running = new Set<string>();

    beginCommand(running, "novelai.syncAllWorks");
    endCommand(running, "novelai.syncAllWorks");

    expect(beginCommand(running, "novelai.syncAllWorks")).toBe(true);
  });

  test("別の操作は、同時に走ってよい", () => {
    const running = new Set<string>();

    expect(beginCommand(running, "novelai.syncAllWorks")).toBe(true);
    expect(beginCommand(running, "novelai.checkTypos")).toBe(true);
  });

  test("一覧に無いIDは、いつでも始められる（覚えもしない）", () => {
    const running = new Set<string>();

    expect(beginCommand(running, "novelai.refresh")).toBe(true);
    expect(beginCommand(running, "novelai.refresh")).toBe(true);
    expect(running.size).toBe(0);
  });

  /**
   * 呼び出し側（`extension.ts` の `registerCommand`）の `finally` を模す。
   *
   * **失敗しても、途中で止めても解けること。** ここが抜けると、一度
   * 失敗した操作が二度と押せなくなる
   */
  test("失敗しても解ける", async () => {
    const running = new Set<string>();

    const run = async (id: string, body: () => Promise<void>) => {
      if (!beginCommand(running, id)) return;
      try {
        await body();
      } finally {
        endCommand(running, id);
      }
    };

    await expect(
      run("novelai.syncAllWorks", async () => {
        throw new Error("同期に失敗");
      })
    ).rejects.toThrow("同期に失敗");

    expect(running.size).toBe(0);
    expect(beginCommand(running, "novelai.syncAllWorks")).toBe(true);
  });

  test("途中で止めても解ける", async () => {
    const running = new Set<string>();

    // 中止は、機能側が「中止された」を返して素直に終わる形（例外にしない
    // 経路）でも来る。**どちらでも解ける**ことを確かめる
    const run = async (id: string, body: () => Promise<string>) => {
      if (!beginCommand(running, id)) return undefined;
      try {
        return await body();
      } finally {
        endCommand(running, id);
      }
    };

    expect(await run("novelai.checkTypos", async () => "中止")).toBe("中止");
    expect(running.size).toBe(0);
    expect(beginCommand(running, "novelai.checkTypos")).toBe(true);
  });
});

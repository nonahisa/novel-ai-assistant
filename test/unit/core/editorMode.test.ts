import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  editorAllowedCommands,
  isCommandAllowed,
} from "../../src/core/editorMode";

/**
 * 編集者モードの許可一覧（設計書5.6）。
 *
 * **一覧のIDが実在するかを誰も見ていなかった。** `novelai.syncWork` など
 * 存在しない名前が3つ紛れており、編集部は「同期」を押せないまま半年気づかれなかった。
 * 許可一覧はただの文字列の集まりなので、綴りを間違えても型検査には引っかからない。
 * **突き合わせはテストでしか守れない。**
 */
describe("編集者モードの許可一覧", () => {
  test("一覧のIDはすべて package.json に実在する", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8")
    ) as { contributes: { commands: { command: string }[] } };
    const declared = new Set(
      manifest.contributes.commands.map((c) => c.command)
    );

    for (const command of editorAllowedCommands()) {
      // 落ちたときに、どのIDが無いのかがそのまま分かるようにする
      expect(
        declared.has(command),
        `${command} が package.json の contributes.commands にない`
      ).toBe(true);
    }
  });

  test("原稿を受け取り、直したものを返すために要るものは開く", () => {
    for (const command of [
      "novelai.gitSync",
      "novelai.resolveConflicts",
      "novelai.resolveDivergence",
      "novelai.showLog",
    ]) {
      expect(isCommandAllowed(command, "editor")).toBe(true);
    }
  });

  test("作品全体に及ぶ操作と執筆の機能は開かない", () => {
    // 編集部が見るのは1作品だけ（EDITOR_WORK_LIMIT）。全作品の同期は要らない
    for (const command of [
      "novelai.syncAllWorks",
      "novelai.showWritingStats",
    ]) {
      expect(isCommandAllowed(command, "editor")).toBe(false);
    }
  });
});

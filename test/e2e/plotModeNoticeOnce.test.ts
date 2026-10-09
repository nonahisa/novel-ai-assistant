/**
 * プロットモードの上の知らせの帯に、同じ断りが2回続けて出ない
 * （画面の自動テスト、設計書6.113。実機確認リスト 369 の写真、2026-10-09）。
 *
 * 写真：形の違う名前のファイル（`episode_0005.md`）がある作品でプロットモードを開くと、
 * 「単話プロットの置き場に、名前が「第N話.md」の形でないため…」が2回続けて出ていた。
 *
 * 原因：開いた直後に読み込み（`load`）が2本重なって走る——パネルを作った側の
 * `initialize()` と、画面が整ったときの `ready` の知らせ。どちらも先頭で知らせの器を
 * 空にしてから、置き場を読んだあとで同じ器へ断りを足すので、2本目が空にしたあとに
 * 両方が足していた。
 *
 * 確かめること：帯に断りが出たあと数秒見続けても、断りは1回だけ。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { SIDEBAR_LAUNCH } from "./support/sidebar";
import { withVsCode } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { openPlotMode } from "./look/nameLookSupport";

const NOTICE_HEAD = "名前が「第N話.md」の形でないため";

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

test("形の違う名前のファイルの断りは、知らせの帯に1回だけ出る", async () => {
  await withVsCode(
    "プロットモード・知らせの帯",
    [{ name: "第1話_はじまり.txt", text: "一話の本文。\n" }],
    async (session) => {
      const plot = await openPlotMode(session);
      const notice = async () => (await plot.locator("#notice").innerText().catch(() => "")) ?? "";
      await waitUntil(async () => (await notice()).includes("episode_0005.md"), "知らせの帯に名前の断りが出る", 30_000);
      // 2本目の読み込みは遅れて届くので、一瞬だけ見て「1回」としない
      let last = "";
      await holdsFor(
        async () => count((last = await notice()), NOTICE_HEAD) === 1,
        "知らせの帯の断りが1回だけ",
        3_000
      ).catch((error: unknown) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}：${last}`);
      });
      expect(count(await notice(), NOTICE_HEAD)).toBe(1);
    },
    {
      ...SIDEBAR_LAUNCH,
      windowSize: { width: 1280, height: 800 },
      settings: {
        ...SIDEBAR_LAUNCH.settings,
        "workbench.editorAssociations": { "*.txt": "novelai.manuscriptEditorHorizontal", "*.md": "default" },
      },
      prepareWork: async ({ workFolder }) => {
        await mkdir(path.join(workFolder, "設定", "episode-plots"), { recursive: true });
        await writeFile(path.join(workFolder, "設定", "plot.md"), "# 見本の物語\n\n## 主要登場人物\n- 主人公：高校生。\n", "utf8");
        await writeFile(path.join(workFolder, "設定", "episode-plots", "第1話.md"), "第1話の予定\n", "utf8");
        await writeFile(path.join(workFolder, "設定", "episode-plots", "episode_0005.md"), "第5話の案\n", "utf8");
      },
    }
  );
});

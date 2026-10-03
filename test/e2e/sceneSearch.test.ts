/**
 * 場面検索（画面の自動テスト、設計書6.19・6.113）。
 *
 * 実機確認リスト 0.82.4〜0.83.13 の節の項目を機械へ移したもの（2026-10-04）：
 * 「場面検索」に言葉を書くと、当たりそうな話と箇所が並び、押すとその箇所が開く。
 * **ベクトル検索の準備が無くても語句一致で探し、準備の案内が添う。**
 *
 * **Ollama には触れない**（意味検索の設定 `novelai.vectorSearch.enabled` は既定で切。念のため明示する）。
 * 並ぶのは語句一致だけで、AI も埋め込みの通信も使わない。
 * 並びの順位づけの良し悪し（意味の近さ）は見ていない。
 */
import { expect, test } from "vitest";
import { answerInput, runCommand, waitForQuickInput } from "./support/quickInput";
import { withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { editorGroupTabs, pickQuickPickRow, quickPickRows } from "./support/workbenchDom";

const EPISODES = [
  { name: "001_旅立ち.txt", text: "旅立ちの朝。村の門を出て、街道を北へ歩いた。\n" },
  { name: "002_剣.txt", text: "主人公は初めて剣を握った。思ったよりも重く、手が震えた。\n" },
  { name: "003_市場.txt", text: "市場で干し肉とパンを買い、露店の主人と値段を話した。\n" },
];

test("場面検索に言葉を書くと、語句一致で当たりの話が並び、ベクトル検索の準備の案内が添い、押すとその話が開く", async () => {
  await withVsCode(
    "場面検索",
    EPISODES,
    async (session) => {
      const { page } = session;
      await runCommand(page, "場面検索（言葉で本文を探す）");
      await waitForQuickInput(page, "場面検索：画面テストの作品");
      await answerInput(page, "剣を握った");

      await waitForQuickInput(page, "場面検索：「剣を握った」");
      let rows: Awaited<ReturnType<typeof quickPickRows>> = [];
      await waitUntil(
        async () => {
          rows = await quickPickRows(page);
          return rows.some((row) => row.label.includes("ベクトル検索を使えるようにする"));
        },
        "当たりの一覧と、準備の案内の行が並ぶ",
        20_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（並び：${JSON.stringify(await quickPickRows(page))}）`);
      });

      const hits = rows.filter((row) => !row.label.includes("ベクトル検索を使えるようにする") && row.label !== "閉じる");
      expect(hits.length, `当たりの行 ${JSON.stringify(rows)}`).toBeGreaterThanOrEqual(1);
      // 語句一致で探した（準備が無いので意味検索ではない）
      expect(hits[0].description, "探した方法").toContain("語句");
      // 当たりは「剣を握った」を含む第2話の場面
      expect(hits[0].label, "いちばん上の当たり").toMatch(/剣|2/);
      // 旅立ち・市場の話は当たりに入らない（語句が無い）
      expect(hits.map((row) => row.label).join(" / ")).not.toMatch(/市場|旅立/);

      // 押すと、その話が開く
      await pickQuickPickRow(page, hits[0].label);
      await waitUntil(
        async () => (await editorGroupTabs(page)).flat().some((name) => name.includes("002_剣")),
        "第2話が開く",
        30_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（タブ：${JSON.stringify(await editorGroupTabs(page))}）`);
      });
    },
    { settings: { "novelai.vectorSearch.enabled": false } }
  );
});

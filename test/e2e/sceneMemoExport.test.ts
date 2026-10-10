/**
 * 校正・メモパネルの［書き出す］（画面の自動テスト、設計書6.40.4・6.96・6.113）。
 *
 * 実機確認リスト 0.96.9 の項目を機械へ移したもの（2026-10-03）：
 * - 書き出すと `.aiwriter/generated/校正・メモ_<日付>_<時刻>.md` ができて開き、
 *   見出しが「# 校正・メモ：作品名」
 * - 同じ置き場の前の名前の写し `シーンメモ_<日付>_<時刻>.md` は、**30日を過ぎたものだけ**消える
 *   （0.96.16 から。日付は名前でなくファイルの更新時刻で見る）
 * - 本文の `//` の行は書き出しで変わらない
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { memoPanelFrame, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { E2E_WORK_TITLE, withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { activeTabNames, tabNamesInclude } from "./support/workbenchDom";

const EPISODE = "001_はじまり.txt";
const TEXT = "一行目の文。\n// 見張りのメモ\n三行目の文。\n";

/** 前の名前の写し。古いもの（31日前）と新しいもの（1日前） */
const OLD_COPY = "シーンメモ_2026-08-01_1200.md";
const RECENT_COPY = "シーンメモ_2026-10-02_1200.md";

test("校正・メモパネルの［書き出す］で「校正・メモ」の紙ができて開き、前の名前の写しは30日を過ぎたものだけ消える", async () => {
  await withVsCode("校正・メモの書き出し", [{ name: EPISODE, text: TEXT }], async (session) => {
    const { page } = session;
    const generated = path.join(session.workFolder, ".aiwriter", "generated");
    await mkdir(generated, { recursive: true });
    const day = 24 * 60 * 60 * 1000;
    for (const [name, ageDays] of [
      [OLD_COPY, 31],
      [RECENT_COPY, 1],
    ] as const) {
      const file = path.join(generated, name);
      await writeFile(file, "# シーンメモ：前の名前の写し\n", "utf8");
      const at = new Date(Date.now() - ageDays * day);
      await utimes(file, at, at);
    }

    const frame = await openEpisode(page, EPISODE, "三行目の文");
    await placeCaretAfter(frame, "一行目");
    await page.keyboard.press("Control+Alt+KeyM");
    let memo = await memoPanelFrame(page);
    await waitUntil(
      async () => {
        memo = await memoPanelFrame(page);
        return memo !== undefined && (await memo.locator("button.go").count()) > 0;
      },
      "校正・メモパネルにメモの行が出る",
      30_000
    );
    if (!memo) throw new Error("校正・メモパネルが見つかりません");

    await memo.locator("#export").click();

    // ── 紙ができる ──
    let written: string | undefined;
    await waitUntil(
      async () => {
        const names = await readdir(generated);
        written = names.find((name) => /^校正・メモ_\d{4}-\d{2}-\d{2}_\d{4}/.test(name) && name.endsWith(".md"));
        return written !== undefined;
      },
      "「校正・メモ_<日付>_<時刻>.md」ができる"
    );
    if (!written) throw new Error("書き出した紙が見つかりません");
    const paper = await readFile(path.join(generated, written), "utf8");
    expect(paper.replace(/\r\n/g, "\n").split("\n")[0]).toBe(`# 校正・メモ：${E2E_WORK_TITLE}`);
    expect(paper).toContain("見張りのメモ");

    // ── 開く（どこかの列で前に出ている）──
    const fileName = written;
    await waitUntil(
      async () => tabNamesInclude(await activeTabNames(page), fileName),
      "書き出した紙のタブが前に出る",
      10_000
    ).catch(async (error: unknown) => {
      throw new Error(`${String(error)}（前のタブ：${JSON.stringify(await activeTabNames(page))}）`);
    });

    // ── 前の名前の写し：30日を過ぎたものだけ消える ──
    await waitUntil(() => !existsSync(path.join(generated, OLD_COPY)), "31日前の「シーンメモ_…」の写しが消える", 10_000);
    expect(existsSync(path.join(generated, RECENT_COPY)), "1日前の「シーンメモ_…」の写しまで消えました").toBe(true);

    // ── 本文の // の行は変わらない ──
    const body = (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n");
    expect(body).toBe(TEXT);
  });
});

/**
 * コマンドパレット・キーボード ショートカット・パネルのタブに出る名前（画面の自動テスト、
 * 設計書6.40・6.2.3・6.17.9・6.113）。
 *
 * 実機確認リストの「名前が画面に出るか」を機械へ移したもの（2026-10-03）：
 * - 0.96.6 改名「シーンメモ」→「校正・メモパネル」：パレットの4つの名前、パネルのタブと見出し、
 *   キーボード ショートカットでの名前とキー
 * - 0.96.16／0.96.17 「コピー（投稿サイト用）」が**パレットに1つだけ**出る（作品一覧の
 *   右クリック用の同名のコマンドはパレットから隠した）
 * - 0.96.13 「章立て取込（バックアップから）」がパレットに出る
 *
 * 名前の写しは package.json のコマンドの題を正とし、ここでは画面に出たかを見る。
 * **見た目（切れずに読めるか）は見ていない。**
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { memoPanelFrame, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import {
  commandPaletteLabels,
  editorGroupTabs,
  keybindingsEditorRows,
  OPEN_KEYBINDINGS_BINDING,
} from "./support/workbenchDom";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EPISODE = "001_はじまり.txt";

/** package.json の、そのコマンドの「分類: 題」（パレットとキーの画面に出る形） */
async function paletteNameOf(command: string): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8")) as {
    contributes: { commands: Array<{ command: string; title: string; category?: string }> };
  };
  const found = manifest.contributes.commands.find((entry) => entry.command === command);
  if (!found) throw new Error(`package.json にコマンド ${command} がありません`);
  return found.category ? `${found.category}: ${found.title}` : found.title;
}

test("パレット・キーの画面・パネルのタブに「校正・メモパネル」の名前が出て、「コピー（投稿サイト用）」はパレットに1つだけ", async () => {
  await withVsCode("コマンドの名前", [{ name: EPISODE, text: "一行目の文。\n// 見張りのメモ\n" }], async (session) => {
    const { page } = session;
    const frame = await openEpisode(page, EPISODE, "一行目の文");
    await placeCaretAfter(frame, "一行目");

    // ── コマンドパレット（原稿エディターが前にあるときに開く）──
    const copy = await paletteNameOf("novelai.copyForPosting");
    const copyRows = (await commandPaletteLabels(page, "コピー（投稿サイト用）")).filter((label) => label === copy);
    expect(copyRows, "パレットの「コピー（投稿サイト用）」の数").toHaveLength(1);

    for (const command of [
      "novelai.openSceneMemos",
      "novelai.nextSceneMemo",
      "novelai.prevSceneMemo",
      "novelai.addSceneMemo",
      "novelai.importChaptersFromBackup",
    ]) {
      const name = await paletteNameOf(command);
      const title = name.replace(/^[^:]+: /, "");
      const labels = await commandPaletteLabels(page, title);
      expect(labels, `パレットに「${name}」がありません（並び：${labels.join(" / ")}）`).toContain(name);
    }
    // 古い名前はパレットに出ない
    const legacy = await commandPaletteLabels(page, "シーンメモ").catch(() => [] as string[]);
    expect(legacy.filter((label) => label.startsWith("小説執筆:")), "パレットに古い名前「シーンメモ」が残っています").toEqual([]);

    // ── パネルのタブと見出し ──
    await placeCaretAfter(frame, "一行目");
    await page.keyboard.press("Control+Alt+KeyM");
    await waitUntil(async () => (await memoPanelFrame(page)) !== undefined, "校正・メモパネルが開く", 30_000);
    const tabs = (await editorGroupTabs(page)).flat();
    expect(
      tabs.some((name) => name.startsWith("校正・メモパネル")),
      `タブに「校正・メモパネル」がありません：${JSON.stringify(tabs)}`
    ).toBe(true);

    // ── キーボード ショートカットの画面 ──
    const wanted: Array<[string, RegExp]> = [
      ["novelai.openSceneMemos", /Ctrl\+Alt\+M/i],
      ["novelai.nextSceneMemo", /^F8$/i],
      ["novelai.prevSceneMemo", /Shift\+F8/i],
      ["novelai.addSceneMemo", /Ctrl\+\//i],
    ];
    for (const [command, keys] of wanted) {
      const name = await paletteNameOf(command);
      const title = name.replace(/^[^:]+: /, "");
      const rows = await keybindingsEditorRows(page, title);
      const row = rows.find((candidate) => candidate.command === name);
      expect(row, `キーの画面に「${name}」がありません（並び：${JSON.stringify(rows)}）`).toBeDefined();
      expect(row?.keys.replace(/\s+/g, ""), `「${name}」のキー`).toMatch(keys);
    }
  }, { keybindings: [OPEN_KEYBINDINGS_BINDING] });
});

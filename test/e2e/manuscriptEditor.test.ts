/**
 * 原稿エディター（横書き）を本物の VS Code で押して確かめる（画面の自動テスト、設計書6.113）。
 *
 * 2026-10-03 に作者が開発ホストで押して確かめたこと（保存・表示倍率・メモのキー・
 * 右クリックの名前）を、機械で毎回見張る。**日本語入力の本物の変換・ほかのアプリとの
 * キーの取り合い・見た目の良し悪しは、ここでは見ない**（見られない）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  caretPosition,
  composeText,
  footText,
  openEpisode,
  placeCaretAfter,
} from "./support/manuscriptFrame";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";

const EPISODE = "001_はじまり.txt";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 右クリックの品書きに並ぶはずの名前。**写しはここ1か所。**
 *
 * ルビ・傍点・投稿用コピーは**コマンドの題と同じ名前**にする決まり（作者の裁定、
 * 2026-10-03）なので、package.json のコマンドの題から読む。名前が変わっても
 * ここを直さずに済み、品書きとコマンドの題がずれたら落ちる。
 * 残りの2つはコマンドの題と違う名前なので、ここに書く。
 */
async function contextMenuNames(): Promise<string[]> {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8")) as {
    contributes: { commands: Array<{ command: string; title: string }> };
  };
  const titleOf = (id: string) => {
    const found = manifest.contributes.commands.find((entry) => entry.command === id);
    if (!found) throw new Error(`package.json にコマンド ${id} がありません`);
    return found.title;
  };
  return [
    titleOf("novelai.addRuby"),
    titleOf("novelai.addEmphasis"),
    titleOf("novelai.copyForPosting"),
    "コピー（記法のまま）",
    "メモ追加",
  ];
}

/** 原稿ファイルの中身（改行は LF に揃えて比べる） */
async function fileText(session: E2ESession): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n");
}

/** Ctrl+S を押し、ファイルに `expected` が入るまで待つ */
async function saveAndWaitFor(session: E2ESession, expected: (text: string) => boolean, label: string) {
  await session.page.keyboard.press("Control+KeyS");
  await waitUntil(async () => expected(await fileText(session)), label, 15_000);
}

test("打った字が Ctrl+S でファイルに入り、「保存しました」が出て、カーソルが動かない", async () => {
  await withVsCode(
    "保存",
    [{ name: EPISODE, text: "一行目の文。\n二行目の文。\n三行目の文。\n" }],
    async (session) => {
      const frame = await openEpisode(session.page, EPISODE, "二行目の文");
      await placeCaretAfter(frame, "二行目の");
      // 日本語は変換を通さず、確定した字として入れる（IME の本物の変換は見られない）
      await session.page.keyboard.insertText("短い");
      await waitUntil(
        async () => (await composeText(frame)).includes("二行目の短い文。"),
        "打った字が画面に出る"
      );
      const before = await caretPosition(frame);
      expect(before).toEqual({ lineText: "二行目の短い文。", column: 6 });

      await saveAndWaitFor(session, (text) => text.includes("二行目の短い文。"), "打った字がファイルに入る");
      expect(await fileText(session)).toBe("一行目の文。\n二行目の短い文。\n三行目の文。\n");
      await waitUntil(async () => (await footText(frame, "note")).includes("保存しました"), "「保存しました」が出る");

      // **保存の前後でカーソルが動かない**（保存のあと描き直されても、同じ行の同じ字の後ろ）
      expect(await caretPosition(frame)).toEqual(before);
      // 念押し：続けて打った字が、同じ所へ入る
      await session.page.keyboard.insertText("ほど");
      await saveAndWaitFor(session, (text) => text.includes("短いほど"), "続けて打った字がファイルに入る");
      expect(await fileText(session)).toBe("一行目の文。\n二行目の短いほど文。\n三行目の文。\n");
    }
  );
});

test("下の欄に「表示倍率 100%」が出て、上の帯の［＋］で 106% になる", async () => {
  await withVsCode("表示倍率", [{ name: EPISODE, text: "本文の一行。\n" }], async (session) => {
    const frame = await openEpisode(session.page, EPISODE, "本文の一行");
    await waitUntil(async () => (await footText(frame, "counts")).includes("表示倍率 100%"), "「表示倍率 100%」が出る");
    await frame.locator("#bigger").click();
    await waitUntil(async () => (await footText(frame, "counts")).includes("表示倍率 106%"), "［＋］で「表示倍率 106%」になる");
  });
});

test("Ctrl+/ でカーソル行の上に // の行が入り、F8 で次のメモへ動く", async () => {
  await withVsCode(
    "メモのキー",
    [{ name: EPISODE, text: "一行目の文。\n二行目の文。\n三行目の文。\n// 先のメモ\n四行目の文。\n" }],
    async (session) => {
      const frame = await openEpisode(session.page, EPISODE, "二行目の文");

      // 行の途中にカーソルを置いて Ctrl+/ → その行の上にメモの行が入る
      await placeCaretAfter(frame, "二行目");
      await session.page.keyboard.press("Control+Slash");
      // メモの行は「画面→本体のコマンド→文書」と回って入るので、画面に出てから保存する
      // （すぐ Ctrl+S を押すと、入る前の文書を保存してしまう）
      await waitUntil(
        async () => /\/\/.*\n+二行目の文。/.test(await composeText(frame)),
        "Ctrl+/ でメモの行が画面に入る"
      );
      await saveAndWaitFor(
        session,
        (text) => /^\/\/.*\n二行目の文。$/m.test(text),
        "Ctrl+/ で入れたメモの行がファイルに入る"
      );
      const lines = (await fileText(session)).split("\n");
      expect(lines[0]).toBe("一行目の文。");
      expect(lines[1]).toMatch(/^\/\/ ?$/);
      expect(lines[2]).toBe("二行目の文。");

      // 1行目に戻って F8 → 次のメモ（いま入れた2行目の「//」）へ動く。
      // 動いた先で字を打てば、その行に入る（カーソルの行をファイルで確かめる）
      await placeCaretAfter(frame, "一行目の文");
      await session.page.keyboard.press("F8");
      await waitUntil(
        async () => ((await caretPosition(frame))?.lineText ?? "").startsWith("//"),
        "F8 でメモの行へ動く"
      );
      // 飛んだ先の行は**行ごと選ばれて**示される。そのまま打つと行が置き換わるので、
      // End で選択を畳んで行末から打つ
      await session.page.keyboard.press("End");
      await session.page.keyboard.insertText("印");
      await saveAndWaitFor(session, (text) => text.includes("印"), "F8 の先で打った字がファイルに入る");
      const after = (await fileText(session)).split("\n");
      expect(after[1]).toMatch(/^\/\/.*印/);
      expect(after[0]).toBe("一行目の文。");

      // もう一度 F8 → その次のメモ（もとからあった「// 先のメモ」）
      await session.page.keyboard.press("F8");
      await waitUntil(
        async () => ((await caretPosition(frame))?.lineText ?? "").includes("先のメモ"),
        "もう一度 F8 で次のメモへ動く"
      );
    }
  );
});

test("本文の右クリックの品書きに、ルビ・傍点（コマンドの題と同じ名前）・2つのコピー・メモ追加が並ぶ", async () => {
  await withVsCode("右クリック", [{ name: EPISODE, text: "右クリックを試す行。\n" }], async (session) => {
    const frame = await openEpisode(session.page, EPISODE, "右クリックを試す行");
    await placeCaretAfter(frame, "右クリック");
    await frame.locator("#compose").click({ button: "right" });
    const menu = frame.locator("#menu");
    await waitUntil(async () => ((await menu.innerText().catch(() => "")) ?? "").length > 0, "右クリックの品書きが出る");
    // 品書きの1行には、名前のほかにキーの添え書きが付くことがあるので、名前の頭で見る
    const items = (await menu.innerText()).split("\n").map((line) => line.trim()).filter(Boolean);
    for (const name of await contextMenuNames()) {
      expect(
        items.some((item) => item.startsWith(name)),
        `品書きに「${name}」がありません（並び：${items.join(" / ")}）`
      ).toBe(true);
    }
  });
});

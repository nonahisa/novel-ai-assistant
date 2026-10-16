/**
 * 原稿エディター以外の画面では、Ctrl+/ と F8 が VS Code のふだんの動きのまま
 * （画面の自動テスト、設計書6.25.10・6.113）。
 *
 * 実機確認リスト 0.96.17 の項目を機械へ移したもの（2026-10-03）。この拡張機能の
 * Ctrl+/（メモを足す）と F8（次のメモへ）は、**原稿エディターが前面のときだけ**効く
 * 割り当てにしてある。素のテキストエディターで開いた話や `.md` で、本体の
 * 「行コメント」「次の問題」を奪っていないことを見る。
 *
 * 原稿を素のエディターで開くため、この件だけ `workbench.editorAssociations` を空にして起こす
 * （既定の起こし方は、原稿を横書きの原稿エディターへ関連付けている）。
 * `.md` の「次の問題」は、本体の Markdown の検査（`markdown.validate.enabled`）に
 * 無いファイルへのリンクを見つけさせて作る。
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  focusTextEditor,
  markerWidgetShown,
  quickOpen,
  textEditorCursor,
  textEditorVisibleText,
} from "./support/workbenchDom";

const TXT = "001_はじまり.txt";
const TXT_TEXT = "一行目の文。\n二行目の文。\n// 先のメモ\n四行目の文。\n";
const MD = "002_つづき.md";
const MD_TEXT = "一行目の文。\n\n[無い話へのリンク](./無い話.md)\n";

async function fileText(session: E2ESession, name: string): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, name), "utf8")).replace(/\r\n/g, "\n");
}

/**
 * Ctrl+S を押し、保存の書き込みが**終わるまで**待つ。
 *
 * **VS Code 本体の保存は、ファイルをいったん空にしてから書く**（一時ファイルを経ない）。
 * 書いている途中に読むと空の中身が返る。母艦（0.107.14、1.141.0、2026-10-16）で、CPU を
 * 8本回した負荷の下では5回中2〜3回、保存の直後に読んだ .txt が `""` で「保存しても
 * ファイルは変わらない」が崩れた（全件の走りで1回落ちたのもこれ。単独では書き込みが
 * 一瞬で終わり、読む刻みに当たらない）。空の中身は落ちたあとには残っておらず、製品は保存の
 * 前に本文を書き換えない（`onWillSaveTextDocument` を持たない）ので、本体の書き込みの途中を読んだもの。
 *
 * そこで「保存がファイルに届いた（更新時刻が進んだ）」→「中身が空でなく、続けて読んでも
 * 同じ」の2段を名乗って待つ。中身の正しさは、待ったあとに呼び手が確かめる
 */
async function saveAndSettle(session: E2ESession, name: string, label: string): Promise<void> {
  const file = path.join(session.manuscriptFolder, name);
  const before = (await stat(file)).mtimeMs;
  await session.page.keyboard.press("Control+KeyS");
  await waitUntil(async () => (await stat(file)).mtimeMs > before, `Ctrl+S の保存が${label}のファイルに届く`, 10_000);
  let last = "";
  let same = 0;
  await waitUntil(
    async () => {
      const now = await fileText(session, name);
      same = now !== "" && now === last ? same + 1 : 0;
      last = now;
      return same >= 3;
    },
    `${label}の保存の書き込みが終わる`,
    10_000
  ).catch((error: Error) => {
    error.message += `［最後に読めた中身 ${JSON.stringify(last)}］`;
    throw error;
  });
}

/**
 * 落ちたときに読む画面の様子（2026-10-04、2ファイル続けて走らせると落ちる揺れの調べ）。
 * どの確かめで、何が見えていたかを失敗文へ添える——写真だけでは、見えている行の
 * 字の並び（Monaco は行の節点を使い回すので、DOM の順と行の順がずれうる）や
 * 焦点の在り処が分からない
 */
async function screenState(session: E2ESession): Promise<string> {
  const { page } = session;
  const detail = await page.evaluate(() => {
    const group = document.querySelector(".editor-group-container.active");
    const editors = group ? group.querySelectorAll(".monaco-editor").length : -1;
    const lines = Array.from(group?.querySelectorAll(".monaco-editor .view-lines .view-line") ?? []).map(
      (line) => `${(line as HTMLElement).style.top}:${(line as HTMLElement).innerText}`
    );
    const active = document.activeElement;
    const tabs = Array.from(document.querySelectorAll(".tabs-container .tab")).map((tab) =>
      (tab.getAttribute("aria-label") ?? "").slice(0, 40)
    );
    return { editors, lines, active: active ? `${active.tagName}.${String(active.className).slice(0, 60)}` : "なし", tabs };
  });
  const status = await page
    .locator('[id="status.editor.selection"]')
    .first()
    .innerText()
    .catch(() => "（無し）");
  let txt = "";
  let md = "";
  try {
    txt = await fileText(session, TXT);
    md = await fileText(session, MD);
  } catch {
    // 読めなくても様子の残りは出す
  }
  return (
    `（列の中のエディター：${detail.editors}／見えている行（top:字）：${JSON.stringify(detail.lines)}` +
    `／焦点：${detail.active}／タブ：${JSON.stringify(detail.tabs)}／ステータスバー：${JSON.stringify(status)}` +
    `／ファイル .txt：${JSON.stringify(txt)}／.md：${JSON.stringify(md)}）`
  );
}

/** 確かめが落ちたら、画面の様子を添えて投げ直す */
async function withState<T>(session: E2ESession, check: () => Promise<T>): Promise<T> {
  try {
    return await check();
  } catch (error) {
    if (error instanceof Error) error.message += await screenState(session);
    throw error;
  }
}

/** 素のエディターで開き、本文が見えるまで待って、1行目の頭へカーソルを置く */
async function openPlain(session: E2ESession, name: string, expected: string): Promise<void> {
  const { page } = session;
  await quickOpen(page, name);
  await waitUntil(async () => (await textEditorVisibleText(page)).includes(expected), `素のエディターで「${name}」が開く`, 20_000);
  await focusTextEditor(page);
  await page.keyboard.press("Control+Home");
  await waitUntil(async () => (await textEditorCursor(page))?.line === 1, `「${name}」の1行目へカーソルが来る`, 5_000);
}

test("素のテキストエディターと .md では、Ctrl+/ と F8 が本体の動き（行コメント・次の問題）のまま", async () => {
  await withVsCode(
    "素のエディターのキー",
    [
      { name: TXT, text: TXT_TEXT },
      { name: MD, text: MD_TEXT },
    ],
    async (session) => withState(session, async () => {
      const { page } = session;

      // ── .txt（素のエディター）：Ctrl+/ でメモの行が入らず、F8 でメモの行へ飛ばない ──
      await openPlain(session, TXT, "二行目の文");
      await page.keyboard.press("Control+Slash");
      await page.keyboard.press("F8");
      // 素の .txt には行コメントの決まりが無いので、本体は何も足さない。
      // この拡張機能が奪っていれば、1行目の上に「//」の行が入り、カーソルが3行目へ飛ぶ
      await holdsFor(
        async () => (await textEditorVisibleText(page)).split("\n")[0] === "一行目の文。",
        "素の .txt で Ctrl+/ を押してもメモの行が入らない",
        2_000
      );
      expect((await textEditorCursor(page))?.line, "素の .txt で F8 がメモの行へ飛びました").toBe(1);
      await saveAndSettle(session, TXT, "素の .txt");
      expect(await fileText(session, TXT), "保存したら素の .txt のファイルが変わりました").toBe(TXT_TEXT);

      // ── .md（素のエディター）：Ctrl+/ で <!-- --> の行コメント、F8 で次の問題 ──
      await openPlain(session, MD, "一行目の文");
      await page.keyboard.press("Control+Slash");
      await waitUntil(
        async () => /^<!--\s*一行目の文。\s*-->$/.test((await textEditorVisibleText(page)).split("\n")[0]),
        ".md で Ctrl+/ を押すと1行目が <!-- --> で囲まれる",
        5_000
      );
      await saveAndSettle(session, MD, ".md");
      expect((await fileText(session, MD)).split("\n")[0]).toMatch(/^<!--\s*一行目の文。\s*-->$/);

      // 本体の Markdown の検査が「無いファイルへのリンク」を問題に挙げるまで、F8 を押して待つ
      await waitUntil(
        async () => {
          if (await markerWidgetShown(page)) return true;
          await page.keyboard.press("F8");
          await page.waitForTimeout(300);
          return markerWidgetShown(page);
        },
        ".md で F8 を押すと、次の問題の枠が開く",
        30_000
      );
      expect((await textEditorCursor(page))?.line, "F8 の問題の行（リンクの行）へカーソルが来ていません").toBe(3);
    }),
    {
      settings: {
        // 原稿を素のエディターで開く（既定の起こし方の関連付けを消す）
        "workbench.editorAssociations": {},
        "markdown.validate.enabled": true,
      },
    }
  );
});

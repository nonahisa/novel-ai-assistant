/**
 * 原稿エディターと校正・メモパネル（どちらも WebView）の中を覗いて押す（設計書6.113）。
 *
 * WebView の中の DOM は**この作品が書いたもの**（`views/manuscriptEditorHtml.ts`・
 * `views/sceneMemoPanelHtml.ts`）なので、VS Code の版では変わらない。
 * VS Code 本体の DOM に頼る部分は `workbenchDom.ts` に分けてある。
 *
 * WebView は2重の iframe（外側 `index.html`・内側 `fake.html`）で、中身は内側にある。
 * Playwright の `page.frames()` は両方を返すので、**中身の目印で見分ける**
 * （URL の形は VS Code の事情なので頼らない）。
 */
import type { Frame, Page } from "playwright-core";
import { waitUntil } from "./wait";
import { quickOpen } from "./workbenchDom";

/** 原稿エディターの面（`#surface` を持つ）を全部。2枚目ができていないかを数えるのにも使う */
export async function manuscriptFrames(page: Page): Promise<Frame[]> {
  const found: Frame[] = [];
  for (const frame of page.frames()) {
    const has = await frame
      .evaluate(() => document.getElementById("surface") !== null)
      .catch(() => false);
    if (has) found.push(frame);
  }
  return found;
}

/**
 * 校正・メモパネルを探す（見出し「校正・メモパネル」で始まる面）。
 *
 * **`document.title` では探さない。** パネルが前に出ていると VS Code の窓そのものの
 * 題にも「校正・メモパネル」が入り、ワークベンチを取り違える（実際に踏んだ）。
 */
export async function memoPanelFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const has = await frame
      .evaluate(() => (document.body?.innerText ?? "").trimStart().startsWith("校正・メモパネル"))
      .catch(() => false);
    if (has) return frame;
  }
  return undefined;
}

/** 組んで書く面（既定の面）に出ている本文 */
export async function composeText(frame: Frame): Promise<string> {
  return frame.evaluate(() => document.getElementById("compose")?.innerText ?? "");
}

/** 下の欄（`#foot` の中の1つ。`counts`＝字数と表示倍率、`note`＝保存しました など） */
export async function footText(frame: Frame, id: "counts" | "note"): Promise<string> {
  return frame.evaluate((elementId) => document.getElementById(elementId)?.textContent ?? "", id);
}

/**
 * クイックオープンで話を開き、原稿エディターの面が本文を描くまで待つ。
 *
 * @param expected 本文に出るはずの文字（描き終わった目印）
 */
export async function openEpisode(page: Page, fileName: string, expected: string): Promise<Frame> {
  await quickOpen(page, fileName);
  let opened: Frame | undefined;
  await waitUntil(
    async () => {
      for (const frame of await manuscriptFrames(page)) {
        if ((await composeText(frame)).includes(expected)) {
          opened = frame;
          return true;
        }
      }
      return false;
    },
    `原稿エディターで「${fileName}」の本文が描かれる`,
    30_000
  );
  if (!opened) throw new Error("原稿エディターの面が見つかりません");
  return opened;
}

/**
 * 組んで書く面の、`needle` の直後へカーソルを置く（その面へ焦点も移す）。
 *
 * **クリックの座標でなく文字で置く。** 書体や倍率で字の位置が変わっても、
 * 同じ所へ置けるようにするため。
 */
export async function placeCaretAfter(frame: Frame, needle: string): Promise<void> {
  // iframe へ焦点を移す（キーが WebView へ届くようにする）
  await frame.locator("#compose").click();
  const ok = await frame.evaluate((text) => {
    const compose = document.getElementById("compose");
    if (!compose) return false;
    compose.focus();
    const walker = document.createTreeWalker(compose, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = (node.textContent ?? "").indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at + text.length);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return true;
    }
    return false;
  }, needle);
  if (!ok) throw new Error(`組んで書く面に「${needle}」が見つからず、カーソルを置けません`);
}

/**
 * 組んで書く面で、`needle` の字を選ぶ（その面へ焦点も移す）。
 *
 * 見えている字で選ぶ——記法の印（《《 》》など）が組んだ面に出ていなくても、
 * 作者が選ぶのと同じ「見えている語」を選ぶ。`needle` は1つの字の並び
 * （組んだ面の1つの節点の中）にあること
 */
export async function selectText(frame: Frame, needle: string): Promise<void> {
  await frame.locator("#compose").click();
  const ok = await frame.evaluate((text) => {
    const compose = document.getElementById("compose");
    if (!compose) return false;
    compose.focus();
    const walker = document.createTreeWalker(compose, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = (node.textContent ?? "").indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return true;
    }
    return false;
  }, needle);
  if (!ok) throw new Error(`組んで書く面に「${needle}」が見つからず、選べません`);
}

/**
 * 組んで書く面の選択が畳まれているか（カーソルだけで、字を選んでいないか）。
 *
 * 行へ飛んだあとに**行が選ばれていない**ことを見る（作者の裁定、2026-10-03）。
 * 選ばれていると、そのまま打った字で行が置き換わる。
 */
export async function selectionCollapsed(frame: Frame): Promise<boolean> {
  return frame.evaluate(() => {
    const selection = window.getSelection();
    return !!selection && selection.rangeCount > 0 && selection.isCollapsed;
  });
}

/** 飛んだ行の光り（組んで書く面の `novelai-reveal`）が出ているか */
export async function revealFlashLit(frame: Frame): Promise<boolean> {
  return frame.evaluate(() => {
    const registry = (globalThis as unknown as { CSS?: { highlights?: { has(name: string): boolean } } }).CSS
      ?.highlights;
    return !!registry && registry.has("novelai-reveal");
  });
}

/**
 * いまのカーソルの位置を、**本文の中の文字で**表す（行の字と、その行の中の何字目か）。
 *
 * DOM の節点そのものは、保存のあと描き直されると別物になるので比べられない。
 * 「どの行の、何字目か」なら、描き直されても同じ位置なら同じ値になる。
 */
export async function caretPosition(
  frame: Frame
): Promise<{ lineText: string; column: number } | undefined> {
  return frame.evaluate(() => {
    const compose = document.getElementById("compose");
    const selection = window.getSelection();
    if (!compose || !selection || selection.rangeCount === 0) return undefined;
    const range = selection.getRangeAt(0);
    if (!compose.contains(range.startContainer)) return undefined;
    // 組んで書く面は1行を1つの段落（compose の直下の子）で組む。
    // カーソルを含む段落を「この行」とし、段落の頭からカーソルまでの字数を数える
    let line: Node | null = range.startContainer;
    while (line && line.parentNode !== compose) line = line.parentNode;
    if (!line) return undefined;
    const before = document.createRange();
    before.setStart(line, 0);
    before.setEnd(range.startContainer, range.startOffset);
    return { lineText: line.textContent ?? "", column: before.toString().length };
  });
}

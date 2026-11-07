/**
 * 「見た目を作者が見比べる」ための写真撮り（実機確認リストの 〔作者の手：見〕 の項目。2026-10-09）。
 *
 * **通常の `npm run test:e2e` では動かない。** 環境変数 `NOVELAI_LOOK=1` のときだけ動く
 * （`lookEnabled`）。通常の E2E の数を増やさず、写真を撮るためだけに VS Code を起こすことを避ける。
 * 写真の置き場は環境変数 `NOVELAI_LOOK_DIR`（既定は下の `DEFAULT_LOOK_DIR`）。リポジトリには入れない。
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Frame, Locator, Page } from "playwright-core";
import { treeRowLabels } from "../support/sidebar";
import { clearNotifications, dismissWorkbenchHover } from "../support/workbenchDom";

export const lookEnabled = process.env.NOVELAI_LOOK === "1";

const DEFAULT_LOOK_DIR = "C:\\Users\\nonah\\Documents\\novel-ai-bench\\look\\2026-10-09";

export function lookDir(): string {
  return process.env.NOVELAI_LOOK_DIR || DEFAULT_LOOK_DIR;
}

/** 窓ぜんぶの写真を `<行番号>-<短い名前>.png` で残す。道を返す */
export async function shootPage(page: Page, name: string): Promise<string> {
  await mkdir(lookDir(), { recursive: true });
  // 知らせ（右下）が写真に写らないようにする
  await clearNotifications(page);
  await dismissWorkbenchHover(page);
  await page.waitForTimeout(300);
  const file = path.join(lookDir(), `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

/**
 * いまの窓を、**何も触らずに**そのまま撮る（光りが2.5秒で消えるものなど、撮る前の片づけ
 * 〔知らせを消す・マウスを逃がす〕の間にも状態が変わってしまうもの用）
 */
export async function shootNow(page: Page, name: string): Promise<string> {
  await mkdir(lookDir(), { recursive: true });
  const file = path.join(lookDir(), `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

/**
 * 窓ぜんぶの写真を、**知らせ（右下）を消さずに**撮る（知らせの文そのものが見たいもの用）。
 * マウスは吹き出しの出ない下へ逃がす（`dismissWorkbenchHover` は使わない——知らせを閉じる動きが無いので同じ）。
 */
export async function shootPageKeepingToasts(page: Page, name: string): Promise<string> {
  await mkdir(lookDir(), { recursive: true });
  await dismissWorkbenchHover(page);
  await page.waitForTimeout(300);
  const file = path.join(lookDir(), `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

/**
 * 窓ぜんぶの写真に加えて、`clip`（窓の中の座標）だけを切り出した写真 `<name>-拡大.png` も撮る。
 * 狭い列の字など、全体の写真では小さくて読みにくいものを見比べるため
 */
export async function shootWithZoom(
  page: Page,
  name: string,
  clip: { x: number; y: number; width: number; height: number }
): Promise<string> {
  const file = await shootPage(page, name);
  await page.screenshot({ path: path.join(lookDir(), `${name}-拡大.png`), clip });
  return file;
}

/**
 * 撮りながら読んだ事実（行の名前・字の数・見つからなかったもの）を `一覧用のメモ.txt` へ足す。
 * 走らせたときの console.log は読めないので、一覧.md を書く材料はここへ残す
 */
export async function lookNote(text: string): Promise<void> {
  await mkdir(lookDir(), { recursive: true });
  await appendFile(path.join(lookDir(), "一覧用のメモ.txt"), text + "\n", "utf8");
}

/** 左の列の部（作品一覧・簡単ステップメニュー・詳細メニュー）を、開く／畳むに揃える */
export async function setPane(page: Page, title: string, open: boolean): Promise<void> {
  const header = page.locator(".pane-header", { hasText: title }).first();
  const isOpen = async () => (await header.getAttribute("class"))?.split(/\s+/).includes("expanded") === true;
  if ((await isOpen()) !== open) {
    await header.click();
    await page.waitForTimeout(400);
  }
}

/** 左の列の幅を、境目の掴み所を引いて決める。なった幅を返す */
export async function setSidebarWidth(page: Page, width: number): Promise<number> {
  const box = await page.locator(".part.sidebar").first().boundingBox();
  if (!box) throw new Error("左の列の位置が取れません");
  const edge = box.x + box.width;
  await page.mouse.move(edge, 400);
  await page.mouse.down();
  await page.mouse.move(box.x + width, 400, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  return (await page.locator(".part.sidebar").first().boundingBox())?.width ?? 0;
}

/**
 * 名前（aria-label）の頭が `head` の行を、DOM に出るまで左の列の `paneTitle` の区画を転がして返す。
 *
 * **VS Code の木は見えている行しか DOM に描かない**（仮想化）。Mac の画面（1440×795）では窓が
 * 頼んだ高さ（800）まで伸びず、詳細メニューの下のほうの「環境設定」「ヘルプ」が描かれないまま
 * `waitFor` が時間切れになった（2026-11-07）。DOM の `scrollIntoView` は木の中の転がしを動かさないので、
 * 区画の上でホイールを回す。まず下へ、端に着いても（並びが変わらなくなっても）出なければ上へ戻す
 * ——畳んだあとは行が上へ流れて、上にあることもある。窓の高さは足さない（画面より高くはできない）
 */
export async function revealRow(page: Page, head: string, paneTitle = "詳細メニュー", timeoutMs = 30_000): Promise<Locator> {
  const row = page.locator(`.monaco-list-row[aria-label^="${head}"]`).first();
  // 木がまだ描き終わっていないだけのこともあるので、転がす前に少し待つ（前の setRow の待ち方を残す）
  const appeared = await row
    .waitFor({ state: "attached", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) return row;
  const body = page
    .locator(".pane", { has: page.locator(".pane-header", { hasText: paneTitle }) })
    .locator(".pane-body")
    .first();
  const deadline = Date.now() + timeoutMs;
  let direction = 1;
  let last = "";
  let unchanged = 0;
  while ((await row.count()) === 0) {
    if (Date.now() > deadline) {
      throw new Error(`「${head}」の行が出るまで「${paneTitle}」を転がしましたが、出ません（いまの行：${(await treeRowLabels(page)).join(" / ")}）`);
    }
    const box = await body.boundingBox();
    if (!box) {
      // 区画がまだ開いていない・描かれていない。時間切れまで待ち直す
      await page.waitForTimeout(300);
      continue;
    }
    // 上に貼り付く見出し（sticky scroll）の上で回すと先へ送れないので、区画の下寄りで回す（sidebar.ts と同じ）
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.75);
    await page.mouse.wheel(0, 120 * direction);
    await page.waitForTimeout(200);
    const now = (await treeRowLabels(page)).join("\n");
    unchanged = now === last ? unchanged + 1 : 0;
    last = now;
    if (unchanged >= 3) {
      if (direction < 0) {
        throw new Error(`「${head}」の行が「${paneTitle}」のどこにもありません（いまの行：${now.split("\n").join(" / ")}）`);
      }
      direction = -1;
      unchanged = 0;
    }
  }
  return row;
}

/** 名前（aria-label）の頭が `head` の行を、開く／畳むに揃えて、見える所へ転がす */
export async function setRow(page: Page, head: string, open: boolean): Promise<void> {
  const row = await revealRow(page, head);
  await row.waitFor({ state: "attached", timeout: 10_000 });
  await row.scrollIntoViewIfNeeded();
  const expanded = (await row.getAttribute("aria-expanded")) === "true";
  if (expanded !== open) {
    await row.click();
    await page.waitForTimeout(500);
  }
}

/** 人物の色が載っている字（`novelai-term-character` の範囲が指す字）。色が付いたかの待ちに使う */
export async function coloredCharacterTerms(frame: Frame): Promise<string[]> {
  return frame.evaluate(() => {
    const registry = (globalThis as unknown as {
      CSS?: { highlights?: { get(name: string): Iterable<AbstractRange> | undefined } };
    }).CSS?.highlights;
    const highlight = registry?.get("novelai-term-character");
    if (!highlight) return [];
    return (Array.from(highlight) as Range[]).map((range) => range.toString());
  });
}

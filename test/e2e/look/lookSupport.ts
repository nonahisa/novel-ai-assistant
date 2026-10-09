/**
 * 「見た目を作者が見比べる」ための写真撮り（実機確認リストの 〔作者の手：見〕 の項目。2026-10-09）。
 *
 * **通常の `npm run test:e2e` では動かない。** 環境変数 `NOVELAI_LOOK=1` のときだけ動く
 * （`lookEnabled`）。通常の E2E の数を増やさず、写真を撮るためだけに VS Code を起こすことを避ける。
 * 写真の置き場は環境変数 `NOVELAI_LOOK_DIR`（既定は下の `DEFAULT_LOOK_DIR`）。リポジトリには入れない。
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
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

/**
 * 編集者が校閲中の話を原稿エディターで開くと、帯と赤い枠が出て、打てない
 * （作者の裁定 2026-11-07。設計書6.25.12。0.139.0）。
 *
 * 0.138.0 までは、打った字を文書へ入れずに戻すだけで、枠も色も変わらなかった（作者には
 * 「書けた」ように見えた）。ここでは、作者の手元の鍵の台帳に編集者の鍵がある話を開き、
 * - 帯（#reviewLock）が開き、「この話は校閲中です（編集者 kmizu・」で始まる文が出る
 * - 書く面の枠に印（#surface の review-locked）が付く
 * - 打っても原稿ファイルが変わらない
 * を見る。
 *
 * 鍵の台帳を取りに行く道（git fetch）は、この作品に編集用の置き場の覚えが無いので走らない
 * （`refreshEditorLocksQuietly` が noPointer で返る）。台帳は起こす前に置く。
 *
 * **AI は呼ばない。**（0.139.0 で書いた。まだ走らせていない）
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { classOpen, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";

const EPISODE = "001_校閲中.txt";
const TEXT = "　朝の駅は静かだった。\n　改札を抜けて、白い息を吐いた。\n";

test("校閲中の話は、帯と赤い枠が出て、打っても原稿に入らない", async () => {
  await withVsCode(
    "校閲中の帯",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, EPISODE, "改札を抜けて");

      await waitUntil(() => classOpen(frame, "reviewLock"), "校閲中の帯が開く", 15_000);
      const band = await frame.evaluate(() => document.getElementById("reviewLockText")?.textContent ?? "");
      expect(band.startsWith("この話は校閲中です（編集者 kmizu・")).toBe(true);
      expect(band).not.toContain("Kei Mizushima");
      const framed = await frame.evaluate(
        () => document.getElementById("surface")?.classList.contains("review-locked") === true
      );
      expect(framed).toBe(true);

      await placeCaretAfter(frame, "朝の");
      await page.keyboard.insertText("早い");
      await page.waitForTimeout(1500);
      await page.keyboard.press("ControlOrMeta+KeyS");
      await page.waitForTimeout(1000);
      const file = (await readFile(path.join(session.manuscriptFolder, EPISODE), "utf8")).replace(/\r\n/g, "\n");
      expect(file).toBe(TEXT);
    },
    {
      prepareWork: async ({ workFolder, manuscriptFolder }) => {
        const relative = path.relative(workFolder, path.join(manuscriptFolder, EPISODE)).split(path.sep).join("/");
        const locks = path.join(workFolder, ".aiwriter", "locks");
        await mkdir(locks, { recursive: true });
        await writeFile(
          path.join(locks, "locks.jsonl"),
          JSON.stringify({
            kind: "acquire",
            file: relative,
            holder: "Kei Mizushima",
            holderKind: "editor",
            time: new Date(Date.now() - 60_000).toISOString(),
            note: "",
          }) + "\n",
          "utf8"
        );
        await writeFile(
          path.join(workFolder, ".aiwriter", "editing.json"),
          JSON.stringify({ editorLogin: "kmizu" }, null, 2) + "\n",
          "utf8"
        );
      },
    }
  );
}, 180_000);

/**
 * 人物相関図の個人中心図で、線の上の文字が重ならない（画面の自動テスト、設計書6.38.2・6.113）。
 *
 * 実機確認リスト 0.96.8 の項目を機械へ移したもの（2026-10-03）。0.96.4 の実機で、
 * 相手の多い人物（教科書チート_確認用の「アブス」）を中心にすると、線の上の文字が
 * 中心の点の近くに寄って重なり、読めなかった。0.96.8 で文字を向きごとに1つへ縮め
 * （「→同席 ほか2／←上司」の形）、置き場を散らした。
 *
 * 単体テスト（`core/relationGraphLayout.test.ts`）は**見積もった字幅**で重なりを見ている。
 * ここでは**本物の画面に描かれた字の矩形**（`getBoundingClientRect`）で見る。
 * 読みやすいかの良し悪しは見ていない。
 *
 * 人物の記録は製品が読む形（`models/character.ts` の `emptyCharacter` に中身を足したもの）で置く。
 * **AI は呼ばない。**
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { emptyCharacter, type Character } from "../../src/models/character";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";

const OPEN_GRAPH_KEY = "ctrl+alt+shift+f3";
const OPEN_GRAPH_PRESS = "Control+Alt+Shift+F3";

const HUB = "アブス";
const PARTNERS = ["イント", "バッケ", "アン", "マイナ様", "ロウ", "シエナ"];

/** 中心の人物と、相手ごとに両向きの関係を持つ人たち（0.96.4 の実機の形に寄せる） */
function cast(): Character[] {
  const hub: Character = {
    ...emptyCharacter("char_001", HUB),
    appearedChapters: [1, 2, 3],
    relations: PARTNERS.flatMap((name) => [
      { name, relation: "同席" },
      { name, relation: "兼職男子" },
      { name, relation: "同じ寮の住人" },
    ]),
  };
  const partners = PARTNERS.map((name, index): Character => ({
    ...emptyCharacter(`char_${String(index + 2).padStart(3, "0")}`, name),
    appearedChapters: [1],
    relations: [{ name: HUB, relation: "上司にあたる人" }],
  }));
  return [hub, ...partners];
}

/** 作品の設定資料の置き場（登録で作られた `.aiwriter/config.json` の settingsDir） */
async function charactersFolder(session: E2ESession): Promise<string> {
  const config = JSON.parse(
    await readFile(path.join(session.workFolder, ".aiwriter", "config.json"), "utf8")
  ) as { settingsDir?: string };
  return path.join(session.workFolder, config.settingsDir || "設定", "characters");
}

/** 相関図の面（SVG の人物の点 `.g-node` を持つ） */
async function graphFrame(session: E2ESession): Promise<Frame | undefined> {
  for (const frame of session.page.frames()) {
    const has = await frame.evaluate(() => document.querySelector(".g-node") !== null).catch(() => false);
    if (has) return frame;
  }
  return undefined;
}

interface Box {
  text: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

test("個人中心図（相手の多い人）で、線の上の文字が向きごとに1つになり、描かれた字の矩形どうしが重ならず、右の一覧には全部が並ぶ", async () => {
  await withVsCode(
    "相関図の線の文字",
    [{ name: "001_はじまり.txt", text: "アブスはイントと同席した。\n" }],
    async (session) => {
      const { page } = session;
      const folder = await charactersFolder(session);
      await mkdir(folder, { recursive: true });
      for (const character of cast()) {
        await writeFile(
          path.join(folder, `${character.id}_${character.name}.json`),
          JSON.stringify(character, null, 2),
          "utf8"
        );
      }

      await page.keyboard.press(OPEN_GRAPH_PRESS);
      let graph: Frame | undefined;
      await waitUntil(async () => (graph = await graphFrame(session)) !== undefined, "人物相関図に人物の点が並ぶ", 30_000);
      if (!graph) throw new Error("人物相関図の面が見つかりません");

      // 中心の人物の点を押して、個人中心図にする
      await graph.locator(".g-node", { hasText: HUB }).first().locator(".g-node-hit").click({ force: true });
      const frame = graph;
      await waitUntil(
        async () =>
          (await frame.locator(".g-node-circle.g-center").count()) === 1 &&
          (await frame.locator(".g-edge-label").count()) === PARTNERS.length,
        `「${HUB}」の個人中心図になり、線の文字が相手の数だけ並ぶ`,
        15_000
      );

      const boxes: Box[] = await frame.evaluate(() =>
        Array.from(document.querySelectorAll(".g-edge-label")).map((label) => {
          const rect = label.getBoundingClientRect();
          return { text: label.textContent ?? "", left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        })
      );

      // 文字は向きごとに1つ（「→同席 ほか2／←上司にあたる人」の形）
      for (const box of boxes) {
        expect(box.text, "線の上の文字の形").toMatch(/^→同席 ほか2／←上司にあたる人$/);
        expect(box.right - box.left, `「${box.text}」が描かれていません`).toBeGreaterThan(0);
      }

      // 描かれた字の矩形どうしが重ならない
      const overlaps: string[] = [];
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const b = boxes[j];
          if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
            overlaps.push(`${i}番と${j}番（${JSON.stringify(a)} ／ ${JSON.stringify(b)}）`);
          }
        }
      }
      expect(overlaps, "線の上の文字が重なっています").toEqual([]);

      // 右の「つながっている人」には、従来どおり全部が並ぶ（線の上で省いた分もここで読める）
      const sideRows: string[] = await frame.evaluate(() =>
        Array.from(document.querySelectorAll(".side-row"))
          .filter((row) => row.querySelector(".person-link") !== null)
          .map((row) => (row as HTMLElement).innerText.trim())
      );
      expect(sideRows).toHaveLength(PARTNERS.length);
      for (const name of PARTNERS) {
        expect(sideRows, `「つながっている人」に${name}の行がありません`).toContain(
          `${name} →同席・兼職男子・同じ寮の住人／←上司にあたる人`
        );
      }
    },
    { keybindings: [{ key: OPEN_GRAPH_KEY, command: "novelai.openRelationGraph" }] }
  );
});

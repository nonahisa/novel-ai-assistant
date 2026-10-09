/**
 * 場所の略図（設計書6.93.10）の写真。作者が見た目の良し悪しを判断するための写真で、
 * 判断そのものはしない。`NOVELAI_LOOK=1` のときだけ動く。作品は使い捨ての見本だけ。
 *
 * 写すもの：決まった位置・方角だけ・距離だけ・含む（枠）・隣接・位置未定の棚・
 * 乗り物の換算・食い違いの赤い線・作者が置いた点と注意の印・関係でつながらない島。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { describe, test } from "vitest";
import { emptyLocation, type Location, type LocationRelation } from "../../../src/models/location";
import { DEFAULT_SETTINGS_DIR } from "../../../src/models/types";
import { withVsCode, type E2ESession } from "../support/vscodeApp";
import { pressWorkbenchKey } from "../support/workbenchDom";
import { waitUntil } from "../support/wait";
import { lookEnabled, lookNote, shootPage } from "./lookSupport";

const OPEN_KEY = "ctrl+alt+shift+g";
const OPEN_PRESS = "Control+Alt+Shift+G";

function rel(
  kind: LocationRelation["kind"],
  target: string,
  value: string | null = null,
  extra: Partial<LocationRelation> = {}
): LocationRelation {
  return { kind, target, targetId: null, value, chapters: [], evidence: null, authorLocked: false, ...extra };
}

function place(id: string, name: string, relations: LocationRelation[] = [], extra: Partial<Location> = {}): Location {
  return { ...emptyLocation(id, name), appearedChapters: [1], relations, ...extra };
}

function world(): Location[] {
  return [
    place("loc_001", "王都"),
    place("loc_002", "大聖堂", [rel("within", "王都"), rel("direction", "市場", "北"), rel("distance", "市場", "徒歩10分")]),
    place("loc_003", "市場", [rel("within", "王都")]),
    place("loc_004", "港町", [rel("direction", "王都", "東"), rel("distance", "王都", "馬車で半日")]),
    place("loc_005", "港", [
      rel("within", "港町"),
      rel("direction", "学校", "北", { chapters: [2], evidence: "港は学校の北に見えた" }),
    ]),
    place("loc_006", "学校", [
      rel("direction", "港", "北", { chapters: [1], evidence: "学校は港の北の高台にある" }),
      rel("distance", "港", "徒歩1時間", { chapters: [1] }),
    ]),
    place("loc_007", "灯台", [rel("adjacent", "港")]),
    place("loc_008", "黒い森", [rel("direction", "王都", "北")]),
    place("loc_009", "砦", [rel("distance", "王都", "徒歩2時間")], { sketchPosition: { x: -80, y: 260 } }),
    place("loc_010", "風車の丘"),
    place("loc_011", "北の村"),
    place("loc_012", "峠", [rel("direction", "北の村", "西"), rel("distance", "北の村", "徒歩3時間")]),
    place("loc_013", "水車小屋", [rel("direction", "王都", "上流")]),
  ];
}

async function sketchFrame(session: E2ESession): Promise<Frame | undefined> {
  for (const frame of session.page.frames()) {
    const has = await frame.evaluate(() => document.querySelector(".s-point") !== null).catch(() => false);
    if (has) return frame;
  }
  return undefined;
}

describe.skipIf(!lookEnabled)("見た目の写真：場所の略図", () => {
  test("略図を開き、点を選び、赤い線を押す", async () => {
    const locations = world();
    await withVsCode(
      "見た目の写真：場所の略図",
      [
        { name: "001_はじまり.txt", text: "学校は港の北の高台にある。\n" },
        { name: "002_つづき.txt", text: "港は学校の北に見えた。\n" },
      ],
      async (session) => {
        const { page } = session;
        await pressWorkbenchKey(page, OPEN_PRESS);
        let frame: Frame | undefined;
        await waitUntil(
          async () => (frame = await sketchFrame(session)) !== undefined && (await frame.locator(".s-point").count()) === locations.length,
          "略図に点が並ぶ",
          30_000
        );
        await page.waitForTimeout(800);
        await shootPage(page, "04-略図の全体（字を縮めない）");

        // 点を選ぶ（右に置き方と操作が出る）
        await frame!.locator('.s-point[data-id="loc_007"] .s-dot').click({ force: true });
        await page.waitForTimeout(500);
        await shootPage(page, "05-点を選んだところ");

        // 赤い線を押す（提案パネルの「矛盾」の同じ行へ）
        await frame!.locator(".s-conflict-label").first().click({ force: true });
        await page.waitForTimeout(4000);
        await shootPage(page, "06-赤い線から提案パネルへ（本文で隠さない）");
        await lookNote("場所の略図（作者の裁定 2026-10-10 のあと）：04 全体／05 点を選ぶ／06 赤い線から提案パネル");
      },
      {
        keybindings: [{ key: OPEN_KEY, command: "novelai.openLocationSketch" }],
        windowSize: { width: 1400, height: 860 },
        prepareWork: async ({ workFolder }) => {
          const folder = path.join(workFolder, DEFAULT_SETTINGS_DIR, "locations");
          await mkdir(folder, { recursive: true });
          for (const location of locations) {
            await writeFile(
              path.join(folder, `${location.id}_${location.name}.json`),
              `${JSON.stringify(location, null, 2)}\n`,
              "utf8"
            );
          }
        },
      }
    );
  });
});

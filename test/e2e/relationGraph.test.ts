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
import { holdsFor, waitUntil } from "./support/wait";

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

/** 人物の記録を、製品が読む形で設定資料の置き場へ書く */
async function writeCast(session: E2ESession, characters: readonly Character[]): Promise<void> {
  const folder = await charactersFolder(session);
  await mkdir(folder, { recursive: true });
  for (const character of characters) {
    await writeFile(
      path.join(folder, `${character.id}_${character.name}.json`),
      JSON.stringify(character, null, 2),
      "utf8"
    );
  }
}

/** 相関図を開き、人物の点が並ぶまで待つ */
async function openGraph(session: E2ESession): Promise<Frame> {
  await session.page.keyboard.press(OPEN_GRAPH_PRESS);
  let graph: Frame | undefined;
  await waitUntil(async () => (graph = await graphFrame(session)) !== undefined, "人物相関図に人物の点が並ぶ", 30_000);
  if (!graph) throw new Error("人物相関図の面が見つかりません");
  return graph;
}

/** いま中心にいる人の名前（個人中心図でなければ null） */
async function centerName(frame: Frame): Promise<string | null> {
  return frame.evaluate(() => {
    const circle = document.querySelector(".g-node-circle.g-center");
    const label = circle?.parentElement?.querySelector(".g-node-label");
    return label ? label.textContent : null;
  });
}

/** 名前がちょうど一致する人物の点を押す（`hasText` は部分一致なので使わない） */
async function clickPerson(frame: Frame, name: string): Promise<void> {
  const index = await frame.evaluate((target) => {
    const labels = Array.from(document.querySelectorAll(".g-node .g-node-label"));
    return labels.findIndex((label) => label.textContent === target);
  }, name);
  if (index < 0) throw new Error(`「${name}」の点が図にありません`);
  await frame.locator(".g-node").nth(index).locator(".g-node-hit").click({ force: true });
}

/*
  相手30人（作者の実機確認、2026-10-04、教科書チート_確認用の「イント」）。
  相手6人の作り物では重ならなかったが、相手が30人前後になると中心の近くで線の
  文字が何十個も重なって読めなかった。置き場の無い線には文字を出さず、右の
  「つながっている人」に任せる（設計書6.38.2）。

  **何も描かなくても「重ならない」は満点になる**ので、描かれた数の下限と、
  省かれたものがあること（30本ぜんぶは置けない）も併せて見る。
*/
const CROWD_HUB = "イント";
const CROWD_SIZE = 30;

function crowdCast(): Character[] {
  // 相手の名前に中心の名前を含めない（部分一致の取り違えを避ける）
  const names = Array.from({ length: CROWD_SIZE }, (_, index) => `相手${String(index + 1).padStart(2, "0")}`);
  const hub: Character = {
    ...emptyCharacter("char_001", CROWD_HUB),
    appearedChapters: [1, 2, 3],
    // 偶数番だけ中心から関係を持つ。奇数番は相手からの片向きだけ（「→なし／←…」の形になる線）
    relations: names.flatMap((name, index) =>
      index % 2 === 0
        ? [
            { name, relation: "同行者" },
            { name, relation: "継子" },
          ]
        : []
    ),
  };
  const partners = names.map((name, index): Character => ({
    ...emptyCharacter(`char_${String(index + 2).padStart(3, "0")}`, name),
    appearedChapters: [1],
    // 6の倍数番は中心への関係を持たない（「→同行者 ほか1」だけの線。偶数番なので中心からの関係はある）
    relations: index % 6 === 0 ? [] : [{ name: CROWD_HUB, relation: "主人" }],
  }));
  return [hub, ...partners];
}

test("個人中心図（相手30人）で、描かれた線の文字の矩形が重ならず、置き場の無い線は文字を省き、「なし」は出ない", async () => {
  const characters = crowdCast();
  const partnerCount = characters.length - 1;
  await withVsCode(
    "相関図の線の文字（相手30人）",
    [{ name: "001_はじまり.txt", text: "イントは皆と旅に出た。\n" }],
    async (session) => {
      await writeCast(session, characters);
      const frame = await openGraph(session);
      await clickPerson(frame, CROWD_HUB);
      // 文字が何本残るかは前もって決まらないので、右の一覧が揃うのを待つ（図と同じ描き直しで出る）
      await waitUntil(
        async () =>
          (await centerName(frame)) === CROWD_HUB &&
          (await frame.locator(".side-row .person-link").count()) === partnerCount,
        `「${CROWD_HUB}」の個人中心図になり、右の一覧に相手が${partnerCount}人並ぶ`,
        15_000
      );

      const boxes: Box[] = await frame.evaluate(() =>
        Array.from(document.querySelectorAll(".g-edge-label")).map((label) => {
          const rect = label.getBoundingClientRect();
          return { text: label.textContent ?? "", left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        })
      );

      // 描かれた数：空振り（1つも描かない）を通さない下限と、全部は置けないこと
      expect(boxes.length, "線の文字が少なすぎます（置ける所にも置いていない）").toBeGreaterThanOrEqual(8);
      expect(boxes.length, "相手30人の線にぜんぶ文字を置いています（重なりを避けて省いていない）").toBeLessThan(partnerCount);

      for (const box of boxes) {
        expect(box.text, "中身の無い「なし」を出しています").not.toMatch(/なし/);
        expect(box.right - box.left, `「${box.text}」が描かれていません`).toBeGreaterThan(0);
      }

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
    },
    { keybindings: [{ key: OPEN_GRAPH_KEY, command: "novelai.openRelationGraph" }] }
  );
});

/*
  マウスの戻る・進むボタン（作者の実機確認、2026-10-04「マウスの戻るボタンで反応が欲しいです」。
  設計書6.38.4）。Playwright の mouse は左・右・中しか押せないので、Chromium の入力の口
  （CDP の Input.dispatchMouseEvent、button "back"／"forward"）から、図の上で横のボタンを押す。
  届くのは本物の押下と同じ経路（ワークベンチ → WebView の iframe）で、
  拡張機能の外のマウスのソフトや OS の割り当ては通らない。
*/
type MouseSide = "back" | "forward";

/**
 * 横のボタンを押す（`release` で離す）。押すと離すを分けてあるのは、
 * **押した時点で動く**ことを見るため——VS Code 本体も横のボタンは押した時点
 * （mousedown）で動かし、離したとき（mouseup）は既定を止めるだけにしている。
 * 離したときにも動くと、1回の押下で2つぶん動く。
 */
async function sendMouseSide(
  session: E2ESession,
  frame: Frame,
  side: MouseSide,
  phase: "mousePressed" | "mouseReleased"
): Promise<void> {
  const box = await frame.locator("#graph").boundingBox();
  if (!box) throw new Error("図の場所が測れません");
  // 図の真ん中は中心の人の点なので、点も線も無い左上の隅を押す
  const x = Math.round(box.x + 20);
  const y = Math.round(box.y + 20);
  const cdp = await session.page.context().newCDPSession(session.page);
  try {
    if (phase === "mousePressed") {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    }
    const buttons = phase === "mousePressed" ? (side === "back" ? 8 : 16) : 0;
    await cdp.send("Input.dispatchMouseEvent", { type: phase, x, y, button: side, buttons, clickCount: 1 });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

test("相関図の上でマウスの戻るボタンを押すと［戻る］と同じく前の中心へ戻り、進むボタンで戻ったぶんを進み、図は白くならない", async () => {
  await withVsCode(
    "相関図のマウスの戻る",
    [{ name: "001_はじまり.txt", text: "アブスはイントと同席した。\n" }],
    async (session) => {
      await writeCast(session, cast());
      const frame = await openGraph(session);

      // 全体図 → アブス → イント（履歴が2段になる）
      await clickPerson(frame, HUB);
      await waitUntil(async () => (await centerName(frame)) === HUB, `「${HUB}」が中心になる`, 15_000);
      await clickPerson(frame, PARTNERS[0]);
      await waitUntil(async () => (await centerName(frame)) === PARTNERS[0], `「${PARTNERS[0]}」が中心になる`, 15_000);
      await waitUntil(async () => !(await frame.locator("#back").isDisabled()), "［戻る］が押せるようになる", 5_000);

      // 押しただけで戻る（離す前）
      await sendMouseSide(session, frame, "back", "mousePressed");
      await waitUntil(
        async () => (await centerName(frame)) === HUB,
        `マウスの戻るボタンを押した時点で「${HUB}」の図へ戻る`,
        10_000
      );
      // 離しても、もう1つ戻らない（全体図へ行かない）。図が白くなっていない
      await sendMouseSide(session, frame, "back", "mouseReleased");
      await holdsFor(
        async () => (await centerName(frame)) === HUB,
        "離したときにも動かず、1回の押下で1つだけ戻る",
        1_500
      );
      expect(await frame.locator(".g-node").count(), "図の点が消えています").toBeGreaterThan(0);

      await sendMouseSide(session, frame, "forward", "mousePressed");
      await waitUntil(
        async () => (await centerName(frame)) === PARTNERS[0],
        `マウスの進むボタンを押した時点で「${PARTNERS[0]}」の図へ進む`,
        10_000
      );
      await sendMouseSide(session, frame, "forward", "mouseReleased");
      await holdsFor(
        async () => (await centerName(frame)) === PARTNERS[0],
        "離したときにも動かず、1回の押下で1つだけ進む",
        1_500
      );
      expect(await frame.locator(".g-node").count(), "図の点が消えています").toBeGreaterThan(0);
    },
    { keybindings: [{ key: OPEN_GRAPH_KEY, command: "novelai.openRelationGraph" }] }
  );
});

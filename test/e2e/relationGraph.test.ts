/**
 * 人物相関図の個人中心図で、関係が周りの人の名前の下に重ならずに書かれ、線の上には
 * 文字が無い（画面の自動テスト、設計書6.38.2・6.113）。
 *
 * 0.96.4〜0.98.7 は線の上に関係を書いていたが、相手30人前後の人物（教科書チート_確認用の
 * 「イント」）では文字が中心の近くに集まって読めなかった。作者の裁定（2026-10-04）
 * 「関係は人の名前の下に書く」で、線の上の文字をやめ、名前の下へ移した。
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
import { CAPTION_BOX_HEIGHT, NODE_LABEL_BOX_HEIGHT } from "../../src/core/relationGraphLayout";
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

/** 描かれた要素の矩形（画面の座標）。文字は textContent、円は「円」と名乗る */
async function rectsOf(frame: Frame, selector: string): Promise<Box[]> {
  return frame.evaluate((query) =>
    Array.from(document.querySelectorAll(query)).map((element) => {
      const rect = element.getBoundingClientRect();
      const text = element.tagName.toLowerCase() === "circle" ? "円" : element.textContent ?? "";
      return { text, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    })
  , selector);
}

function intersects(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * 名前の下の文字が、ほかの名前の下の文字・人物の名前・人物の円と重ならないかを並べる。
 * 名前どうしの重なりは見ない（名前の置き場は今回の変更の外で、相手30人の環の上下では
 * 隣の名前が元から近い）
 */
async function captionOverlaps(frame: Frame): Promise<string[]> {
  const captions = await rectsOf(frame, ".g-node-caption");
  const names = await rectsOf(frame, ".g-node-label");
  const circles = await rectsOf(frame, ".g-node-circle");
  const problems: string[] = [];
  captions.forEach((caption, index) => {
    for (const other of [...captions.slice(index + 1), ...names, ...circles]) {
      if (intersects(caption, other)) {
        problems.push(`「${caption.text}」と「${other.text}」（${JSON.stringify(caption)} ／ ${JSON.stringify(other)}）`);
      }
    }
  });
  return problems;
}

test("個人中心図（相手6人）で、関係が名前の下に中心から見た形で書かれ、線の上に文字が無く、名前の下の文字が重ならず、右の一覧には全部が並ぶ", async () => {
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
          (await frame.locator(".g-node-caption").count()) === PARTNERS.length,
        `「${HUB}」の個人中心図になり、名前の下の文字が相手の数だけ並ぶ`,
        15_000
      );

      // 線の上には文字が無い（線を押せば右に出る）
      expect(await frame.locator(".g-edge-label").count(), "線の上に文字があります").toBe(0);

      // 中心から見た関係を矢印なしで、入るぶんだけ（「同席・兼職男子 ほか1」の形）
      const boxes = await rectsOf(frame, ".g-node-caption");
      for (const box of boxes) {
        expect(box.text, "名前の下の文字の形").toBe("同席・兼職男子 ほか1");
        expect(box.right - box.left, `「${box.text}」が描かれていません`).toBeGreaterThan(0);
      }

      expect(await captionOverlaps(frame), "名前の下の文字が重なっています").toEqual([]);

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
  文字が何十個も重なって読めなかった。作者の裁定「関係は人の名前の下に書く」で、
  線の上の文字をやめ、名前の下（置けなければ上・横など）へ移した。どこにも置けない
  人は省き、右の「つながっている人」に数を添える（設計書6.38.2）。

  **何も描かなくても「重ならない」は満点になる**ので、描かれた数の下限も見る。
*/
const CROWD_HUB = "イント";
const CROWD_SIZE = 30;

function crowdCast(): Character[] {
  // 相手の名前に中心の名前を含めない（部分一致の取り違えを避ける）
  const names = Array.from({ length: CROWD_SIZE }, (_, index) => `相手${String(index + 1).padStart(2, "0")}`);
  const hub: Character = {
    ...emptyCharacter("char_001", CROWD_HUB),
    appearedChapters: [1, 2, 3],
    // 偶数番だけ中心から関係を持つ（作者の画面の「→継子 ほか4」の長さに寄せる）。
    // 奇数番は相手からの片向きだけ（以前は「→なし／←…」と書いていた線）
    relations: names.flatMap((name, index) =>
      index % 2 === 0
        ? ["同行者", "継子", "弟子", "護衛", "旅の仲間"].map((relation) => ({ name, relation }))
        : []
    ),
  };
  const partners = names.map((name, index): Character => ({
    ...emptyCharacter(`char_${String(index + 2).padStart(3, "0")}`, name),
    appearedChapters: [1],
    // 6の倍数番は中心への関係を持たない（「→同行者 ほか4」だけの線。偶数番なので中心からの関係はある）
    relations: index % 6 === 0 ? [] : [{ name: CROWD_HUB, relation: "主人にあたる人" }],
  }));
  return [hub, ...partners];
}

test("個人中心図（相手30人）で、線の上に文字が無く、名前の下の文字が円・名前・ほかの名前の下の文字と重ならず、省いた人の数が右に出て、「なし」は出ない", async () => {
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

      // 線の上には文字が無い
      expect(await frame.locator(".g-edge-label").count(), "線の上に文字があります").toBe(0);

      const boxes = await rectsOf(frame, ".g-node-caption");
      // 描かれた数：空振り（1つも描かない）を通さない下限。配置の見積もりでは30人中27人に置ける
      expect(boxes.length, "名前の下の文字が少なすぎます（置ける所にも置いていない）").toBeGreaterThanOrEqual(20);

      for (const box of boxes) {
        expect(box.text, "中身の無い「なし」を出しています").not.toMatch(/なし/);
        expect(box.right - box.left, `「${box.text}」が描かれていません`).toBeGreaterThan(0);
      }

      // 配置が見積もった字の箱の高さに、描かれた字の高さ（SVG の座標。拡大率に依らない）が収まる。
      // 収まらないと、配置の上では重ならない名前と名前の下の文字が、画面では縦に重なる
      const heights = await frame.evaluate(() => ({
        captions: Array.from(document.querySelectorAll(".g-node-caption")).map(
          (label) => (label as SVGGraphicsElement).getBBox().height
        ),
        names: Array.from(document.querySelectorAll(".g-node-label")).map(
          (label) => (label as SVGGraphicsElement).getBBox().height
        ),
      }));
      for (const height of heights.captions) {
        expect(height, "名前の下の文字が、配置の見積もりより高い").toBeLessThanOrEqual(CAPTION_BOX_HEIGHT);
      }
      for (const height of heights.names) {
        expect(height, "名前が、配置の見積もりより高い").toBeLessThanOrEqual(NODE_LABEL_BOX_HEIGHT);
      }

      expect(await captionOverlaps(frame), "名前の下の文字が重なっています").toEqual([]);

      // 省いた人がいれば、その数が右の一覧の説明に出る（黙って消さない）。いなければ出ない
      const sideText: string = await frame.evaluate(() => (document.querySelector("#side") as HTMLElement | null)?.innerText ?? "");
      const omitted = partnerCount - boxes.length;
      if (omitted > 0) {
        expect(sideText).toContain(`${omitted}人は名前の下の関係を省いています`);
      } else {
        expect(sideText).not.toContain("名前の下の関係を省いています");
      }
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

/**
 * 人物の重複の候補を、設定資料パネルの一覧から押し切る（画面の自動テスト、設計書6.5.4・6.40.4・6.113）。
 *
 * 作者の依頼と裁定（2026-10-19 夜）：「一回ごとにメニューが出るのはツライ」、置き場所は「両方」。
 * 見張るのは次のとおり。
 *
 * - 設定資料パネルの登場人物タブの一覧の上に「重複の候補 3組」が出る
 * - ［「A」を残してまとめる］を2回・［別人］を1回、**メニュー（選ぶ画面）も確認の窓も開かずに**押し切れる。
 *   押すたびにその組だけが消え、パネルは閉じない。最後の1組を片づけると欄が消える
 * - 押した結果は**ファイルで見る**：まとめた側は残した人物の別名になり、取り下げた側のファイルは
 *   回復用の場所へ移る。別人にした2人は distinctFrom で互いを指す
 * - 名前を押すと、その人物の中身が右に開く（見比べる口）
 * - まとめた直後の帯の［戻す］で、まとめる前の2人に戻る（作者の裁定 2026-10-20・10-22）
 * - 校正・メモパネルの「人物の重複の候補が 3組あります」の［設定資料パネルで見る］で、
 *   設定資料パネルが登場人物タブの候補の欄を出して開く
 *
 * 候補の顔ぶれがちょうど3組になることは単体テスト
 * （`unit/features/settingsPanelMergeCandidates.test.ts`「見本の顔ぶれは、ちょうど3組の候補になる」）が固めている。
 * **AI は呼ばない。**
 *
 * 走らせ方（作者が母艦にいるあいだはノートPCで）：
 *   npm run build
 *   npx vitest run --config vitest.e2e.config.mts test/e2e/settingsMergeCandidates.test.ts
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { characterFileName, emptyCharacter, type Character } from "../../src/models/character";
import { readJsonWhenPresent } from "./support/fileSettle";
import { memoPanelFrame, openEpisode, placeCaretAfter } from "./support/manuscriptFrame";
import { charactersFolder, defaultCharactersFolder, settingsPanelFrame, writeCharactersTo } from "./support/settingsFixture";
import { withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { dialogText, quickPickTitle } from "./support/workbenchDom";

const OPEN_SETTINGS_KEY = "ctrl+alt+shift+f1";
const OPEN_SETTINGS_PRESS = "Control+Alt+Shift+F1";

/** 候補がちょうど3組になる顔ぶれ（省略形・姓名と名だけ・後ろに含む） */
function cast(): Character[] {
  return [
    { ...emptyCharacter("char_001", "ギルドマスター"), appearedChapters: [1] },
    { ...emptyCharacter("char_002", "ギルマス"), appearedChapters: [1], authorNotes: "ギルマスのメモ" },
    { ...emptyCharacter("char_003", "三門太志"), appearedChapters: [1] },
    { ...emptyCharacter("char_004", "太志"), appearedChapters: [1] },
    { ...emptyCharacter("char_005", "近所のおばあさん"), appearedChapters: [1] },
    { ...emptyCharacter("char_006", "ばあさん"), appearedChapters: [1] },
  ];
}

const EPISODE = "001_ギルド.md";
const TEXT =
  "ギルドマスターは書類を置いた。\nギルマスと呼ばれるのは嫌いだった。\n" +
  "三門太志は黙っていた。太志は眠そうだった。\n" +
  "近所のおばあさんが手を振った。ばあさんは笑った。\n";

const launchOptions: LaunchOptions = {
  keybindings: [{ key: OPEN_SETTINGS_KEY, command: "novelai.openSettingsPanel" }],
  // 人物は起こす前に置く（起きてから書くと「外で変更されました」の知らせが揺れて出る）
  prepareWork: async ({ workFolder }) => {
    await writeCharactersTo(defaultCharactersFolder(workFolder), cast());
  },
};

async function openSettings(session: E2ESession): Promise<Frame> {
  await session.page.keyboard.press(OPEN_SETTINGS_PRESS);
  let panel: Frame | undefined;
  await waitUntil(async () => (panel = await settingsPanelFrame(session)) !== undefined, "設定資料パネルが開く", 30_000);
  if (!panel) throw new Error("設定資料パネルの面が見つかりません");
  return panel;
}

/** 候補の欄に並んでいる組（`data-pair` の id の組） */
async function candidatePairs(frame: Frame): Promise<string[]> {
  return frame.evaluate(() =>
    Array.from(document.querySelectorAll("#merge-candidates .merge-card")).map(
      (card) => card.getAttribute("data-pair") ?? ""
    )
  );
}

async function bandText(frame: Frame): Promise<string> {
  return frame.evaluate(() => (document.querySelector("#list .merge-band") as HTMLElement | null)?.innerText ?? "");
}

/** 組の中のボタンを、字で選んで押す */
async function pressInPair(frame: Frame, pair: string, label: string): Promise<void> {
  await frame.locator(`.merge-card[data-pair="${pair}"] .merge-actions button`, { hasText: label }).click();
}

/** メニュー（選ぶ画面）も確認の窓も出ていない */
async function noMenuNorDialog(session: E2ESession): Promise<boolean> {
  return (await quickPickTitle(session.page)) === undefined && (await dialogText(session.page)) === undefined;
}

async function recoveredCount(session: E2ESession): Promise<number> {
  const folder = path.join(await charactersFolder(session), ".novelai-recovery");
  return (await readdir(folder).catch(() => [] as string[])).filter((name) => name.endsWith(".bak")).length;
}

test("設定資料パネルの重複の候補3組を、［まとめる］2回と［別人］1回で、メニューも確認の窓も開かずに押し切れる", async () => {
  await withVsCode(
    "重複の候補を一覧で片づける",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const frame = await openSettings(session);
      await waitUntil(
        async () => (await candidatePairs(frame)).length === 3,
        `登場人物タブに重複の候補が3組並ぶ（いま：${JSON.stringify(await candidatePairs(frame).catch(() => []))}）`,
        15_000
      );
      expect(await frame.locator("#merge-candidates .merge-title").innerText()).toBe("重複の候補 3組");
      const folder = await charactersFolder(session);

      // 名前を押すと、その人物の中身が右に開く（見比べる口）
      await frame.locator('.merge-card[data-pair="char_001|char_002"] .merge-name', { hasText: "ギルマス" }).click();
      await waitUntil(
        async () => (await frame.locator("#detail h2").innerText().catch(() => "")).startsWith("ギルマス"),
        "名前を押すと「ギルマス」の中身が開く",
        10_000
      );

      // ── 1組目：ギルドマスターを残してまとめる ──
      await pressInPair(frame, "char_001|char_002", "「ギルドマスター」を残してまとめる");
      await waitUntil(
        async () => !(await candidatePairs(frame)).includes("char_001|char_002"),
        "まとめた組が候補から消える",
        15_000
      );
      expect(await candidatePairs(frame)).toEqual(["char_003|char_004", "char_005|char_006"]);
      expect(await bandText(frame)).toContain("「ギルマス」を「ギルドマスター」にまとめました");
      expect(await noMenuNorDialog(session), "メニューか確認の窓が出ています").toBe(true);
      // ファイル：残した人物の別名にまとめた側の名前が入り、作者のメモも引き継ぐ
      const guild = await readJsonWhenPresent<Character>(path.join(folder, characterFileName(cast()[0])));
      expect(guild.aliases).toContain("ギルマス");
      expect(guild.authorNotes).toContain("ギルマスのメモ");
      await waitUntil(
        async () => !(await readdir(folder)).includes(characterFileName(cast()[1])),
        "まとめた側のファイルが一覧から外れる",
        10_000
      );
      expect(await recoveredCount(session)).toBeGreaterThanOrEqual(2);
      // 開いていた「ギルマス」はまとめられたので、残した人物の中身へ切り替わる
      await waitUntil(
        async () => (await frame.locator("#detail h2").innerText().catch(() => "")).startsWith("ギルドマスター"),
        "開いていた人物が、残した人物に切り替わる",
        10_000
      );

      // ── 2組目：三門太志を残してまとめる ──
      await pressInPair(frame, "char_003|char_004", "「三門太志」を残してまとめる");
      await waitUntil(
        async () => (await candidatePairs(frame)).length === 1,
        "2組目を片づけると候補が1組になる",
        15_000
      );
      expect(await bandText(frame)).toContain("「太志」を「三門太志」にまとめました");
      const mikado = await readJsonWhenPresent<Character>(path.join(folder, characterFileName(cast()[2])));
      expect(mikado.aliases).toContain("太志");

      // ── 3組目：別人 ──
      await pressInPair(frame, "char_005|char_006", "別人");
      await waitUntil(
        async () => (await frame.locator("#merge-candidates").count()) === 0,
        "最後の1組を片づけると候補の欄が消える",
        15_000
      );
      expect(await bandText(frame)).toContain("「近所のおばあさん」と「ばあさん」を別人として覚えました");
      await waitUntil(async () => {
        const neighbor = await readJsonWhenPresent<Character>(path.join(folder, characterFileName(cast()[4])));
        const granny = await readJsonWhenPresent<Character>(path.join(folder, characterFileName(cast()[5])));
        return (
          neighbor.distinctFrom.some((entry) => entry.id === "char_006") &&
          granny.distinctFrom.some((entry) => entry.id === "char_005")
        );
      }, "別人にした2人が互いを distinctFrom で指す", 10_000);

      // 欄は消えたまま戻らず、そのあいだもメニューと確認の窓は出ない
      await holdsFor(
        async () => (await frame.locator("#merge-candidates").count()) === 0 && (await noMenuNorDialog(session)),
        "候補の欄が出ず、メニューも確認の窓も出ない",
        3_000
      );
      // パネルは閉じていない（同じ面が残っている）
      expect(await settingsPanelFrame(session)).toBeDefined();
    },
    launchOptions
  );
});

test("まとめた直後の帯の［戻す］で、まとめる前の2人に戻り、候補がまた3組になる", async () => {
  await withVsCode(
    "重複の候補の［戻す］",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const frame = await openSettings(session);
      await waitUntil(async () => (await candidatePairs(frame)).length === 3, "重複の候補が3組並ぶ", 15_000);
      const folder = await charactersFolder(session);

      await pressInPair(frame, "char_001|char_002", "「ギルドマスター」を残してまとめる");
      await waitUntil(async () => (await candidatePairs(frame)).length === 2, "まとめた組が候補から消える", 15_000);
      const undo = frame.locator("#list .merge-band button.merge-undo");
      expect(await undo.count()).toBe(1);

      await undo.click();
      await waitUntil(async () => (await candidatePairs(frame)).length === 3, "戻すと候補がまた3組になる", 15_000);
      expect(await bandText(frame)).toContain("まとめる前に戻しました");
      // 戻したあとの帯には［戻す］を出さない（戻せるのは直近の1手だけ）
      expect(await frame.locator("#list .merge-band button.merge-undo").count()).toBe(0);
      expect(await noMenuNorDialog(session), "メニューか確認の窓が出ています").toBe(true);
      // ファイル：2人とも元の場所にあり、残した人物の別名から「ギルマス」が消えている
      const guild = await readJsonWhenPresent<Character>(path.join(folder, characterFileName(cast()[0])));
      const short = await readJsonWhenPresent<Character>(path.join(folder, characterFileName(cast()[1])));
      expect(guild.aliases).not.toContain("ギルマス");
      expect(short.authorNotes).toBe("ギルマスのメモ");
    },
    launchOptions
  );
});

test("校正・メモパネルの「人物の重複の候補が 3組あります」の［設定資料パネルで見る］で、設定資料パネルの候補の欄へ飛ぶ", async () => {
  await withVsCode(
    "メモパネルから重複の候補へ",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      const manuscript = await openEpisode(page, EPISODE, "ギルドマスター");
      await placeCaretAfter(manuscript, "ギルドマスター");
      await page.keyboard.press("Control+Alt+KeyM");

      let memo: Frame | undefined;
      await waitUntil(async () => {
        memo = await memoPanelFrame(page);
        if (!memo) return false;
        return (await memo.locator("#mergeNotice:not([hidden])").count()) > 0;
      }, "校正・メモパネルに重複の候補の知らせが出る", 30_000);
      if (!memo) throw new Error("校正・メモパネルが見つかりません");
      expect(await memo.locator("#mergeNoticeText").innerText()).toBe("人物の重複の候補が 3組あります");
      // この画面には候補の一覧を置かない
      expect(await memo.locator(".merge-card").count()).toBe(0);

      await memo.locator("#openMergeCandidates").click();

      let settings: Frame | undefined;
      await waitUntil(async () => {
        settings = await settingsPanelFrame(session);
        if (!settings) return false;
        return (await settings.locator("#merge-candidates .merge-card").count()) === 3;
      }, "設定資料パネルが開き、候補の欄に3組並ぶ", 30_000);
      if (!settings) throw new Error("設定資料パネルの面が見つかりません");
      // 登場人物タブが選ばれている
      expect(await settings.locator("#tabs button.active").innerText()).toContain("登場人物");
    },
    launchOptions
  );
});

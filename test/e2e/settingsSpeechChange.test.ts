/**
 * 設定資料パネルの「口調の変化」から「第N話から変わったと記録する」（画面の自動テスト、設計書6.5.11・6.113）。
 *
 * 実機確認リスト J9 を機械へ移したもの（作者の裁定、2026-09-26 夕）。見張るのは次のとおり。
 *
 * - 口調のある人物に「口調の変化」の行と［第N話から変わったと記録する］が出る
 * - 話数（全角の「８」でも）と変わった後の口調を入れると、「変化（speechStyle）」の行に
 *   「前の口調（第7話）→ 新しい口調（第8話）」が出る
 * - 人物の JSON の `changes` に `source: "author"` で残り、`speechStyle`・`authorNotes` は変わらない
 *   （**ファイルで見る**）
 * - 同じ話に別の口調を入れると断られ（ファイルは変わらない）、「誤りを落とす」で落とせる
 *
 * 記録の組み立て（前後の2件・衝突の判定）は単体テスト（`core/speechStyle.test.ts`）が見ている。
 * ここで見るのは**本物の画面で押して入れたときの道筋**。人物は製品が読む形で置く。**AI は呼ばない。**
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { emptyCharacter, characterFileName, type Character } from "../../src/models/character";
import { defaultCharactersFolder, settingsPanelFrame, writeCharactersTo } from "./support/settingsFixture";
import { answerInput, waitForQuickInput } from "./support/quickInput";
import { withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { acceptQuickPick, toggleQuickPickRow, waitForQuickPick } from "./support/workbenchDom";

const OPEN_SETTINGS_KEY = "ctrl+alt+shift+f1";
const OPEN_SETTINGS_PRESS = "Control+Alt+Shift+F1";

const OLD_STYLE = "ぶっきらぼうな敬語";
const NEW_STYLE = "くだけた friendly な口調";
const OTHER_STYLE = "ていねいな関西弁";
const AUTHOR_NOTE = "作者が書いたメモ（自動では変えない）";

function person(): Character {
  return {
    ...emptyCharacter("char_001", "白瀬灯"),
    speechStyle: OLD_STYLE,
    authorNotes: AUTHOR_NOTE,
    appearedChapters: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  };
}

const EPISODES = [{ name: "001_はじまり.md", text: "白瀬灯は黙って歩いた。\n" }];

const launchOptions: LaunchOptions = {
  keybindings: [{ key: OPEN_SETTINGS_KEY, command: "novelai.openSettingsPanel" }],
  prepareWork: async ({ workFolder }) => {
    await writeCharactersTo(defaultCharactersFolder(workFolder), [person()]);
  },
};

async function readRecord(session: E2ESession): Promise<Character> {
  const file = path.join(session.workFolder, "設定", "characters", characterFileName(person()));
  // 書き戻しは「退避 → 新規作成」なので、一瞬ファイルが無いときがある
  let raw = "";
  await waitUntil(async () => (raw = await readFile(file, "utf8").catch(() => "")) !== "", "人物のファイルが読める", 10_000);
  return JSON.parse(raw) as Character;
}

async function openPanel(session: E2ESession): Promise<Frame> {
  await session.page.keyboard.press(OPEN_SETTINGS_PRESS);
  let panel: Frame | undefined;
  await waitUntil(async () => (panel = await settingsPanelFrame(session)) !== undefined, "設定資料パネルが開く", 30_000);
  const frame = panel as Frame;
  await waitUntil(async () => (await frame.locator("#list .item").count()) >= 1, "人物が並ぶ", 15_000);
  await frame.locator("#list .item", { hasText: "白瀬灯" }).first().click();
  return frame;
}

/** 「参考」の行（見出し＋値）の字を、見出しの先頭が合うものだけ集める */
async function referenceLines(frame: Frame): Promise<string[]> {
  return frame.evaluate(() =>
    Array.from(document.querySelectorAll("#detail .readonly")).map((row) => (row as HTMLElement).innerText.replace(/\s+/g, " ").trim())
  );
}

test("口調の変化を記録すると変化の行に前後が並び、人物のファイルに作者の記録で残り、同じ話の別の口調は断られ、誤りを落とせる", async () => {
  await withVsCode(
    "口調の変化の記録",
    EPISODES,
    async (session) => {
      const { page } = session;
      const frame = await openPanel(session);

      await waitUntil(
        async () => (await referenceLines(frame)).some((line) => line.startsWith("口調の変化")),
        "「口調の変化」の行が出る",
        15_000
      );
      const button = frame.locator("#detail button", { hasText: "第N話から変わったと記録する" });
      expect(await button.count(), "［第N話から変わったと記録する］が1つ出る").toBe(1);

      // 記録する：全角の「８」でも通る
      await button.click();
      await waitForQuickInput(page, "口調が変わった話（1/2）");
      await answerInput(page, "８");
      await waitForQuickInput(page, "第8話からの口調（2/2）");
      await answerInput(page, NEW_STYLE);

      // 画面：「変化（speechStyle）」の行に「前（第7話）→ 後（第8話）」
      await waitUntil(
        async () => (await referenceLines(frame)).some((line) => line.startsWith("変化（speechStyle）")),
        "「変化（speechStyle）」の行が出る",
        15_000
      );
      const changeLine = (await referenceLines(frame)).find((line) => line.startsWith("変化（speechStyle）")) ?? "";
      expect(changeLine).toContain(`${OLD_STYLE}（第7話）`);
      expect(changeLine).toContain(`${NEW_STYLE}（第8話）`);

      // ファイル：作者の記録で残り、口調の本体と作者メモは変わらない
      const saved = await readRecord(session);
      const authorChanges = (saved.changes ?? []).filter((change) => change.field === "speechStyle");
      expect(authorChanges.length, "口調の変化が前後の2件").toBe(2);
      expect(authorChanges.every((change) => change.source === "author")).toBe(true);
      expect(authorChanges.find((change) => change.value === NEW_STYLE)?.chapters).toEqual([8]);
      expect(authorChanges.find((change) => change.value === OLD_STYLE)?.chapters).toEqual([7]);
      expect(saved.speechStyle).toBe(OLD_STYLE);
      expect(saved.authorNotes).toBe(AUTHOR_NOTE);

      // 同じ話に別の口調：断られて、ファイルは変わらない
      await button.click();
      await waitForQuickInput(page, "口調が変わった話（1/2）");
      await answerInput(page, "8");
      await waitForQuickInput(page, "第8話からの口調（2/2）");
      await answerInput(page, OTHER_STYLE);
      await waitUntil(
        async () => ((await frame.locator("#status").textContent().catch(() => "")) ?? "").includes("別の口調の記録がすでにあります"),
        "同じ話は断られる",
        15_000
      );
      const after = await readRecord(session);
      expect(JSON.stringify(after.changes)).toBe(JSON.stringify(saved.changes));

      // 「誤りを落とす」で落とせる（落とす記録を選んで［OK］）
      await frame.locator("#detail button", { hasText: "誤りを落とす" }).first().click();
      await waitForQuickPick(page, "「speechStyle」の変化から、誤って入ったものを落とす");
      await toggleQuickPickRow(page, NEW_STYLE);
      await acceptQuickPick(page);
      await waitUntil(
        async () => ((await readRecord(session)).changes ?? []).every((change) => change.value !== NEW_STYLE),
        "第8話の記録がファイルから落ちる",
        15_000
      );
      const dropped = await readRecord(session);
      expect(dropped.speechStyle).toBe(OLD_STYLE);
      expect(dropped.authorNotes).toBe(AUTHOR_NOTE);
    },
    launchOptions
  );
}, 180_000);

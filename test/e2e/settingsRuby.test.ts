/**
 * 設定資料パネルの「ルビを追加」で、ルビを振る語を1語ずつ外せる（画面の自動テスト、設計書6.12.5・6.113）。
 *
 * 実機確認リスト 0.96.11 の項目を機械へ移したもの（作者の裁定、2026-10-03「語ごとに外せるようにする」）。
 * 見張るのは次のとおり。
 *
 * - 数えたあとに「ルビを振る語を選んでください」の一覧が出て、行に語・件数・読みが並び、全部チェック済み
 * - 1語外すと、確認画面の見出しの件数が減り「外した語（…）には振りません。」が出て、
 *   振ったあとの本文のその語にはルビが付かない（**ファイルで見る**）
 * - 全部外すと「すべての語を外したので、ルビは振りませんでした。」で終わり、本文は変わらない
 * - 当たった語が1つだけのときは一覧が出ず、そのまま確認画面になる
 *
 * 外し方と件数の数え方そのものは単体テスト（`core/settingsRuby.test.ts`「語ごとに外す」）が見ている。
 * ここで見るのは**本物の画面で押したときの道筋**である。人物の記録は製品が読む形で置く。**AI は呼ばない。**
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { emptyCharacter, type Character } from "../../src/models/character";
import { defaultCharactersFolder, settingsPanelFrame, writeCharactersTo } from "./support/settingsFixture";
import { withVsCode, type E2ESession, type LaunchOptions } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  acceptQuickPick,
  closeDialog,
  dialogText,
  pickQuickPickRow,
  pressDialogButton,
  quickPickTitle,
  toggleQuickPickRow,
  waitForQuickPick,
} from "./support/workbenchDom";

const OPEN_SETTINGS_KEY = "ctrl+alt+shift+f1";
const OPEN_SETTINGS_PRESS = "Control+Alt+Shift+F1";

const TERM_LIST_TITLE = "ルビを振る語を選んでください";

/** 読み仮名のある人物3人（どれも2文字以上。1文字の語は数える前に外れる） */
function cast(): Character[] {
  const people: Array<[string, string]> = [
    ["白瀬灯", "しらせあかり"],
    ["黒川湊", "くろかわみなと"],
    ["青木", "あおき"],
  ];
  return people.map(([name, reading], index) => ({
    ...emptyCharacter(`char_${String(index + 1).padStart(3, "0")}`, name),
    reading,
    appearedChapters: [1],
  }));
}

/** 3人とも出る話（「出てくるところすべて」なら白瀬灯2・黒川湊2・青木1） */
const THREE_NAMES = "白瀬灯は黒川湊と歩いた。\n白瀬灯が笑うと、黒川湊は黙った。\n青木先生が来た。\n";
/** 白瀬灯だけが出る話（当たる語が1つだけ） */
const ONE_NAME = "白瀬灯はひとりで坂を上った。\n";

const EPISODES = [
  { name: "001_はじまり.md", text: THREE_NAMES },
  { name: "002_ひとり.md", text: ONE_NAME },
];

const launchOptions: LaunchOptions = {
  keybindings: [{ key: OPEN_SETTINGS_KEY, command: "novelai.openSettingsPanel" }],
  // 人物は起こす前に置く（起きてから書くと「外で変更されました」の知らせが揺れて出る）
  prepareWork: async ({ workFolder }) => {
    await writeCharactersTo(defaultCharactersFolder(workFolder), cast());
  },
};

/** 設定資料パネルを開いて「ルビを追加」を押し、資料の種類（人物だけ）と範囲を選ぶところまで */
async function startRuby(session: E2ESession, scope: "all" | { episode: string }): Promise<void> {
  const { page } = session;
  await page.keyboard.press(OPEN_SETTINGS_PRESS);
  let panel: Frame | undefined;
  await waitUntil(async () => (panel = await settingsPanelFrame(session)) !== undefined, "設定資料パネルが開く", 30_000);
  if (!panel) throw new Error("設定資料パネルの面が見つかりません");
  const frame = panel;
  // 人物の一覧が読み込まれてから押す（読み込み前だと、読み仮名のある語が0になる）
  await waitUntil(
    async () => (await frame.locator("#list .item").count()) >= 3,
    "設定資料パネルに人物が3人並ぶ",
    15_000
  );
  await frame.locator("#apply-ruby").click();

  // 資料の種類：人物だけが既定で選ばれている
  const kinds = await waitForQuickPick(page, "どの資料の読み仮名を振りますか");
  expect(kinds.find((row) => row.label === "人物")?.checked, "人物が既定で選ばれていません").toBe(true);
  await acceptQuickPick(page);

  await waitForQuickPick(page, "どこにルビを振りますか");
  if (scope === "all") {
    await pickQuickPickRow(page, "すべての話");
  } else {
    await pickQuickPickRow(page, "話を選ぶ");
    await waitForQuickPick(page, "ルビを振る話を選んでください");
    await toggleQuickPickRow(page, scope.episode);
    await acceptQuickPick(page);
  }

  await waitForQuickPick(page, "同じ名前が何度も出てきたら");
  await pickQuickPickRow(page, "出てくるところすべて");
}

async function readEpisode(session: E2ESession, name: string): Promise<string> {
  return (await readFile(path.join(session.manuscriptFolder, name), "utf8")).replace(/\r\n/g, "\n");
}

async function waitForDialog(session: E2ESession, label: string): Promise<string> {
  let text: string | undefined;
  await waitUntil(async () => (text = await dialogText(session.page)) !== undefined, label, 15_000);
  return text ?? "";
}

test("ルビを追加で、語・件数・読みの一覧が全部チェック済みで出て、1語外すと見出しの件数が減り、その語にはルビが付かない", async () => {
  await withVsCode(
    "ルビを語ごとに外す",
    EPISODES,
    async (session) => {
      await startRuby(session, "all");

      // 一覧：語・件数・読み。全部チェック済み
      const rows = await waitForQuickPick(session.page, TERM_LIST_TITLE);
      expect(rows.map((row) => ({ label: row.label, description: row.description, checked: row.checked }))).toEqual([
        // 第1話に2回、第2話に1回
        { label: "白瀬灯", description: "3件　しらせあかり", checked: true },
        { label: "黒川湊", description: "2件　くろかわみなと", checked: true },
        { label: "青木", description: "1件　あおき", checked: true },
      ]);

      // 黒川湊を外して決める
      await toggleQuickPickRow(session.page, "黒川湊");
      await acceptQuickPick(session.page);

      // 確認画面：見出しの件数が6件から4件へ減り、外した語の断りが出る
      const confirm = await waitForDialog(session, "ルビを振るかの確認画面が出る");
      expect(confirm).toContain("すべての話（2話）に、4件のルビを振りますか？");
      expect(confirm).toContain("外した語（黒川湊）には振りません。");
      await pressDialogButton(session.page, "振る");

      // **ファイルで見る**：外した語にはルビが付かず、残した語には付く
      // 書き戻しは「退避 → 新規作成」なので、一瞬ファイルが無いときがある。そのあいだは読めないものとして待つ
      let text = "";
      await waitUntil(
        async () =>
          (text = await readEpisode(session, "001_はじまり.md").catch(() => "")).includes("{白瀬灯|しらせあかり}") &&
          (await readEpisode(session, "002_ひとり.md").catch(() => "")).includes("{白瀬灯|しらせあかり}"),
        "第1話にルビが入る",
        15_000
      );
      expect(text).toBe(
        "{白瀬灯|しらせあかり}は黒川湊と歩いた。\n{白瀬灯|しらせあかり}が笑うと、黒川湊は黙った。\n{青木|あおき}先生が来た。\n"
      );
      expect(await readEpisode(session, "002_ひとり.md")).toBe("{白瀬灯|しらせあかり}はひとりで坂を上った。\n");

      // 外した語は作品の操作ログにも残る
      const log = await readFile(path.join(session.workFolder, ".aiwriter", "logs", "actions.log"), "utf8");
      expect(log).toContain("設定資料からのルビ：外した語 黒川湊");
    },
    launchOptions
  );
});

test("ルビを追加で、語を全部外すと振らずに終わり、当たった語が1つだけの話では語の一覧が出ずに確認画面になる", async () => {
  await withVsCode(
    "ルビの語を全部外す・1語だけ",
    EPISODES,
    async (session) => {
      const { page } = session;

      // ── 全部外す ──
      await startRuby(session, "all");
      await waitForQuickPick(page, TERM_LIST_TITLE);
      for (const label of ["白瀬灯", "黒川湊", "青木"]) await toggleQuickPickRow(page, label);
      await acceptQuickPick(page);

      const toast = page.locator(".notification-toast", { hasText: "すべての語を外したので、ルビは振りませんでした。" });
      await waitUntil(async () => (await toast.count()) > 0, "「すべての語を外したので…」の知らせが出る", 10_000);
      // 確認画面は出ず、本文は変わらない
      await holdsFor(async () => (await dialogText(page)) === undefined, "確認画面が出ない", 2_000);
      expect(await readEpisode(session, "001_はじまり.md")).toBe(THREE_NAMES);
      expect(await readEpisode(session, "002_ひとり.md")).toBe(ONE_NAME);

      // ── 当たった語が1つだけの話 ──
      await startRuby(session, { episode: "002_ひとり.md" });
      const confirm = await waitForDialog(session, "1語だけのときは、すぐ確認画面が出る");
      expect(confirm).toContain("選んだ1話に、1件のルビを振りますか？");
      expect(confirm).not.toContain("外した語");
      // 語の一覧は一度も出ていない（確認画面が出ているあいだも出てこない）
      expect(await quickPickTitle(page)).not.toBe(TERM_LIST_TITLE);
      await holdsFor(async () => (await quickPickTitle(page)) !== TERM_LIST_TITLE, "語の一覧が出ない", 2_000);
      // 振らずに閉じる（この件は一覧が出ないことだけを見る）
      await closeDialog(page);
      expect(await readEpisode(session, "002_ひとり.md")).toBe(ONE_NAME);
    },
    launchOptions
  );
});

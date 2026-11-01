/**
 * 人物名変更（名前の付け替え）の画面の道筋（画面の自動テスト、設計書6.37・6.113）。
 *
 * 実機確認リスト F 節（2026-10-04 に機械へ移した）：
 * - 「人物名変更」で、人物を選び、新しい名前・読みを打つと、**対応表**（フルネームは有効、読みの行は既定で外れる）の
 *   確認と、範囲の確認が出て、提案パネルに「名前の付け替え」が並ぶ
 * - 提案パネルで**1件ずつ［適用］すると本文が変わり、行の場所を押すとその行へ飛び、［まとめて適用］で
 *   残りが全部変わる**
 * - 「人物名変更の資料反映」で、人物の記録（name・reading）・プロット・紹介文の読み物が書き換わり、
 *   **旧名が別名に残らず、作者メモ（authorNotes）は無傷**
 *
 * 置き換えの作り方・資料の書き換えの中身は単体テスト（`features/nameRename.test.ts`）が見ている。
 * ここで見るのは**本物の画面で押したときの道筋と、書き換わったファイル**である。
 * 本文・資料はすべて作り物。**AI は呼ばない。** 各話あらすじ・伏線台帳への反映は見ていない（見本を置いていない）。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Frame } from "playwright-core";
import { expect, test } from "vitest";
import { characterFileName, emptyCharacter, type Character } from "../../src/models/character";
import { DEFAULT_SETTINGS_DIR } from "../../src/models/types";
import { readFileWhenPresent } from "./support/fileSettle";
import { caretPosition, manuscriptFrames } from "./support/manuscriptFrame";
import { answerInput, runCommand, waitForQuickInput } from "./support/quickInput";
import { proposalPanelFrame } from "./support/sampleFinding";
import { defaultCharactersFolder, writeCharactersTo } from "./support/settingsFixture";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import {
  acceptQuickPick,
  clearNotifications,
  closeDialog,
  dialogText,
  notificationTexts,
  pickQuickPickRow,
  pressDialogButton,
  waitForQuickPick,
} from "./support/workbenchDom";

const OLD = "三門太志";
const NEW = "三門優一";
const NOTES = "三門太志は作者メモに書いたまま残す";

const EPISODES = [
  { name: "001_はじまり.txt", text: `${OLD}は門を叩いた。\n${OLD}は静かに言った。\n` },
  { name: "002_つづき.txt", text: `夜の街で、${OLD}が笑った。\n` },
];

function cast(): Character[] {
  return [
    {
      ...emptyCharacter("char_001", OLD),
      reading: "みかどたいし",
      appearedChapters: [1, 2],
      authorNotes: NOTES,
    },
  ];
}

const LAUNCH = {
  prepareWork: async ({ workFolder }: { workFolder: string }) => {
    await writeCharactersTo(defaultCharactersFolder(workFolder), cast());
    const settings = path.join(workFolder, DEFAULT_SETTINGS_DIR);
    await mkdir(settings, { recursive: true });
    await writeFile(path.join(settings, "plot.md"), `# プロット\n\n${OLD}が旅に出て、仲間と出会う。\n`, "utf8");
    await writeFile(path.join(settings, "synopsis.md"), `# 作品紹介\n\n${OLD}の物語。\n`, "utf8");
  },
};

/**
 * 話の本文を読む。**書き込みは「退避 → 新規作成」なので、その合間はファイルが一瞬無い。**
 * 無いあいだを「空」と読むと数が合わなくなるので、見つかるまで少し待つ
 */
async function readEpisode(session: E2ESession, name: string): Promise<string> {
  return readStable(path.join(session.manuscriptFolder, name));
}

/** 資料も同じ置き換え（退避→新規作成）で書かれる。見つかるまで少し待って読む（`support/fileSettle.ts`） */
const readStable = (file: string): Promise<string> => readFileWhenPresent(file);

/** 本文3か所（2話ぶん）に、`word` がいくつあるか */
async function countIn(session: E2ESession, word: string): Promise<number> {
  let total = 0;
  for (const episode of EPISODES) {
    total += (await readEpisode(session, episode.name)).split(word).length - 1;
  }
  return total;
}

const oldNameCount = (session: E2ESession) => countIn(session, OLD);
const newNameCount = (session: E2ESession) => countIn(session, NEW);

/**
 * 付け替えの置き換えを最後の1件まで決め終えたときの問い（0.121.0。作者の判断 2026-11-01。
 * 実機確認リスト 335 行）。途中の1件では出ず、［適用］と［見送る］を混ぜて決め終えると
 * 「「〈旧〉」→「〈新〉」の本文の置き換えを決め終えました。…反映しますか。」と［資料に反映する］が出て、
 * 押すと資料への反映の確認の窓が出る。
 *
 * 入口は「人物名変更」（名前点検の［付け替える］と同じ待ちの対応表を通る。問いを出すのは提案パネルの
 * 「名前の付け替え」の分類を決め終えたとき＝ `extension.ts` の `setOnCategorySettled`）。
 */
test("付け替えの置き換えを1件ずつ［適用］か［見送る］で最後まで決めると、途中では出なかった「決め終えました」と［資料に反映する］が出て、押すと資料への反映の確認が出る", async () => {
  await withVsCode(
    "付け替えを決め終えたときの問い",
    EPISODES,
    async (session) => {
      const { page } = session;
      await runCommand(page, "人物名変更");
      await waitForQuickPick(page, "名前を付け替える人物");
      await pickQuickPickRow(page, OLD);
      await waitForQuickInput(page, `「${OLD}」を何という名前にしますか`);
      await answerInput(page, NEW);
      await waitForQuickInput(page, `「${NEW}」の読み`);
      await answerInput(page, "みかどゆういち");
      await waitForQuickPick(page, "この対応で付け替えます");
      await acceptQuickPick(page);
      await waitUntil(async () => (await dialogText(page)) !== undefined, "範囲の確認の窓が出る", 20_000);
      await pressDialogButton(page, "提案パネルに出す");

      let panel: Frame | undefined;
      await waitUntil(
        async () => {
          panel = await proposalPanelFrame(page);
          return panel !== undefined && (await panel.locator('button[data-action="apply"]').count()) >= 3;
        },
        "提案パネルに［適用］が3件並ぶ",
        30_000
      );
      const proposals = panel as Frame;
      await clearNotifications(page);
      const settled = async () => (await notificationTexts(page)).find((text) => text.includes("の本文の置き換えを決め終えました"));

      // 1件目を［適用］→ まだ2件残っているので問いは出ない
      await proposals.locator('button[data-action="apply"]').first().click();
      await waitUntil(async () => (await oldNameCount(session)) === 2, "1件の［適用］で旧名が1か所減る", 20_000);
      await holdsFor(async () => (await settled()) === undefined, "途中の1件では「決め終えました」が出ない", 3_000);

      // 2件目を［見送る］→ まだ1件残っている
      const dismissible = proposals.locator('button[data-action="dismiss"]');
      await waitUntil(async () => (await dismissible.count()) >= 2, "残りの2件に［見送る］がある", 10_000);
      await dismissible.first().click();
      await waitUntil(async () => (await proposals.locator('button[data-action="apply"]').count()) === 1, "見送った行が並びから外れる", 15_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（パネル：${JSON.stringify((await proposals.evaluate(() => document.body.innerText)).slice(0, 400))}）`);
      });
      await holdsFor(async () => (await settled()) === undefined, "まだ1件残っているあいだは「決め終えました」が出ない", 3_000);

      // 最後の1件を［適用］→ 問いが出る
      await proposals.locator('button[data-action="apply"]').first().click();
      let notice: string | undefined;
      await waitUntil(async () => (notice = await settled()) !== undefined, "最後の1件を決めると「決め終えました」が出る", 20_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（知らせ：${JSON.stringify(await notificationTexts(page))}）`);
      });
      expect(notice).toContain(`「${OLD}」→「${NEW}」の本文の置き換えを決め終えました。`);
      expect(notice).toContain("反映しますか。");
      // 見送った1か所は旧名のまま、ほかは新しい名前
      expect(await oldNameCount(session)).toBe(1);
      expect(await newNameCount(session)).toBe(2);

      const toast = page.locator(".notification-toast", { hasText: "の本文の置き換えを決め終えました" }).first();
      await toast.locator(".monaco-button", { hasText: "資料に反映する" }).first().click();
      await waitUntil(async () => (await dialogText(page))?.includes(`「${OLD}」→「${NEW}」を資料にも反映します`) === true, "［資料に反映する］で資料への反映の確認の窓が出る", 20_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（窓：${JSON.stringify(await dialogText(page))}／知らせ：${JSON.stringify(await notificationTexts(page))}）`);
        }
      );
      // 資料は書き換えない（確認の窓まで）
      await closeDialog(page);
    },
    LAUNCH
  );
});

test("人物名変更で提案パネルに並び、1件ずつ適用・本文を見る・まとめて適用ができ、資料にも反映され、作者メモは無傷", async () => {
  await withVsCode(
    "名前の付け替え",
    EPISODES,
    async (session) => {
      const { page } = session;

      // ── 人物を選ぶ → 新しい名前 → 読み ──
      await runCommand(page, "人物名変更");
      await waitForQuickPick(page, "名前を付け替える人物");
      await pickQuickPickRow(page, OLD);
      await waitForQuickInput(page, `「${OLD}」を何という名前にしますか`);
      await answerInput(page, NEW);
      await waitForQuickInput(page, `「${NEW}」の読み`);
      await answerInput(page, "みかどゆういち");

      // ── 対応表：フルネームは有効、読みの行は既定で外れている（姓・名の行は、姓と名が別に記録された人物だけ） ──
      const rows = await waitForQuickPick(page, "この対応で付け替えます");
      const full = rows.find((row) => row.label === `${OLD} → ${NEW}`);
      expect(full?.checked, `対応表のフルネーム ${JSON.stringify(rows)}`).toBe(true);
      // 読みの行は既定で外れている（有効にすると、ルビの中の読みまで変わる）
      const reading = rows.find((row) => row.description.includes("ルビの読み"));
      expect(reading?.checked, `読みの行は既定で外れている ${JSON.stringify(rows)}`).toBe(false);
      await acceptQuickPick(page);

      // ── 範囲の確認（本文はまだ書き換わらない）──
      await waitUntil(async () => (await dialogText(page)) !== undefined, "範囲の確認の窓が出る", 20_000);
      const scope = (await dialogText(page)) ?? "";
      expect(scope).toContain(OLD);
      expect(scope).toContain(NEW);
      expect(scope).toContain("ここではまだ本文は書き換わりません");
      await pressDialogButton(page, "提案パネルに出す");
      expect(await oldNameCount(session), "ここでは本文は書き換わらない").toBe(3);

      // ── 提案パネルに「適用」が並ぶ ──
      let panel: Frame | undefined;
      await waitUntil(
        async () => {
          panel = await proposalPanelFrame(page);
          return panel !== undefined && (await panel.locator('button[data-action="apply"]').count()) >= 3;
        },
        "提案パネルに［適用］が3件並ぶ",
        30_000
      );
      if (!panel) throw new Error("提案パネルが見つかりません");
      const proposals = panel;

      // 1件ずつ［適用］：本文が1か所だけ新しい名前になる
      await proposals.locator('button[data-action="apply"]').first().click();
      await waitUntil(async () => (await oldNameCount(session)) === 2, "1件の［適用］で旧名が1か所減る", 20_000);
      expect(await newNameCount(session)).toBe(1);

      // 行の場所（「001_はじまり.txt 2行目」）を押す＝本文を見る：その行へ飛ぶ
      // （原稿エディターのカーソルが旧名のある行へ来る）。※［本文を見る］という名前のボタンは、
      // 名前の付け替えの行には出ない（場所の押下が同じ道）
      await proposals.locator('.location[data-action="jump"]').nth(1).click();
      await waitUntil(
        async () => {
          for (const frame of await manuscriptFrames(page)) {
            const caret = await caretPosition(frame).catch(() => undefined);
            if (caret?.lineText.includes(OLD)) return true;
          }
          return false;
        },
        "場所を押すと、旧名の残る行へカーソルが飛ぶ",
        20_000
      );

      // ［まとめて適用］：残りが全部新しい名前になる
      await proposals.locator("#applyAll").click();
      // 「確度『高』『中』の指摘 2 件をまとめて適用します。作者による個別確認なしに本文が書き換わります。」
      await waitUntil(async () => (await dialogText(page))?.includes("まとめて適用します") === true, "まとめて適用の確認の窓が出る", 15_000);
      await pressDialogButton(page, "適用する");
      await waitUntil(async () => (await oldNameCount(session)) === 0, "［まとめて適用］で旧名が本文から無くなる", 30_000);
      expect(await newNameCount(session), "本文の新しい名前の数").toBe(3);
      // 本文のほかの字は変わっていない
      expect((await readEpisode(session, EPISODES[1].name)).replace(/\r\n/g, "\n")).toBe(
        `夜の街で、${NEW}が笑った。\n`
      );

      // ── 資料にも反映（人物名変更の資料反映）──
      await runCommand(page, "人物名変更の資料反映");
      await waitUntil(async () => (await dialogText(page)) !== undefined, "資料への反映の確認の窓が出る", 20_000);
      const confirm = (await dialogText(page)) ?? "";
      expect(confirm).toContain(`「${OLD}」→「${NEW}」を資料にも反映します`);
      expect(confirm).toContain("作者メモ（authorNotes）");
      await pressDialogButton(page, "資料も直す");

      const settings = path.join(session.workFolder, DEFAULT_SETTINGS_DIR);
      const recordFile = path.join(defaultCharactersFolder(session.workFolder), characterFileName(cast()[0]));
      // 人物の記録：名前・読みが新しくなり、旧名は別名に残らず、作者メモは無傷
      const readRecord = async (): Promise<Character | undefined> => {
        const files = [recordFile, path.join(defaultCharactersFolder(session.workFolder), characterFileName({ ...cast()[0], name: NEW }))];
        for (const file of files) {
          const text = await readFile(file, "utf8").catch(() => "");
          if (text) return JSON.parse(text) as Character;
        }
        return undefined;
      };
      await waitUntil(async () => (await readRecord())?.name === NEW, "人物の記録の名前が新しくなる", 30_000);
      const record = await readRecord();
      expect(record?.reading).toBe("みかどゆういち");
      expect(record?.aliases ?? [], "旧名が別名に残っていない").not.toContain(OLD);
      expect(record?.authorNotes, "作者メモは無傷").toBe(NOTES);
      // プロットと紹介文の読み物の旧名も新しくなる
      await waitUntil(
        async () => (await readStable(path.join(settings, "plot.md"))).includes(NEW),
        "プロットの旧名が新しくなる",
        30_000
      );
      expect(await readStable(path.join(settings, "plot.md"))).not.toContain(OLD);
      await waitUntil(
        async () => (await readStable(path.join(settings, "synopsis.md"))).includes(NEW),
        "紹介文の読み物の旧名が新しくなる（プロットのあとに直される）",
        30_000
      );
      expect(await readStable(path.join(settings, "synopsis.md"))).toContain(`${NEW}の物語。`);
      expect(await readStable(path.join(settings, "synopsis.md"))).not.toContain(OLD);
    },
    LAUNCH
  );
});

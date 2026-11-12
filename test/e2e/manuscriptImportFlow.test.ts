/**
 * 原稿エディターの［入力］→「テキストファイルから」「Word から」：空の話へ入る・本文のある話で訊かれる・
 * 次の話として足す／最後に加える／上書きする・1行目を題にするか・投稿先に合わせた傍点・Shift_JIS の読み分け
 * （画面の自動テスト、設計書6.25.13・6.113）。
 *
 * 実機確認リストの 85〜91 行（0.147.0 の7項目。「0.149.0 原稿 UTF-8 変換」の節の中にある）を機械へ移したもの。
 * 判断の部分（並べ方・訊くもの・名前・番号ずらしの失敗と中止・ハッシュの照合）は
 * `unit/core/episodeImport.test.ts`・`unit/features/manuscriptImport.test.ts` が見ている。ここで見るのは、
 * **本物の VS Code で上の列の［入力］を押して起きること**（窓・ファイル・名前・開き直す面）：
 *
 * - 85：本文が空の話（カクヨム形式の頭の欄だけの話）で［テキストファイルから］→ 窓を出さずに入り、頭の欄が残る。
 *   別の空の話で［Word から］→ 同じく入り、ルビが残る
 * - 86：本文の入った途中の話で押すと、［次の話として足す］［最後に加える］［上書きする］［やめる］が並び、
 *   「あとの話のファイル名が変わります（N話）」「いまの本文 N字が消え」が書いてある。最後の話では
 *   ［次の話として足す］が出ない
 * - 87：［次の話として足す］→ 後ろの話の番号が1つずつずれ、空いた番号の話が取り込んだ文で開き、見た目
 *   （縦書き・字の大きさ）が引き継がれる。［最後に加える］→ 最後の次の番号で足され、ほかの話は変わらない
 * - 88：［上書きする］→ 本文が取り込んだ文に変わり、書き換える前の本文が `.novelai-recovery` に残り、
 *   知らせに控えの場所が出る
 * - 89：1行目が題のテキスト → 「題にしますか」。［題にする］は、頭の欄のある話では【タイトル】の欄へ、
 *   欄の無い話ではファイル名のサブタイトルへ入り（古い名前の面が閉じ、新しい名前の面が同じ見た目で開く）、
 *   本文の頭からは消える。［本文に入れる］なら1行目も本文に入る
 * - 90：投稿サイト設定でなろうを登録した作品へ傍点のある Word を取り込むと `｜強調《・・》`、登録の無い作品では
 *   `《《強調》》`
 * - 91：Shift_JIS のテキスト（メモ帳の「ANSI」）が化けずに入り、知らせに「Shift_JIS として読みました」が出る
 *
 * 取り込み元は台本の中で作る（作品の外のフォルダー。`support/importFlow.ts`）。作者の原稿・確認用コピーは
 * 読まない。ファイルを選ぶ窓は簡易の窓（`files.simpleDialog.enable`）で、OS のダイアログを出さない。
 *
 * **見ていないこと**：88 の「タイムラインの『書き換える前の控え』から前の本文に戻せるか」（VS Code の
 * タイムライン欄は押していない。控えのファイルに前の本文があることまで）。OS のファイル選択窓の見た目。
 * 見た目の良し悪し。**AI は呼ばない。**
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import iconv = require("iconv-lite");
import { expect, test } from "vitest";
import {
  TEXT_DIALOG_TITLE,
  WORD_DIALOG_TITLE,
  dialogButtons,
  docxOf,
  faceLook,
  launchWith,
  manuscriptNames,
  manuscriptText,
  openEpisodeFrame,
  pickFileInDialog,
  sourcePathOf,
  waitComposeWith,
  waitDialogWith,
  waitWithContext,
  wordDotted,
  wordParagraph,
  wordRun,
  wordRuby,
} from "./support/importFlow";
import { clickToolButton, frontFrameShowing, openEpisode } from "./support/manuscriptFrame";
import { waitForNotice } from "./support/noticeRecord";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor, waitUntil } from "./support/wait";
import { activeTabNames, dialogText, editorGroupTabs, pressDialogButton, tabNamesInclude } from "./support/workbenchDom";
import type { Frame } from "playwright-core";

/** 5話（本文のある話）。字下げは全角空白（1行目が題に見えないように） */
const FIVE = ["001.txt", "002.txt", "003.txt", "004.txt", "005.txt"];
const KANJI = ["一", "二", "三", "四", "五"];
const FILLED = FIVE.map((name, index) => ({ name, text: `　${KANJI[index]}話の本文。\n` }));

/** カクヨム形式の頭の欄だけの話（本文は空） */
const kakuyomuEmpty = (title: string): string => `【タイトル】\n${title}\n\n【公開状態】\n未公開\n\n【本文】\n`;

/** ［入力］の段の取り込みボタンを押して、ファイルを選ぶ窓で取り込み元を選ぶ */
async function startImport(session: E2ESession, frame: Frame, button: "importText" | "importWord", sourceName: string): Promise<void> {
  await clickToolButton(frame, button);
  await pickFileInDialog(session.page, button === "importWord" ? WORD_DIALOG_TITLE : TEXT_DIALOG_TITLE, sourcePathOf(session, sourceName));
}

/** 全部の話の本文が元のまま（番号ずらしも書き換えも起きていない） */
async function expectFilledUntouched(session: E2ESession, names: readonly string[] = FIVE): Promise<void> {
  for (const [index, name] of FIVE.entries()) {
    if (!names.includes(name)) continue;
    expect(await manuscriptText(session, name), `${name} が書き換わりました`).toBe(FILLED[index].text);
  }
}

/* ── 85：本文が空の話へは、訊かずに入る ── */

test("本文が空の話で［入力］→「テキストファイルから」を押すと、窓を出さずにその話へ入り、頭の欄（題など）が残る。別の空の話で「Word から」を押しても同じように入り、ルビが残る", async () => {
  const header2 = kakuyomuEmpty("第二話　雪の朝");
  const header3 = kakuyomuEmpty("第三話　春の夜");
  const textSource = "　取り込んだ一行目。\n二行目の文章。\n";
  await withVsCode(
    "空の話へ訊かずに入る",
    [
      { name: "001.txt", text: FILLED[0].text },
      { name: "002.txt", text: header2 },
      { name: "003.txt", text: header3 },
    ],
    async (session) => {
      const { page } = session;

      /* ── テキストファイル ── */
      const textFrame = await openEpisodeFrame(page, "002.txt");
      const since = Date.now();
      await startImport(session, textFrame, "importText", "メモ.txt");
      await waitWithContext(
        session,
        async () => (await manuscriptText(session, "002.txt")) === `${header2}${textSource}`,
        "002.txt の本文の欄に取り込んだ文が入り、頭の欄が残る",
        30_000,
        since
      );
      // 訊く窓は出ていない（空の話は確かめなしで入る）
      expect(await dialogText(page), "空の話なのに確認の窓が出ました").toBeUndefined();
      const info = await waitForNotice(session, (message) => message.includes("本文に入れました"), "「…を 002.txt の本文に入れました」の知らせ", { since });
      expect(info).toContain("メモ.txt");
      await waitComposeWith(session, textFrame, "取り込んだ一行目", "原稿エディターの本文が取り込んだ文に変わる");
      // 取り込み元は書き換えない
      expect(await readFile(sourcePathOf(session, "メモ.txt"), "utf8")).toBe(textSource);

      /* ── Word（別の空の話。1つ目はもう本文が入っているので、同じ話では窓が出る） ── */
      const wordFrame = await openEpisodeFrame(page, "003.txt");
      const sinceWord = Date.now();
      await startImport(session, wordFrame, "importWord", "雪の朝.docx");
      await waitWithContext(
        session,
        async () => (await manuscriptText(session, "003.txt")) === `${header3}雪の｜朝《あさ》だった。\n`,
        "003.txt の本文の欄に Word の文が入り、ルビが残る",
        30_000,
        sinceWord
      );
      expect(await dialogText(page), "空の話なのに確認の窓が出ました（Word）").toBeUndefined();
      await waitForNotice(session, (message) => message.includes("雪の朝.docx") && message.includes("本文に入れました"), "Word の取り込みの知らせ", { since: sinceWord });
      // 取り込んでいない話は触っていない
      expect(await manuscriptText(session, "001.txt")).toBe(FILLED[0].text);
    },
    launchWith({
      "メモ.txt": textSource,
      "雪の朝.docx": docxOf(wordParagraph(wordRun("雪の") + wordRuby("朝", "あさ") + wordRun("だった。"))),
    })
  );
}, 240_000);

/* ── 86：本文のある話では、足し方を訊く ── */

test("本文の入った途中の話で［入力］→「テキストファイルから」を押すと、次の話として足す・最後に加える・上書きする・やめるが並び、あとの話の名前が変わる話数と消える字数が書いてある。最後の話では［次の話として足す］が出ない", async () => {
  await withVsCode(
    "本文のある話で足し方を訊く",
    FILLED,
    async (session) => {
      const { page } = session;

      /* ── 途中の話（003） ── */
      const middle = await openEpisode(page, "003.txt", "三話の本文");
      await startImport(session, middle, "importText", "新しい話.txt");
      const asked = await waitDialogWith(session, "この話には本文が入っています", "003.txt で足し方を訊く確認の窓が出る");
      const buttons = await dialogButtons(page);
      for (const label of ["次の話として足す", "最後に加える", "上書きする", "やめる"]) {
        expect(
          buttons.some((text) => text.includes(label)),
          `［${label}］が並んでいません（ボタン：${JSON.stringify(buttons)}）`
        ).toBe(true);
      }
      // 004・005 の2話の名前が変わる／いまの本文「三話の本文。」6字が消える
      expect(asked).toContain("あとの話のファイル名が変わります（2話）");
      expect(asked).toContain("いまの本文 6字が消え");
      await pressDialogButton(page, "やめる");
      // やめたら何も変わらない
      await holdsFor(async () => (await manuscriptNames(session)).join("|") === FIVE.join("|"), "［やめる］のあとも話のファイルが増減・改名されない", 2_500);
      await expectFilledUntouched(session);

      /* ── 最後の話（005） ── */
      const last = await openEpisodeFrame(page, "005.txt");
      await startImport(session, last, "importText", "新しい話.txt");
      await waitDialogWith(session, "この話には本文が入っています", "005.txt で足し方を訊く確認の窓が出る");
      const lastButtons = await dialogButtons(page);
      expect(
        lastButtons.some((text) => text.includes("次の話として足す")),
        `最後の話に［次の話として足す］が出ています（ボタン：${JSON.stringify(lastButtons)}）`
      ).toBe(false);
      for (const label of ["最後に加える", "上書きする", "やめる"]) {
        expect(
          lastButtons.some((text) => text.includes(label)),
          `最後の話で［${label}］が並んでいません（ボタン：${JSON.stringify(lastButtons)}）`
        ).toBe(true);
      }
      await pressDialogButton(page, "やめる");
      await holdsFor(async () => (await manuscriptNames(session)).join("|") === FIVE.join("|"), "最後の話で［やめる］のあとも話のファイルが変わらない", 2_000);
    },
    launchWith({ "新しい話.txt": "　取り込んだ新しい話。\n" })
  );
}, 240_000);

/* ── 87：次の話として足す／最後に加える ── */

test("［次の話として足す］を選ぶと、後ろの話の番号が1つずつずれ、空いた番号の話が取り込んだ文で開き、縦書き・字の大きさが引き継がれる", async () => {
  const imported = "　差し込んだ話。\n";
  await withVsCode(
    "次の話として足す",
    FILLED,
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, "003.txt", "三話の本文");
      const original = await faceLook(frame);
      await clickToolButton(frame, "dir");
      await waitUntil(async () => (await faceLook(frame)).vertical, "［縦書きにする］で縦書きになる", 10_000);
      await clickToolButton(frame, "bigger");
      await clickToolButton(frame, "bigger");
      await waitUntil(async () => (await faceLook(frame)).size > original.size, "［＋］で字が大きくなる", 10_000);
      const changed = await faceLook(frame);
      // 見た目の知らせが拡張機能へ届くのを待つ（持ち越す値はそれで決まる。renameSubtitleAppearance と同じ理由）
      await page.waitForTimeout(1_000);

      const since = Date.now();
      await startImport(session, frame, "importText", "差し込み.txt");
      await waitDialogWith(session, "この話には本文が入っています", "足し方を訊く確認の窓が出る");
      await pressDialogButton(page, "次の話として足す");

      // 004 が空き、後ろの話（旧 004・005）が 005・006 へずれる
      await waitWithContext(
        session,
        async () => {
          const names = await manuscriptNames(session);
          return names.join("|") === ["001.txt", "002.txt", "003.txt", "004.txt", "005.txt", "006.txt"].join("|");
        },
        "話が6つになり、番号が001〜006の並びになる",
        30_000,
        since
      );
      await waitWithContext(
        session,
        async () =>
          (await manuscriptText(session, "004.txt")) === imported &&
          (await manuscriptText(session, "005.txt")) === FILLED[3].text &&
          (await manuscriptText(session, "006.txt")) === FILLED[4].text,
        "004.txt が取り込んだ文、005.txt・006.txt が旧 004・005 の本文になる",
        30_000,
        since
      );
      expect(await manuscriptText(session, "003.txt")).toBe(FILLED[2].text);
      await waitForNotice(session, (message) => message.includes("として足しました") && message.includes("004.txt"), "第4話（004.txt）として足した知らせ", { since });

      // 空いた番号の話が、いまの見た目のまま原稿エディターで開く
      const opened = await frontFrameShowing(page, "差し込んだ話", "取り込んだ文の話（004.txt）が前に出た面に描かれる", 30_000);
      await waitUntil(
        async () => {
          const look = await faceLook(opened);
          return look.vertical && look.size === changed.size;
        },
        "新しい話の面が、縦書き・同じ字の大きさで出る",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（新しい面：${JSON.stringify(await faceLook(opened))}／変えた見た目：${JSON.stringify(changed)}）`);
      });
      expect(tabNamesInclude(await activeTabNames(page), "004.txt"), "前に出ているタブが 004.txt").toBe(true);
    },
    launchWith({ "差し込み.txt": imported })
  );
}, 240_000);

test("［最後に加える］を選ぶと、最後の次の番号で足され、ほかの話の名前も本文も変わらない", async () => {
  const imported = "　最後に足した話。\n";
  await withVsCode(
    "最後に加える",
    FILLED,
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, "003.txt", "三話の本文");
      const since = Date.now();
      await startImport(session, frame, "importText", "最後に.txt");
      await waitDialogWith(session, "この話には本文が入っています", "足し方を訊く確認の窓が出る");
      await pressDialogButton(page, "最後に加える");

      await waitWithContext(
        session,
        async () => (await manuscriptNames(session)).join("|") === [...FIVE, "006.txt"].join("|"),
        "話が6つになり、新しい話は 006.txt になる",
        30_000,
        since
      );
      await waitWithContext(session, async () => (await manuscriptText(session, "006.txt")) === imported, "006.txt が取り込んだ文になる", 30_000, since);
      // ほかの話は名前も本文も変わらない
      await expectFilledUntouched(session);
      await waitForNotice(session, (message) => message.includes("最後に加えました") && message.includes("006.txt"), "006.txt として最後に加えた知らせ", { since });
    },
    launchWith({ "最後に.txt": imported })
  );
}, 240_000);

/* ── 88：上書きする ── */

test("［上書きする］を選ぶと、原稿エディターの本文が取り込んだ文に変わり、書き換える前の本文が .novelai-recovery に残り、知らせに控えの場所が出る", async () => {
  const imported = "　置き換えた本文。\n";
  await withVsCode(
    "上書きする",
    FILLED,
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, "003.txt", "三話の本文");
      const since = Date.now();
      await startImport(session, frame, "importText", "置き換え.txt");
      await waitDialogWith(session, "いまの本文 6字が消え", "上書きで消える字数（6字）を書いた確認の窓が出る");
      await pressDialogButton(page, "上書きする");

      await waitWithContext(session, async () => (await manuscriptText(session, "003.txt")) === imported, "003.txt の本文が取り込んだ文に変わる", 30_000, since);
      await waitComposeWith(session, frame, "置き換えた本文", "原稿エディターの本文が取り込んだ文に変わる");
      // 話の数・名前は変わらない
      expect((await manuscriptNames(session)).join("|")).toBe(FIVE.join("|"));
      const info = await waitForNotice(session, (message) => message.includes("書き換える前の本文は控え"), "控えの場所を書いた知らせ", { since });
      expect(info).toContain(".novelai-recovery");

      // 書き換える前の本文が、控えのファイルに残っている
      const kept = await recoveryTexts(session);
      expect(
        kept.some((text) => text.includes("三話の本文")),
        `.novelai-recovery に前の本文がありません（控え：${JSON.stringify(kept.map((text) => text.slice(0, 20)))}）`
      ).toBe(true);
    },
    launchWith({ "置き換え.txt": imported })
  );
}, 240_000);

/** 作品フォルダーの `.novelai-recovery` の中の控えの文（UTF-8） */
async function recoveryTexts(session: E2ESession): Promise<string[]> {
  const found: string[] = [];
  const walk = async (folder: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (path.basename(folder) === ".novelai-recovery") found.push((await readFile(full).catch(() => Buffer.alloc(0))).toString("utf8"));
    }
  };
  await walk(session.workFolder, 0);
  return found;
}

/* ── 89：1行目を題にするか ── */

test("1行目が題のテキストを、頭の欄のある空の話へ取り込む：「題にしますか」→［題にする］で【タイトル】の欄に入り、本文の頭からは消える", async () => {
  const empty = "【タイトル】\n\n【公開状態】\n未公開\n\n【本文】\n";
  await withVsCode(
    "題にする（頭の欄）",
    [...FILLED.slice(0, 4), { name: "005.txt", text: empty }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisodeFrame(page, "005.txt");
      const since = Date.now();
      await startImport(session, frame, "importText", "題つき.txt");
      await waitDialogWith(session, "1行目「雪の朝」を、この話の題にしますか？", "1行目を題にするかを訊く確認の窓が出る");
      const buttons = await dialogButtons(page);
      for (const label of ["題にする", "本文に入れる", "やめる"]) {
        expect(
          buttons.some((text) => text.includes(label)),
          `［${label}］が並んでいません（ボタン：${JSON.stringify(buttons)}）`
        ).toBe(true);
      }
      await pressDialogButton(page, "題にする");

      await waitWithContext(
        session,
        async () => (await manuscriptText(session, "005.txt")) === "【タイトル】\n雪の朝\n\n【公開状態】\n未公開\n\n【本文】\n　朝が来た。\n",
        "【タイトル】の欄に「雪の朝」が入り、本文の頭から1行目が消える",
        30_000,
        since
      );
      // 名前は変わらない（題の欄が置き場）
      expect((await manuscriptNames(session)).join("|")).toBe(FIVE.join("|"));
      await waitComposeWith(session, frame, "朝が来た", "原稿エディターの本文が取り込んだ文に変わる");
    },
    launchWith({ "題つき.txt": "雪の朝\n\n　朝が来た。\n" })
  );
}, 240_000);

test("1行目が題のテキストを、頭の欄の無い空の話へ取り込む：［題にする］でファイル名のサブタイトルになり、古い名前の面が閉じ、新しい名前の面が同じ見た目で開く", async () => {
  await withVsCode(
    "題にする（ファイル名）",
    [...FILLED.slice(0, 4), { name: "005.txt", text: "\n" }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisodeFrame(page, "005.txt");
      const original = await faceLook(frame);
      await clickToolButton(frame, "dir");
      await waitUntil(async () => (await faceLook(frame)).vertical, "［縦書きにする］で縦書きになる", 10_000);
      await clickToolButton(frame, "bigger");
      await waitUntil(async () => (await faceLook(frame)).size > original.size, "［＋］で字が大きくなる", 10_000);
      const changed = await faceLook(frame);
      await page.waitForTimeout(1_000);

      const since = Date.now();
      await startImport(session, frame, "importText", "題つき.txt");
      await waitDialogWith(session, "1行目「雪の朝」を、この話の題にしますか？", "1行目を題にするかを訊く確認の窓が出る");
      await pressDialogButton(page, "題にする");

      await waitWithContext(
        session,
        async () => {
          const names = await manuscriptNames(session);
          return names.includes("005_雪の朝.txt") && !names.includes("005.txt");
        },
        "ファイル名が 005_雪の朝.txt に変わる",
        30_000,
        since
      );
      await waitWithContext(
        session,
        async () => (await manuscriptText(session, "005_雪の朝.txt")) === "　朝が来た。\n",
        "005_雪の朝.txt の本文から1行目が消えている",
        30_000,
        since
      );
      await waitForNotice(session, (message) => message.includes("ファイル名に付けました") && message.includes("005_雪の朝.txt"), "題をファイル名に付けた知らせ", { since });

      // 古い名前の面が閉じ、新しい名前の面が同じ見た目で出る
      await waitWithContext(
        session,
        async () => !tabNamesInclude((await editorGroupTabs(page)).flat(), "005.txt"),
        "古い名前（005.txt）のタブが閉じる",
        20_000,
        since
      );
      const renamed = await frontFrameShowing(page, "朝が来た", "新しい名前の話が前に出た面に描かれる", 30_000);
      await waitUntil(
        async () => {
          const look = await faceLook(renamed);
          return look.vertical && look.size === changed.size;
        },
        "新しい名前の面が、縦書き・同じ字の大きさで出る",
        15_000
      ).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（新しい面：${JSON.stringify(await faceLook(renamed))}／変えた見た目：${JSON.stringify(changed)}）`);
      });
    },
    launchWith({ "題つき.txt": "雪の朝\n\n　朝が来た。\n" })
  );
}, 240_000);

test("1行目が題のテキストでも、［本文に入れる］を選ぶと1行目も本文に入り、ファイル名は変わらない", async () => {
  await withVsCode(
    "題にしない",
    [...FILLED.slice(0, 4), { name: "005.txt", text: "\n" }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisodeFrame(page, "005.txt");
      const since = Date.now();
      await startImport(session, frame, "importText", "題つき.txt");
      await waitDialogWith(session, "1行目「雪の朝」を、この話の題にしますか？", "1行目を題にするかを訊く確認の窓が出る");
      await pressDialogButton(page, "本文に入れる");

      await waitWithContext(
        session,
        async () => (await manuscriptText(session, "005.txt")) === "雪の朝\n\n　朝が来た。\n",
        "005.txt の本文に1行目も入る",
        30_000,
        since
      );
      expect((await manuscriptNames(session)).join("|")).toBe(FIVE.join("|"));
    },
    launchWith({ "題つき.txt": "雪の朝\n\n　朝が来た。\n" })
  );
}, 240_000);

/* ── 90：傍点は作品の投稿先に合わせる ── */

/** 傍点のある Word を空の話へ取り込み、本文に入った字を返す */
async function importEmphasis(registeredSites: readonly { site: string; newEpisodeUrl: string }[]): Promise<string> {
  let result = "";
  await withVsCode(
    registeredSites.length > 0 ? "傍点（なろうを登録）" : "傍点（登録なし）",
    [...FILLED.slice(0, 4), { name: "005.txt", text: "\n" }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisodeFrame(page, "005.txt");
      const since = Date.now();
      await startImport(session, frame, "importWord", "傍点.docx");
      await waitWithContext(
        session,
        async () => ((await manuscriptText(session, "005.txt")) ?? "\n") !== "\n",
        "005.txt に Word の文が入る",
        30_000,
        since
      );
      result = (await manuscriptText(session, "005.txt")) ?? "";
    },
    launchWith(
      { "傍点.docx": docxOf(wordParagraph(wordDotted("強調") + wordRun("した。"))) },
      registeredSites.length === 0
        ? undefined
        : async ({ workFolder }) => {
            // 投稿サイト設定の見本（なろうを先に登録。作品の登録より前に置く）
            await mkdir(path.join(workFolder, "設定"), { recursive: true });
            await writeFile(
              path.join(workFolder, "設定", "投稿状態.json"),
              `${JSON.stringify({ schemaVersion: "1", sites: registeredSites, posts: [] }, null, 2)}\n`,
              "utf8"
            );
          }
    )
  );
  return result;
}

test("投稿サイト設定でなろうを先に登録した作品の話へ、傍点のある Word を取り込むと、傍点が ｜強調《・・》 の形で入る", async () => {
  const text = await importEmphasis([
    { site: "narou", newEpisodeUrl: "https://syosetu.com/usernovelmanage/isnoveluploadmenu/ncode/n1234ab/" },
    { site: "kakuyomu", newEpisodeUrl: "https://kakuyomu.jp/my/works/1234567890/episodes/new" },
  ]);
  expect(text).toBe("｜強調《・・》した。\n");
}, 240_000);

test("投稿サイトの登録が無い作品の話へ、傍点のある Word を取り込むと、傍点が 《《強調》》 の形で入る", async () => {
  const text = await importEmphasis([]);
  expect(text).toBe("《《強調》》した。\n");
}, 240_000);

/* ── 91：Shift_JIS ── */

test("Shift_JIS（メモ帳の「ANSI」）で保存したテキストを取り込むと、字が化けずに入り、知らせに「Shift_JIS として読みました」が出る", async () => {
  const header = kakuyomuEmpty("第二話　雪の朝");
  await withVsCode(
    "Shift_JIS のテキストを取り込む",
    [{ name: "001.txt", text: FILLED[0].text }, { name: "002.txt", text: header }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisodeFrame(page, "002.txt");
      const since = Date.now();
      await startImport(session, frame, "importText", "メモ_ANSI.txt");
      await waitWithContext(
        session,
        async () => (await manuscriptText(session, "002.txt")) === `${header}　雪の朝が来た。\n二行目の文章です。\n`,
        "002.txt に、化けずに Shift_JIS の文が入る",
        30_000,
        since
      );
      const info = await waitForNotice(session, (message) => message.includes("Shift_JIS として読みました"), "「Shift_JIS として読みました」の知らせ", { since });
      expect(info).toContain("メモ_ANSI.txt");
    },
    launchWith({ "メモ_ANSI.txt": iconv.encode("　雪の朝が来た。\n二行目の文章です。\n", "shift_jis") })
  );
}, 240_000);

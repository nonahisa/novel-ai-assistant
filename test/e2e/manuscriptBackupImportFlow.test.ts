/**
 * 原稿エディターの［入力］→「バックアップから」：足す話の一覧・足す先の窓・番号ずらし・なろうの合本・
 * Shift_JIS／BOM の作品・空の話へ1話（画面の自動テスト、設計書6.25.13・6.113）。
 *
 * 実機確認リストの 36〜39 行（0.150.0「原稿エディターの［入力］→「バックアップから」と
 * ［出力］→「PDF（この話）」」の節の、バックアップの4項目）を機械へ移したもの。並べ方・訊くもの・
 * 番号ずらしの失敗と中止・文字コードと BOM は `unit/core/episodeBackupImport.test.ts`・
 * `unit/features/manuscriptBackupImport.test.ts` が見ている。ここで見るのは、**本物の VS Code で
 * 上の列の［入力］→「バックアップから」を押して起きること**：
 *
 * - 36：カクヨムのバックアップ ZIP を選ぶと、中の話が全部に印の付いた一覧で出る。印を外した話は足されない。
 *   窓に「N話を足します。どこへ足しますか？」と［次の話として足す］［最後に加える］［やめる］が並び
 *   （［上書きする］は出ない）、作る番号（「第4〜5話」）と名前の変わる話の数が書いてある
 * - 37：［次の話として足す］→ 後ろの話の番号が足した数だけずれ、足した話が「004_〈題〉.txt」のように
 *   題の付いた名前で並び、最初の話が原稿エディターで開く。単話プロットの話数も同じだけずれる。
 *   ［最後に加える］→ 最後の次の番号から並び、ほかの話の名前は変わらない
 * - 38：なろうの合本（.txt）→ 足した話に本文だけが入り（【エピソードタイトル】【リアクション】は入らない）、
 *   ルビがそのまま残る。Shift_JIS の作品・BOM 付きの作品へ足した話は、ほかの話と同じ文字コード・改行で、
 *   原稿エディターが化けずに開く
 * - 39：本文が空の話で、一覧の印を1話だけ残すと「〈題〉を、この話（…）へ入れます。」の確かめが出て、
 *   ［入れる］でその話へ入り、ファイル名に題が付く
 *
 * 取り込み元は台本の中で作る（作品の外のフォルダー。作者の原稿・確認用コピーは読まない）。ファイルを
 * 選ぶ窓は簡易の窓で、OS のダイアログを出さない（`support/importFlow.ts`）。
 * **見ていないこと**：番号ずらしのあとの「名前だけのコミット」（作品が Git でないので出ない）。
 * OS のファイル選択窓の見た目。**AI は呼ばない。**
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";
import iconv = require("iconv-lite");
import { expect, test } from "vitest";
import {
  BACKUP_DIALOG_TITLE,
  dialogButtons,
  hexOf,
  launchWith,
  manuscriptBytes,
  manuscriptNames,
  manuscriptText,
  openEpisodeFrame,
  pickFileInDialog,
  sourcePathOf,
  waitDialogWith,
  waitWithContext,
} from "./support/importFlow";
import { clickToolButton, frontFrameShowing, openEpisode } from "./support/manuscriptFrame";
import { waitForNotice } from "./support/noticeRecord";
import { withVsCode, type E2ESession } from "./support/vscodeApp";
import { holdsFor } from "./support/wait";
import { acceptQuickPick, activeTabNames, editorGroupTabs, pressDialogButton, tabNamesInclude, toggleQuickPickRow, waitForQuickPick } from "./support/workbenchDom";
import type { Frame } from "playwright-core";

const encoder = new TextEncoder();

const FIVE = ["001.txt", "002.txt", "003.txt", "004.txt", "005.txt"];
const KANJI = ["一", "二", "三", "四", "五"];
const FILLED = FIVE.map((name, index) => ({ name, text: `　${KANJI[index]}話の本文。\n` }));

/** カクヨムの形のバックアップ（about.txt と話ごとのファイル）。3話。2話目にルビ */
const kakuyomuEpisode = (title: string, body: string) => encoder.encode(["【タイトル】", title, "", "【本文】", body, ""].join("\n"));
const KAKUYOMU_ZIP = zipSync({
  "about.txt": encoder.encode(["【タイトル】", "星の街", "", "【紹介文】", "街の話。", ""].join("\n")),
  "episode_0001.txt": kakuyomuEpisode("第1話　転生前夜", "　夜が更けていく。"),
  "episode_0002.txt": kakuyomuEpisode("第2話　朝", "　朝が来た。｜漢字《かんじ》"),
  "episode_0003.txt": kakuyomuEpisode("第3話　昼", "　昼になった。"),
});
const ZIP_NAME = "星の街.zip";
const ZIP_LIST_TITLE = `「${ZIP_NAME}」から足す話を選んでください（3話）`;

/** なろうのバックアップ（合本を展開した .txt）。各話の末尾に【リアクション】、1話目の本文にルビ */
const sep = (n: number) => `------------------------- エピソード${n}開始 -------------------------`;
const NAROU_NAME = "N4190FX.txt";
const NAROU_TEXT = [
  "【Nコード】",
  "N4190FX",
  "",
  "【タイトル】",
  "肉片とラジオ",
  "",
  sep(1),
  "【エピソードタイトル】",
  "１話　自殺の後始末",
  "",
  "【本文】",
  "　あれは｜中学《ちゅうがく》三年生の頃。",
  "",
  "【リアクション】",
  "0件",
  "",
  sep(2),
  "【エピソードタイトル】",
  "２話　ラジオ",
  "",
  "【本文】",
  "　その夜、ラジオが鳴った。",
  "",
].join("\n");

/** ［入力］→「バックアップから」を押して、バックアップを選ぶ窓で選び、足す話の一覧が出るまで進める */
async function startBackupImport(session: E2ESession, frame: Frame, sourceName: string, listTitle: string) {
  await clickToolButton(frame, "importBackup");
  await pickFileInDialog(session.page, BACKUP_DIALOG_TITLE, sourcePathOf(session, sourceName));
  return waitForQuickPick(session.page, listTitle, 30_000);
}

/** 足さない話の印を外して、［OK］で決める */
async function chooseEntries(session: E2ESession, unpick: readonly string[]): Promise<void> {
  for (const label of unpick) await toggleQuickPickRow(session.page, label);
  await acceptQuickPick(session.page);
}

/** 本文フォルダーの名前の並びが `names`（並べ替えて比べる）になるまで待つ */
async function waitNames(session: E2ESession, names: readonly string[], label: string, since: number): Promise<void> {
  const want = [...names].sort().join("|");
  await waitWithContext(session, async () => (await manuscriptNames(session)).join("|") === want, label, 30_000, since);
}

/** ほかの話（番号ずらしの対象でない話）が元の本文のまま */
async function expectUntouched(session: E2ESession, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const index = FIVE.indexOf(name);
    expect(await manuscriptText(session, name), `${name} が書き換わりました`).toBe(FILLED[index].text);
  }
}

/* ── 36：足す話の一覧と、足す先の窓 ── */

test("途中の話で［入力］→「バックアップから」でカクヨムの ZIP を選ぶと、話が全部に印の付いた一覧で出て、印を外した話は足されず、足す先の窓に作る番号と名前の変わる話の数が書いてある", async () => {
  await withVsCode(
    "バックアップの一覧と足す先",
    FILLED,
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, "003.txt", "三話の本文");
      const rows = await startBackupImport(session, frame, ZIP_NAME, ZIP_LIST_TITLE);

      // 中の話が全部、印の付いた一覧で出る（バックアップの中の順）
      expect(
        rows.map((row) => [row.label, row.checked]),
        `一覧の行：${JSON.stringify(rows)}`
      ).toEqual([
        ["第1話　転生前夜", true],
        ["第2話　朝", true],
        ["第3話　昼", true],
      ]);

      // 2話目の印を外す → 足すのは2話
      await chooseEntries(session, ["第2話　朝"]);
      const asked = await waitDialogWith(session, "2話を足します。どこへ足しますか？", "足す先を訊く確認の窓（2話）が出る");
      // ［次の話として足す］：第4〜5話。後ろの 004・005 の2話の名前が変わる（番号が2つずつずれる）
      expect(asked).toContain("第4〜5話として2話を足します");
      expect(asked).toContain("あとの話のファイル名が変わります（2話。番号が2つずつ後ろへずれます）");
      // ［最後に加える］：最後の次の番号（第6〜7話）から
      expect(asked).toContain("最後の話のあとに第6〜7話として2話を足します");
      // 足す話の一覧に、印を外した話は並ばない
      expect(asked).toContain("第1話　転生前夜");
      expect(asked).toContain("第3話　昼");
      expect(asked, "印を外した話が足す話に並んでいます").not.toContain("第2話　朝");

      const buttons = await dialogButtons(page);
      for (const label of ["次の話として足す", "最後に加える", "やめる"]) {
        expect(
          buttons.some((text) => text.includes(label)),
          `［${label}］が並んでいません（ボタン：${JSON.stringify(buttons)}）`
        ).toBe(true);
      }
      expect(
        buttons.some((text) => text.includes("上書きする")),
        `複数の話を足す窓に［上書きする］が出ています（ボタン：${JSON.stringify(buttons)}）`
      ).toBe(false);

      // やめたら何も変わらない
      await pressDialogButton(page, "やめる");
      await holdsFor(async () => (await manuscriptNames(session)).join("|") === FIVE.join("|"), "［やめる］のあとも話のファイルが増減・改名されない", 2_500);
      await expectUntouched(session, FIVE);
    },
    launchWith({ [ZIP_NAME]: KAKUYOMU_ZIP })
  );
}, 240_000);

/* ── 37：次の話として足す／最後に加える ── */

test("［次の話として足す］を選ぶと、後ろの話の番号が足した数だけずれ、足した話が題の付いた名前で並び、最初の話が原稿エディターで開き、単話プロットの話数も同じだけずれる", async () => {
  const plot = (chapter: number) => `# 第${chapter}話の単話プロット\n\n${chapter}話のあらすじ。\n`;
  await withVsCode(
    "バックアップを次の話として足す",
    FILLED,
    async (session) => {
      const { page } = session;
      const plotFolder = path.join(session.workFolder, "設定", "episode-plots");
      const frame = await openEpisode(page, "003.txt", "三話の本文");
      await startBackupImport(session, frame, ZIP_NAME, ZIP_LIST_TITLE);
      await acceptQuickPick(page); // 3話とも足す
      const since = Date.now();
      await waitDialogWith(session, "3話を足します。どこへ足しますか？", "足す先を訊く確認の窓（3話）が出る");
      await pressDialogButton(page, "次の話として足す");

      // 003 まではそのまま。004〜006 に足した話（題が名前に付く）。旧 004・005 は 007・008 へ
      await waitNames(
        session,
        ["001.txt", "002.txt", "003.txt", "004_転生前夜.txt", "005_朝.txt", "006_昼.txt", "007.txt", "008.txt"],
        "話が8つになり、足した3話が004〜006、旧004・005が007・008になる",
        since
      );
      await waitWithContext(
        session,
        async () =>
          (await manuscriptText(session, "004_転生前夜.txt")) === "　夜が更けていく。\n" &&
          (await manuscriptText(session, "005_朝.txt")) === "　朝が来た。｜漢字《かんじ》\n" &&
          (await manuscriptText(session, "006_昼.txt")) === "　昼になった。\n" &&
          (await manuscriptText(session, "007.txt")) === FILLED[3].text &&
          (await manuscriptText(session, "008.txt")) === FILLED[4].text,
        "足した話の本文と、ずれた旧 004・005 の本文が入っている",
        30_000,
        since
      );
      await expectUntouched(session, ["001.txt", "002.txt", "003.txt"]);
      await waitForNotice(session, (message) => message.includes("3話を、第4〜6話として足しました"), "「3話を、第4〜6話として足しました」の知らせ", { since });

      // 最初の話が原稿エディターで開く
      await frontFrameShowing(page, "夜が更けていく", "足した最初の話（004_転生前夜.txt）が前に出た面に描かれる", 30_000);
      expect(tabNamesInclude(await activeTabNames(page), "004_転生前夜.txt"), "前に出ているタブが 004_転生前夜.txt").toBe(true);

      // 単話プロット：旧 4・5 話は 7・8 話へ。見出しの話数も直る。3話は動かない
      await waitWithContext(
        session,
        async () => (await readdir(plotFolder).catch(() => [] as string[])).sort().join("|") === ["第3話.md", "第7話.md", "第8話.md"].join("|"),
        "単話プロットが 第3話・第7話・第8話 になる",
        30_000,
        since
      );
      expect((await readFile(path.join(plotFolder, "第7話.md"), "utf8")).split("\n")[0]).toBe("# 第7話の単話プロット");
      expect((await readFile(path.join(plotFolder, "第8話.md"), "utf8")).split("\n")[0]).toBe("# 第8話の単話プロット");
      expect(await readFile(path.join(plotFolder, "第3話.md"), "utf8")).toBe(plot(3));
    },
    launchWith({ [ZIP_NAME]: KAKUYOMU_ZIP }, async ({ workFolder }) => {
      const folder = path.join(workFolder, "設定", "episode-plots");
      await mkdir(folder, { recursive: true });
      for (const chapter of [3, 4, 5]) await writeFile(path.join(folder, `第${chapter}話.md`), plot(chapter), "utf8");
    })
  );
}, 240_000);

test("［最後に加える］を選ぶと、最後の次の番号から題の付いた名前で並び、ほかの話の名前も本文も変わらない", async () => {
  await withVsCode(
    "バックアップを最後に加える",
    FILLED,
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, "003.txt", "三話の本文");
      await startBackupImport(session, frame, ZIP_NAME, ZIP_LIST_TITLE);
      await chooseEntries(session, ["第2話　朝"]);
      const since = Date.now();
      await waitDialogWith(session, "2話を足します。どこへ足しますか？", "足す先を訊く確認の窓（2話）が出る");
      await pressDialogButton(page, "最後に加える");

      await waitNames(session, [...FIVE, "006_転生前夜.txt", "007_昼.txt"], "話が7つになり、足した2話が006・007になる", since);
      await waitWithContext(
        session,
        async () =>
          (await manuscriptText(session, "006_転生前夜.txt")) === "　夜が更けていく。\n" && (await manuscriptText(session, "007_昼.txt")) === "　昼になった。\n",
        "足した話の本文が入っている",
        30_000,
        since
      );
      // 元の5話は名前も本文も変わらない
      await expectUntouched(session, FIVE);
      await waitForNotice(session, (message) => message.includes("最後の話のあとに足しました") && message.includes("第6〜7話"), "最後の話のあとに足した知らせ", { since });
    },
    launchWith({ [ZIP_NAME]: KAKUYOMU_ZIP })
  );
}, 240_000);

/* ── 38：なろうの合本・文字コードと改行 ── */

test("なろうのバックアップ（合本の .txt）で2話足すと、足した話に本文だけが入り（【エピソードタイトル】【リアクション】は入らない）、ルビがそのまま残る", async () => {
  await withVsCode(
    "なろうの合本を足す",
    FILLED,
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, "003.txt", "三話の本文");
      await startBackupImport(session, frame, NAROU_NAME, `「${NAROU_NAME}」から足す話を選んでください（2話）`);
      await acceptQuickPick(page);
      const since = Date.now();
      await waitDialogWith(session, "2話を足します。どこへ足しますか？", "足す先を訊く確認の窓（2話）が出る");
      await pressDialogButton(page, "最後に加える");

      await waitNames(session, [...FIVE, "006_自殺の後始末.txt", "007_ラジオ.txt"], "話が7つになり、足した2話が006・007になる", since);
      await waitWithContext(
        session,
        async () => (await manuscriptText(session, "006_自殺の後始末.txt")) !== undefined && (await manuscriptText(session, "007_ラジオ.txt")) !== undefined,
        "足した2話が読める",
        30_000,
        since
      );
      const first = (await manuscriptText(session, "006_自殺の後始末.txt")) ?? "";
      const second = (await manuscriptText(session, "007_ラジオ.txt")) ?? "";
      // 本文だけ。ルビ（｜漢字《かんじ》）はそのまま
      expect(first).toBe("　あれは｜中学《ちゅうがく》三年生の頃。\n");
      expect(second).toBe("　その夜、ラジオが鳴った。\n");
      for (const text of [first, second]) {
        expect(text, "題や反応の欄が本文に入っています").not.toMatch(/【|0件|エピソード/);
      }
    },
    launchWith({ [NAROU_NAME]: NAROU_TEXT })
  );
}, 240_000);

test("Shift_JIS の作品へバックアップの話を足すと、足した話もほかの話と同じ Shift_JIS・CRLF で書かれ、原稿エディターが化けずに開く", async () => {
  const sjis = (text: string) => iconv.encode(text, "shift_jis");
  await withVsCode(
    "Shift_JIS の作品へ足す",
    FILLED,
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, "003.txt", "三話の本文");
      await startBackupImport(session, frame, ZIP_NAME, ZIP_LIST_TITLE);
      await chooseEntries(session, ["第2話　朝", "第3話　昼"]);
      const since = Date.now();
      // 1話だけ選んだので、本文のある話では足し方（3つ）を訊く
      await waitDialogWith(session, "この話には本文が入っています", "1話だけ足すときの確認の窓が出る");
      await pressDialogButton(page, "最後に加える");

      await waitNames(session, [...FIVE, "006_転生前夜.txt"], "話が6つになり、足した話が006になる", since);
      let bytes: Buffer | undefined;
      await waitWithContext(
        session,
        async () => {
          bytes = await manuscriptBytes(session, "006_転生前夜.txt");
          return bytes !== undefined && bytes.length > 0;
        },
        "006_転生前夜.txt に中身が書かれる",
        30_000,
        since
      );
      const want = sjis("　夜が更けていく。\r\n");
      expect(
        Buffer.compare(bytes ?? Buffer.alloc(0), want),
        `足した話のバイトが Shift_JIS・CRLF になっていません（実際：${hexOf(bytes ?? new Uint8Array())}／期待：${hexOf(want)}）`
      ).toBe(0);
      // 原稿エディターが化けずに開く（files.encoding を Shift_JIS にしてあるので、ほかの話と同じ読み方）
      await frontFrameShowing(page, "夜が更けていく", "足した話が化けずに原稿エディターで開く", 30_000);
    },
    launchWith(
      { [ZIP_NAME]: KAKUYOMU_ZIP },
      async ({ manuscriptFolder }) => {
        // 見本は UTF-8 で書かれるので、Shift_JIS・CRLF のバイトで置き直す
        for (const [index, name] of FIVE.entries()) await writeFile(path.join(manuscriptFolder, name), sjis(`　${KANJI[index]}話の本文。\r\n`));
      },
      { "files.encoding": "shiftjis" }
    )
  );
}, 240_000);

test("BOM 付きの UTF-8（CRLF）の作品へバックアップの話を足すと、足した話も BOM 付き・CRLF で書かれ、原稿エディターが化けずに開く", async () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  await withVsCode(
    "BOM 付きの作品へ足す",
    FILLED,
    async (session) => {
      const { page } = session;
      const frame = await openEpisode(page, "003.txt", "三話の本文");
      await startBackupImport(session, frame, ZIP_NAME, ZIP_LIST_TITLE);
      await chooseEntries(session, ["第2話　朝", "第3話　昼"]);
      const since = Date.now();
      await waitDialogWith(session, "この話には本文が入っています", "1話だけ足すときの確認の窓が出る");
      await pressDialogButton(page, "最後に加える");

      await waitNames(session, [...FIVE, "006_転生前夜.txt"], "話が6つになり、足した話が006になる", since);
      let bytes: Buffer | undefined;
      await waitWithContext(
        session,
        async () => {
          bytes = await manuscriptBytes(session, "006_転生前夜.txt");
          return bytes !== undefined && bytes.length > 0;
        },
        "006_転生前夜.txt に中身が書かれる",
        30_000,
        since
      );
      const want = Buffer.concat([bom, Buffer.from("　夜が更けていく。\r\n", "utf8")]);
      expect(
        Buffer.compare(bytes ?? Buffer.alloc(0), want),
        `足した話のバイトが BOM 付き・CRLF になっていません（実際：${hexOf(bytes ?? new Uint8Array())}／期待：${hexOf(want)}）`
      ).toBe(0);
      await frontFrameShowing(page, "夜が更けていく", "足した話が化けずに原稿エディターで開く", 30_000);
    },
    launchWith({ [ZIP_NAME]: KAKUYOMU_ZIP }, async ({ manuscriptFolder }) => {
      for (const [index, name] of FIVE.entries()) {
        await writeFile(path.join(manuscriptFolder, name), Buffer.concat([bom, Buffer.from(`　${KANJI[index]}話の本文。\r\n`, "utf8")]));
      }
    })
  );
}, 240_000);

/* ── 39：本文が空の話へ1話 ── */

test("本文が空の話で、一覧の印を1話だけ残して OK を押すと「〈題〉を、この話（…）へ入れます。」の確かめが出て、［入れる］でその話へ入り、ファイル名に題が付く", async () => {
  await withVsCode(
    "空の話へバックアップの1話",
    [...FILLED.slice(0, 4), { name: "005.txt", text: "\n" }],
    async (session) => {
      const { page } = session;
      const frame = await openEpisodeFrame(page, "005.txt");
      await startBackupImport(session, frame, ZIP_NAME, ZIP_LIST_TITLE);
      await chooseEntries(session, ["第1話　転生前夜", "第3話　昼"]);
      const since = Date.now();
      const asked = await waitDialogWith(session, "「第2話　朝」を、この話（005.txt）へ入れます。", "空の話へ入れる確かめの窓が出る");
      // 題の置き場（サブタイトルの無いファイル名）に付けるので、新しい名前が窓に出る
      expect(asked).toContain("005_朝.txt");
      const buttons = await dialogButtons(page);
      for (const label of ["入れる", "やめる"]) {
        expect(
          buttons.some((text) => text.includes(label)),
          `［${label}］が並んでいません（ボタン：${JSON.stringify(buttons)}）`
        ).toBe(true);
      }
      await pressDialogButton(page, "入れる");

      await waitNames(session, ["001.txt", "002.txt", "003.txt", "004.txt", "005_朝.txt"], "005.txt が 005_朝.txt に変わる（話の数は増えない）", since);
      await waitWithContext(
        session,
        async () => (await manuscriptText(session, "005_朝.txt")) === "　朝が来た。｜漢字《かんじ》\n",
        "005_朝.txt に、選んだ話の本文が入る",
        30_000,
        since
      );
      await expectUntouched(session, ["001.txt", "002.txt", "003.txt", "004.txt"]);
      // 古い名前の面が閉じ、新しい名前の面が開く
      await waitWithContext(session, async () => !tabNamesInclude((await editorGroupTabs(page)).flat(), "005.txt"), "古い名前（005.txt）のタブが閉じる", 20_000, since);
      await frontFrameShowing(page, "朝が来た", "新しい名前の話が前に出た面に描かれる", 30_000);
    },
    launchWith({ [ZIP_NAME]: KAKUYOMU_ZIP })
  );
}, 240_000);

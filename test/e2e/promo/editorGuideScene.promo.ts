/**
 * 編集部（kmizu さん）向けの操作動画：編集部の側の手順を、手順書どおりに1回通す
 * （作者の依頼 2026-10-31「編集部用の動画を作って」。手順は docs/下書き/編集部テスト_操作手順書.txt の 2・4・6 節）。
 *
 * 映す順：
 * 1. 詳細メニュー →「作品管理」→「編集部連携」→「編集部として参加」で、リンクの入力欄にリンクの見本を貼る。
 *    **取り寄せは走らせずに Esc で戻る**（GitHub を呼ばない）。白地の字幕「ここで取り寄せ・登録・切り替えが進みます」の
 *    裏で、作品の登録（製品の「フォルダから追加」と同じ命令）と「作者／編集者切替」で編集者モードにする
 * 2. 「校閲開始／終了」で第2話〜第3話を選ぶ →「第2話〜第3話を校閲中にしました。」（下の帯）
 * 3. 「自己校正」→「校正・校閲」→「表記ゆれ検知」（AI を使わない）→ 提案パネルの［適用］→ 本文は変わらず提案として置かれる
 * 4. 「校閲を終えて返す」→ 確認の窓 →「校閲を終えて、提案 N 件を作者へ返しました。」
 *    送り先は**一時フォルダーの中の裸の置き場**（`addLocalRemote`）。外へは何も出ない
 * 5. 「編集部提案確認」と「編集履歴」を開く
 * 6. 「作者／編集者切替」で作者に戻す
 *
 * **参加（1）を作品の登録より前に撮る**のは、`joinAsEditor` が登録済みの作品が1つでもあると入力欄を出さずに
 * 止まるため（編集者モードは作品1つまで）。`withVsCode` は本体の前に必ず登録するので、`beforeRegister` で撮る。
 * 字幕の裏の待ち（登録・切り替え）は、変換のときに切り詰める（下の `encode`）。
 *
 * 見本の作品は台本の中の作り話（「ゆらめく錫-見本用」・4話）。作者の原稿・確認用コピーは使わない。
 * **AI・GitHub・課金のかかるものは呼ばない。** 製品のコードは変えない。
 *
 * 出力：`docs/下書き/編集部の操作.mp4`（repo には入れない。録ったままは `release/promo/editor-guide-raw.webm`）。
 * 走らせ方：`npm run build` のあと `npx vitest run -c vitest.promo.config.mts test/e2e/promo/editorGuideScene.promo.ts`
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Frame, Locator, Page } from "playwright-core";
import { test } from "vitest";
import { fakeOllamaLaunch, startFakeOllama } from "../support/fakeOllama";
import { addLocalRemote, git, initRepoWithFirstCommit } from "../support/gitFixture";
import { memoPanelFrame, openEpisode } from "../support/manuscriptFrame";
import { proposalPanelFrame, readJsonLines } from "../support/sampleFinding";
import { collapseSidebarPane, SIDEBAR_LAUNCH, treeRow, treeRowLabels } from "../support/sidebar";
import { runCommand } from "../support/quickInput";
import { withVsCode, type FixtureEpisode } from "../support/vscodeApp";
import { holdsFor, waitUntil } from "../support/wait";
import {
  clearNotifications,
  dialogText,
  dismissWorkbenchHover,
  notificationTexts,
  pressWorkbenchKey,
  quickPickRows,
  quickPickTitle,
  statusBarTexts,
} from "../support/workbenchDom";
import { durationSeconds, findFfmpeg } from "./support/encode";
import { PROMO_SETTINGS, SIZE } from "./support/featureScene";
import { clickWithCursor, hideCaption, hideCursor, hideTitleCard, parkCursor, showCaption, showTitleCard } from "./support/overlay";

const runFile = promisify(execFile);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RELEASE_DIR = path.join(repositoryRoot, "release", "promo");
const OUTPUT = path.join(repositoryRoot, "docs", "下書き", "編集部の操作.mp4");

/** 作り話の作品（「たゆたう鉛-実験用」に似せた題） */
const WORK_TITLE = "ゆらめく錫-見本用";
/** 編集部の名前（鍵の持ち主・編集履歴に出る）。実在の人の名前は使わない */
const EDITOR_NAME = "編集部（見本）";
/** 参加の入力欄に貼るリンクの見本（取り寄せは走らせない） */
const SAMPLE_LINK = "https://github.com/sakka-mihon/yurameku-suzu";

/*
  表記ゆれ「できる／出来る」：多い方は「できる」、少ない方の「出来」は範囲（第2話・第3話）の中に1つずつ置く。
  ほかの組（全て／すべて など）が出ないよう、辞書にある語はこれだけにしてある
*/
const EP1 = "001_川霧.txt";
const EP2 = "002_渡し舟.txt";
const EP3 = "003_錫の鈴.txt";
const EP4 = "004_夜明け.txt";
const EPISODES: FixtureEpisode[] = [
  { name: EP1, text: ["　川霧の朝、渡し守の娘は舟を出した。", "　向こう岸へは、昼までに着くことができる。", ""].join("\n") },
  {
    name: EP2,
    text: ["　舟は霧の中で、ゆっくりと揺れていた。", "　娘は、櫂を握ることしか出来なかった。", "　それでも、前へ進むことはできる。", ""].join("\n"),
  },
  {
    name: EP3,
    text: ["　鈴の音が、霧の向こうで鳴った。", "　あの音なら、たどることが出来る。", "　娘は、息を整えることができた。", ""].join("\n"),
  },
  { name: EP4, text: ["　夜明けの岸に、舟は静かに着いた。", "　ここからなら、町へ戻ることができる。", ""].join("\n") },
];

/** 字幕は下の真ん中より少し上・少し右（左の列を出したまま。右下の知らせ〔製品の文言〕に重ねない高さにする） */
const CAPTION = { left: "58%", bottom: "17%" };
/** キー操作のあいだカーソルを退かす点（右下の空いた所） */
const PARK = { x: SIZE.width * 0.9, y: SIZE.height * 0.93 };

const SETTINGS: Record<string, unknown> = {
  ...PROMO_SETTINGS,
  ...SIDEBAR_LAUNCH.settings,
  // 「校閲中にしました」「提案 N 件を作者へ返しました」は下の帯に6秒だけ出る（notifyDone）。帯を隠すと写らない
  "workbench.statusBar.visible": true,
  // 木を送ったとき上に貼り付く見出しが、同じ名前の行を2つにする（押す行を取り違える）ので切る
  "workbench.tree.enableStickyScroll": false,
};

/** 場面の時刻（録り始めからの秒を、あとで静止画を取り出す目安に出す） */
const marks: Array<{ at: number; text: string }> = [];

test("編集部の操作動画を撮る", async () => {
  await mkdir(RELEASE_DIR, { recursive: true });
  const videoDir = path.join(RELEASE_DIR, "raw-editor-guide");
  await rm(videoDir, { recursive: true, force: true });
  const fake = await startFakeOllama(() => "OK");
  let remoteFolder = "";
  let sceneStartedAt = 0;
  let bridgeShownAt = 0;
  let bridgeHiddenAt = 0;
  let sceneEndedAt = 0;
  let videoStartedAt = 0;

  const caption = async (page: Page, text: string): Promise<void> => {
    marks.push({ at: (Date.now() - sceneStartedAt) / 1000, text });
    await showCaption(page, text, CAPTION);
  };

  try {
    const { videoPath } = await withVsCode(
      "広報・編集部の操作",
      EPISODES,
      async (session) => {
        const { page, workFolder, manuscriptFolder } = session;
        videoStartedAt = session.videoStartedAt ?? sceneStartedAt;

        /* ── 字幕の裏：作品の登録は withVsCode が済ませた。続けて編集者モードへ（参加の最後の段と同じ命令） ── */
        await clearNotifications(page);
        await runCommand(page, "作者／編集者切替");
        await waitUntil(async () => ((await dialogText(page)) ?? "").includes("この環境を「編集者」として使いますか。"), "「編集者」として使うかの確認の窓が出る", 20_000);
        await page.locator(".monaco-dialog-box .monaco-button", { hasText: "編集者にする" }).first().click();
        await page.locator(".monaco-dialog-box").waitFor({ state: "detached", timeout: 5_000 });
        const settingsFile = path.join(session.root, "user-data", "User", "settings.json");
        await waitUntil(async () => /"novelai\.mode"\s*:\s*"editor"/.test(await readFile(settingsFile, "utf8").catch(() => "")), "設定 novelai.mode が editor になる", 15_000);
        await waitUntil(async () => (await notificationTexts(page)).some((text) => text.includes("編集者モードにしました")), "「編集者モードにしました」の知らせが出る", 15_000);
        // 原稿エディターで第2話を開いておく（「校閲開始／終了」の始めの話の近道「開いている話」がこれを指す）
        await openEpisode(page, EP2, "櫂を握る");
        await page.waitForTimeout(1_500);
        await clearNotifications(page);
        await collapseIfOpen(page, ["作品管理"]);
        bridgeHiddenAt = Date.now();
        await hideTitleCard(page);

        /* ── 2. 校閲開始／終了 ── */
        await caption(page, "「校閲開始／終了」で、校閲する話の範囲を選ぶ");
        await clickMenu(page, ["作品管理", "編集部連携", "校閲開始／終了"]);
        await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes("始めの話を選びます"), "始めの話を選ぶ画面が出る", 20_000);
        await page.waitForTimeout(1_200);
        await clickPickRow(page, "第2話", "始めの話（第2話）");
        await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes("終わりの話を選びます"), "終わりの話を選ぶ画面が出る", 20_000);
        await caption(page, "始めの話（第2話）と、終わりの話（第3話）");
        await page.waitForTimeout(1_200);
        await clickPickRow(page, "第3話", "終わりの話（第3話）");
        await waitUntil(async () => (await quickPickRows(page)).some((row) => row.label.includes("校閲中")), "何をしているかを選ぶ画面が出る", 20_000);
        await page.waitForTimeout(1_000);
        await clickPickRow(page, "校閲中", "「校閲中」");
        await waitUntil(
          async () => [...(await statusBarTexts(page)), ...(await notificationTexts(page))].some((text) => text.includes("第2話〜第3話を校閲中にしました。")),
          "「第2話〜第3話を校閲中にしました。」が下の帯に出る",
          15_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（下の帯：${JSON.stringify(await statusBarTexts(page))}／右下の知らせ：${JSON.stringify(await notificationTexts(page))}）`);
        });
        await caption(page, "「第2話〜第3話を校閲中にしました。」と出る（下の帯）");
        await parkCursor(page, PARK.x, PARK.y);
        // 鍵は第2話・第3話の2つだけ。編集者の名で押さえる
        const locks = (await readJsonLines(path.join(workFolder, ".aiwriter", "locks", "locks.jsonl"))).filter((line) => line.kind === "acquire");
        const lockedFiles = locks.map((line) => String(line.file).replace(/\\/g, "/")).sort();
        if (lockedFiles.join(",") !== [`本文/${EP2}`, `本文/${EP3}`].join(",") || locks.some((line) => line.holderKind !== "editor")) {
          throw new Error(`押さえた話が第2話・第3話の2つでない、または編集者の名でありません：${JSON.stringify(locks)}`);
        }
        await page.waitForTimeout(2_800);
        await collapseIfOpen(page, ["作品管理"]);

        /* ── 3. 表記ゆれ検知 → 提案パネルの［適用］ ── */
        await caption(page, "「校正・校閲」から「表記ゆれ検知」を走らせる（AIを使わない）");
        await clickMenu(page, ["自己校正", "校正・校閲", "表記ゆれ検知"]);
        await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes("表記ゆれが"), "表記ゆれの組が並ぶ", 30_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（右下の知らせ：${JSON.stringify(await notificationTexts(page))}）`);
        });
        await page.waitForTimeout(1_500);
        const groups = await quickPickRows(page);
        const group = groups.find((row) => row.label.includes("できる") || row.label.includes("出来"));
        if (!group) throw new Error(`「できる／出来る」の組がありません：${JSON.stringify(groups)}`);
        await caption(page, "揃えたい組を選ぶ");
        await clickWithCursor(page, pickRow(page, group.label).locator(".monaco-checkbox").first(), `組「${group.label}」のチェック`);
        await waitUntil(async () => (await quickPickRows(page)).find((row) => row.label === group.label)?.checked === true, "組にチェックが付く", 5_000);
        await page.waitForTimeout(800);
        await clickWithCursor(page, page.locator(".quick-input-widget .quick-input-action .monaco-button", { hasText: "OK" }).first(), "［OK］");
        await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes("どちらに揃えますか"), "揃え先を訊かれる", 15_000);
        await caption(page, "どちらに揃えるかを選ぶ");
        await page.waitForTimeout(1_200);
        const forms = await quickPickRows(page);
        const form = forms.find((row) => row.label.includes("「できる」に揃える"));
        if (!form) throw new Error(`「できる」に揃える行がありません：${JSON.stringify(forms)}`);
        await clickPickRow(page, form.label, "「できる」に揃える");
        await parkCursor(page, PARK.x, PARK.y);

        // 結果は校正・メモパネルに並ぶ。そこから提案パネルを開く（notationScene と同じ道）
        let memo: Frame | undefined;
        let proposals: Frame | undefined;
        await waitUntil(
          async () => {
            proposals = await proposalPanelFrame(page);
            if (proposals && (await proposals.locator('[data-action="apply"]').count()) > 0) return true;
            memo = await memoPanelFrame(page);
            return memo !== undefined && (await memo.locator("button", { hasText: "提案パネル" }).count()) > 0;
          },
          "校正・メモパネルか提案パネルに、表記ゆれの指摘が並ぶ",
          30_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（右下の知らせ：${JSON.stringify(await notificationTexts(page))}）`);
        });
        await clearNotifications(page);
        if (!proposals || (await proposals.locator('[data-action="apply"]').count()) === 0) {
          if (!memo) throw new Error("校正・メモパネルが見つかりません");
          await caption(page, "見つかった箇所から、「提案」パネルを開く");
          await page.waitForTimeout(1_200);
          await clickWithCursor(page, memo.locator("button", { hasText: "提案パネル" }).first(), "［提案パネル］");
          await waitUntil(
            async () => (proposals = await proposalPanelFrame(page)) !== undefined && (await proposals.locator('[data-action="apply"]').count()) > 0,
            "提案パネルに［適用］が並ぶ",
            30_000
          );
        }
        if (!proposals) throw new Error("提案パネルが見つかりません");
        const panel = proposals;
        await caption(page, "直したほうがよいものに［適用］を押す");
        await page.waitForTimeout(1_500);
        const bodyBefore = await readEpisodes(manuscriptFolder);
        const proposalFile = path.join(workFolder, ".aiwriter", "proposals", "proposals.jsonl");
        const proposalCount = async () => (await readJsonLines(proposalFile).catch(() => [])).filter((line) => line.kind === "proposal").length;
        await clickWithCursor(page, panel.locator('[data-action="apply"]').first(), "［適用］");
        await waitUntil(async () => (await proposalCount()) >= 1, "提案の台帳に1件増える", 15_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（提案パネル：${JSON.stringify((await panel.evaluate(() => document.body.innerText)).slice(0, 400))}）`);
        });
        await caption(page, "本文は変わらず、提案として置かれる");
        await parkCursor(page, PARK.x, PARK.y);
        await holdsFor(async () => (await readEpisodes(manuscriptFolder)) === bodyBefore, "［適用］のあとも本文が変わらない", 3_500);
        await clearNotifications(page);

        /* ── 4. 校閲を終えて返す ── */
        await caption(page, "校閲が済んだら「校閲を終えて返す」");
        await clickMenu(page, ["作品管理", "編集部連携", "校閲を終えて返す"]);
        let ask = "";
        await waitUntil(async () => (ask = (await dialogText(page)) ?? "").includes("の校閲を終えて、作者へ返します。"), "返すかの確認の窓が出る", 20_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（右下の知らせ：${JSON.stringify(await notificationTexts(page))}）`);
        });
        const pending = await proposalCount();
        if (!ask.includes("ロック 2 件") || !ask.includes(`提案 ${pending} 件`)) {
          throw new Error(`確認の窓に鍵2件・提案${pending}件が出ていません：${ask}`);
        }
        await caption(page, "確認の窓で［返す］。本文は送らず、提案だけを送る");
        await page.waitForTimeout(2_500);
        await clickWithCursor(page, page.locator(".monaco-dialog-box .monaco-button", { hasText: "返す" }).first(), "［返す］");
        const returned = `校閲を終えて、提案 ${pending} 件を作者へ返しました。`;
        await waitUntil(
          async () => [...(await statusBarTexts(page)), ...(await notificationTexts(page))].some((text) => text.includes(returned)),
          `「${returned}」が下の帯に出る`,
          30_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（下の帯：${JSON.stringify(await statusBarTexts(page))}／右下の知らせ：${JSON.stringify(await notificationTexts(page))}／git status：${await git(workFolder, ["status", "--porcelain", "--untracked-files=all"]).catch((e: unknown) => String(e))}）`);
        });
        await caption(page, `「${returned}」と出る`);
        await parkCursor(page, PARK.x, PARK.y);
        // 送り先（手元の裸の置き場）に「校閲を終えて返す」の記録が届いている
        const sent = await git(remoteFolder, ["log", "--format=%s", "-n", "5", "main"]);
        if (!sent.includes("校閲を終えて返す")) throw new Error(`送り先に「校閲を終えて返す」の記録がありません：${sent}`);
        await page.waitForTimeout(3_000);
        await clearNotifications(page);

        /* ── 5. 編集部提案確認・編集履歴 ── */
        await caption(page, "「編集部提案確認」で、返した提案の行方を見る");
        await clickMenu(page, ["作品管理", "編集部連携", "編集部提案確認"]);
        await waitUntil(async () => (await notificationTexts(page)).some((text) => text.includes("未決の提案") || text.includes("提案はまだありません")), "提案の行方の知らせが出る", 15_000);
        await parkCursor(page, PARK.x, PARK.y);
        await page.waitForTimeout(3_000);
        await caption(page, "作者が採否を決めると、次に開いたときに結果が届く");
        await page.waitForTimeout(2_500);
        await clearNotifications(page);
        await collapseIfOpen(page, ["作品管理"]);
        await caption(page, "「執筆データ」→「編集履歴」で、誰が何をしたかを見る");
        await clickMenu(page, ["執筆データ", "編集履歴"]);
        await waitUntil(async () => (await historyFrame(page)) !== undefined, "編集履歴の画面が開く", 20_000);
        await parkCursor(page, PARK.x, PARK.y);
        await page.waitForTimeout(4_000);
        await collapseIfOpen(page, ["執筆データ"]);

        /* ── 6. 作者に戻す ── */
        await caption(page, "終わったら「作者／編集者切替」で作者に戻す");
        await clickMenu(page, ["作品管理", "編集部連携", "作者／編集者切替"]);
        await waitUntil(async () => ((await dialogText(page)) ?? "").includes("この環境を「作者」に戻しますか。"), "作者に戻すかの確認の窓が出る", 20_000);
        await page.waitForTimeout(1_800);
        await clickWithCursor(page, page.locator(".monaco-dialog-box .monaco-button", { hasText: "作者に戻す" }).first(), "［作者に戻す］");
        await waitUntil(async () => /"novelai\.mode"\s*:\s*"author"/.test(await readFile(settingsFile, "utf8").catch(() => "")), "設定 novelai.mode が author に戻る", 15_000);
        await waitUntil(async () => (await notificationTexts(page)).some((text) => text.includes("作者モードに戻しました")), "「作者モードに戻しました」の知らせが出る", 15_000);
        await caption(page, "「作者モードに戻しました。」と出れば、元どおり");
        await parkCursor(page, PARK.x, PARK.y);
        await page.waitForTimeout(3_000);

        await hideCaption(page);
        await hideCursor(page);
        await showTitleCard(page, "統合小説執筆環境", "編集部の操作は、ここまでです");
        await page.waitForTimeout(2_700);
        sceneEndedAt = Date.now();
      },
      fakeOllamaLaunch(fake, {
        settings: SETTINGS,
        keybindings: SIDEBAR_LAUNCH.keybindings,
        recordVideo: { dir: videoDir, size: SIZE },
        windowSize: SIZE,
        workTitle: WORK_TITLE,
        prepareWork: async ({ workFolder }) => {
          // 本物の git の置き場にして、送り先を一時フォルダーの中の裸の置き場にする（外へは何も出ない）
          await initRepoWithFirstCommit(workFolder);
          await git(workFolder, ["config", "user.name", EDITOR_NAME]);
          remoteFolder = path.join(path.dirname(path.dirname(workFolder)), "送り先.git");
          await addLocalRemote(workFolder, remoteFolder);
        },
        /* ── 1. 編集部として参加（作品の登録より前） ── */
        beforeRegister: async (page) => {
          await showTitleCard(page, "統合小説執筆環境", "編集部の操作 — 参加から、校閲を終えて返すまで");
          sceneStartedAt = Date.now();
          await clearNotifications(page);
          await pressWorkbenchKey(page, "Control+Alt+Shift+KeyJ");
          await page.locator(".pane-header", { hasText: "詳細メニュー" }).first().waitFor({ state: "visible", timeout: 30_000 });
          /*
            「作品一覧」は畳まない。作品の無い一覧は案内とボタン（GitHub から取り寄せる など）を出していて、
            ほかの区画を畳んだあとに見出しを押すと、ずれた先のボタンに当たって取り寄せの入力欄が開いた（2026-10-31 の撮影）
          */
          for (const pane of ["AIに相談", "簡単ステップメニュー"]) await collapseSidebarPane(page, pane).catch(() => undefined);
          await waitUntil(async () => (await treeRow(page, "作品管理").count()) > 0, "詳細メニューに「作品管理」が出る", 30_000);
          await page.waitForTimeout(2_000);
          await clearNotifications(page);
          await page.mouse.move(1200, 700);
          await dismissWorkbenchHover(page);
          // 表題を外す前に、意図しない入力欄・選ぶ画面が開いていないことを確かめる（開いていたら撮り直す）
          const stray = await quickPickTitle(page);
          if (stray !== undefined) throw new Error(`表題の裏で、意図しない入力欄が開いています：${stray}`);
          await hideTitleCard(page);
          await caption(page, "詳細メニュー →「作品管理」→「編集部連携」→「編集部として参加」");
          await clickMenu(page, ["作品管理", "編集部連携", "編集部として参加"]);
          await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes("編集部として参加"), "「編集部として参加」の入力欄が出る", 20_000).catch(async (error: unknown) => {
            throw new Error(`${String(error)}（右下の知らせ：${JSON.stringify(await notificationTexts(page))}）`);
          });
          await parkCursor(page, PARK.x, PARK.y);
          await caption(page, "作者から届いたリンクを貼る");
          await page.waitForTimeout(1_200);
          await page.keyboard.insertText(SAMPLE_LINK);
          await page.waitForTimeout(2_500);
          // ここで Enter を押すと取り寄せが始まる。この動画では押さずに戻る（GitHub を呼ばない）
          await page.keyboard.press("Escape");
          await waitUntil(async () => (await quickPickTitle(page)) === undefined, "入力欄が閉じる", 5_000);
          await hideCaption(page);
          marks.push({ at: (Date.now() - sceneStartedAt) / 1000, text: "（白地）ここで取り寄せ・登録・切り替えが進みます" });
          await showTitleCard(page, "ここで取り寄せ・登録・切り替えが進みます", "編集者モードでは、本文を書き換えず提案として置きます");
          bridgeShownAt = Date.now();
          /*
            焦点を左の列（木）から外し、空のエディターの所へ移す。木に焦点があると、このあと登録の途中で押す
            「版を表示」のキー（Ctrl+Alt+Shift+F10）が本体へ届かず、登録簿の読み返しが時間切れになった
            （2026-10-31 の1回目。木の上では Shift+F10 が品書きのキーとして拾われるとみている）。
            白地は pointer-events: none なので、押した点は下の画面へ届く
          */
          await page.mouse.click(SIZE.width * 0.7, SIZE.height * 0.45);
          await page.waitForTimeout(500);
          await page.keyboard.press("Escape");
        },
      })
    );

    if (!videoPath) throw new Error("動画が録れていません");
    const raw = path.join(RELEASE_DIR, "editor-guide-raw.webm");
    await rm(raw, { force: true });
    await rename(videoPath, raw);
    await rm(videoDir, { recursive: true, force: true });
    const ffmpegPath = await findFfmpeg();
    if (!ffmpegPath) throw new Error(`ffmpeg が無いので変換できません: ${raw}`);
    // 字幕の白地は3.5秒だけ残し、その裏の待ち（登録・切り替え）は切り詰める
    const toVideo = (at: number) => (at - videoStartedAt) / 1000;
    const head = { from: Math.max(0, toVideo(sceneStartedAt) + 0.4), to: toVideo(bridgeShownAt) + 3.5 };
    const tail = { from: toVideo(bridgeHiddenAt) - 0.6, to: toVideo(sceneEndedAt) - 0.3 };
    await encode(ffmpegPath, raw, OUTPUT, head, tail);
    const seconds = await durationSeconds(ffmpegPath, OUTPUT);
    const cut = tail.from - head.to;
    process.stdout.write(`[広報] MP4: ${OUTPUT}（${seconds?.toFixed(1)} 秒・${((await stat(OUTPUT)).size / 1048576).toFixed(2)} MB）\n`);
    // 字幕の時刻（MP4 の中の秒）。白地のあとは切り詰めた分を引く
    const bridgeAt = (bridgeShownAt - sceneStartedAt) / 1000;
    for (const mark of marks) {
      const inMp4 = mark.at - 0.4 + (mark.at > bridgeAt + 0.5 ? -cut : 0);
      process.stdout.write(`[広報] ${inMp4.toFixed(1)}秒　${mark.text}\n`);
    }
  } finally {
    await fake.close();
  }
});

/** 2つの区間をつないで MP4 にする（H.264・yuv420p・1280×720・30fps・crf 20。toMp4 と同じ形） */
async function encode(
  binary: string,
  webm: string,
  mp4: string,
  head: { from: number; to: number },
  tail: { from: number; to: number }
): Promise<void> {
  const part = (label: string, range: { from: number; to: number }) =>
    `[0:v]trim=start=${range.from.toFixed(2)}:end=${range.to.toFixed(2)},setpts=PTS-STARTPTS[${label}]`;
  const filter = [
    part("a", head),
    part("b", tail),
    "[a][b]concat=n=2:v=1:a=0,fps=30,scale=1280:720:flags=lanczos,format=yuv420p[out]",
  ].join(";");
  await runFile(
    binary,
    ["-hide_banner", "-loglevel", "error", "-y", "-i", webm, "-filter_complex", filter, "-map", "[out]", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart", "-an", mp4],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
  );
}

/** 話の本文をまとめて読む（［適用］で本文が変わらないことを見る。書き込み途中の一時ファイルは拾わない） */
async function readEpisodes(folder: string): Promise<string> {
  const texts: string[] = [];
  for (const episode of EPISODES) texts.push((await readFile(path.join(folder, episode.name), "utf8")).replace(/\r\n/g, "\n"));
  return texts.join("\u0000");
}

/** 選ぶ画面の、名前に `label` を含む行 */
function pickRow(page: Page, label: string): Locator {
  return page.locator(".quick-input-widget .quick-input-list .monaco-list-row", { hasText: label }).first();
}

/** 選ぶ画面の行を、描いたカーソルで押す */
async function clickPickRow(page: Page, label: string, name: string): Promise<void> {
  const row = pickRow(page, label);
  await row.waitFor({ state: "visible", timeout: 10_000 });
  // 行の中の名前の字を狙う（行の箱は幅いっぱいで、字の右は空白）
  const target = row.locator(".label-name").first();
  await clickWithCursor(page, (await target.count()) > 0 ? target : row, name);
}

/** 詳細メニューの区画の中身（送る・測る） */
function actionsPane(page: Page): Locator {
  return page.locator(".pane", { has: page.locator(".pane-header", { hasText: "詳細メニュー" }) }).locator(".pane-body").first();
}

/**
 * 詳細メニューの区画を、名前が `head` で始まる行が区画の中に収まるまで送る（上へ戻してから下へ）。
 * 木は見えている行しか DOM に描かないので、見つかるまでホイールで送る
 */
async function revealRow(page: Page, head: string): Promise<Locator> {
  const pane = actionsPane(page);
  const row = treeRow(page, head);
  const box = await pane.boundingBox();
  if (!box) throw new Error("詳細メニューの区画が見えません");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const fits = async () => {
    if ((await row.count()) === 0) return false;
    const rowBox = await row.boundingBox();
    return rowBox !== null && rowBox.y >= box.y && rowBox.y + rowBox.height <= box.y + box.height;
  };
  for (let i = 0; i < 40 && !(await fits()); i++) {
    // 上にあるのか下にあるのかを、描かれていれば位置で、無ければ下へ送って探す
    const rowBox = (await row.count()) > 0 ? await row.boundingBox() : null;
    await page.mouse.wheel(0, rowBox && rowBox.y < box.y ? -60 : 60);
    await page.waitForTimeout(150);
  }
  if (!(await fits())) throw new Error(`詳細メニューに「${head}」の行が出ません（いまの行：${(await treeRowLabels(page)).join(" / ")}）`);
  return row;
}

/** 詳細メニューの区画を一番上まで戻す（前の操作で下へ送ったままのことがある） */
async function scrollMenuTop(page: Page): Promise<void> {
  const box = await actionsPane(page).boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -400);
  await page.waitForTimeout(300);
}

/** 詳細メニューを、見出しを開きながらたどって最後の行を押す（どれも描いたカーソルで押す） */
async function clickMenu(page: Page, steps: readonly string[]): Promise<void> {
  await scrollMenuTop(page);
  for (const [index, head] of steps.entries()) {
    const row = await revealRow(page, head);
    const last = index === steps.length - 1;
    if (!last && (await row.getAttribute("aria-expanded")) === "true") continue;
    await clickWithCursor(page, row.locator(".label-name, .monaco-highlighted-label").first(), `詳細メニューの「${head}」`);
    if (!last) {
      await waitUntil(async () => (await treeRow(page, head).getAttribute("aria-expanded")) === "true", `「${head}」が開く`, 5_000);
      await page.waitForTimeout(500);
    }
  }
}

/** 開いている見出しを畳む（次の操作で行を探しやすくする。画面には写るが、カーソルは出さずに押す） */
async function collapseIfOpen(page: Page, heads: readonly string[]): Promise<void> {
  await scrollMenuTop(page);
  for (const head of heads) {
    const row = await revealRow(page, head).catch(() => treeRow(page, head));
    if ((await row.count()) === 0) continue;
    if ((await row.getAttribute("aria-expanded")) !== "true") continue;
    await row.click();
    await waitUntil(async () => (await row.getAttribute("aria-expanded")) === "false", `「${head}」が畳まれる`, 5_000).catch(() => undefined);
  }
}

/** 編集履歴の画面（WebView）。見出しの字で探す */
async function historyFrame(page: Page): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const has = await frame.evaluate(() => (document.body?.innerText ?? "").includes("編集履歴")).catch(() => false);
    if (has && frame.parentFrame()) return frame;
  }
  return undefined;
}

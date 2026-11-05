/**
 * 編集部の方（拡張機能を初めて触る人）向けの手順書に載せる画面ショットを撮る
 * （リーダーの依頼 2026-11-01。押す所は赤い楕円で囲む——作者の指示 2026-11-01
 * 「選択メニューはわかりやすく〇で囲ってください」）。
 *
 * 撮る場面（ファイル名の番号の順。撮る順は番号と違う——下の注意）：
 * 01 左の拡張機能のアイコンと、編集者モードの簡単ステップメニュー（7段）
 * 02 詳細メニュー →「作品管理」→「編集者連携」を開いたところ
 * 03 「編集者として参加」のリンクを貼る入力欄（参加はしない。Esc で閉じる）
 * 04 「校閲開始／終了」の始めの話・終わりの話・何をしているかを選ぶ画面
 * 05 「表記ゆれ検知」の組を選ぶ・揃え先を選ぶ・提案パネルの［適用］
 * 06 本文を選んで右クリックした品書き（「修正を提案する」）
 * 07 「修正を提案する」の修正案と、理由・意見の入力欄（実際に置く。08・09 に中身ができる）
 * 08 「編集者提案確認」の知らせ
 * 09 「校閲を終えて返す」の確認の窓（返さない。取り消す）
 * 10 「作者／編集者切替」で作者モードへ戻る確認の窓と、戻ったあと
 *
 * **03 は作品の登録より前に撮る**（`beforeRegister`）。「編集部として参加」は登録済みの作品が
 * 1つでもあると入力欄を出さずに止まる（`features/joinAsEditor.ts`。編集者モードは作品1つまで）。
 *
 * 編集者モードの作り方：編集部へ渡した写しと同じく、作品フォルダーに
 * `.aiwriter/editor-share-manifest.json` を置き（`.aiwriter/editing.json` は置かない。
 * `core/editorMode.ts` の `workModeFromMarks`）、設定 `novelai.mode` を `"editor"` にして起こす。
 * 「校閲を終えて返す」の確認の窓は GitHub とつながった作品でしか出ないので、作品フォルダーを
 * git の置き場にし、送り先を**一時フォルダーの中の裸の置き場**にする（外へは何も出ない）。
 * 写しの印は最初の記録より前に置く（後から置くと未記録の変更になり、窓の前で止まる）。
 *
 * 見本の作品は台本の中の作り話（「春を待つ灯（見本）」・3話）。作者の原稿・確認用コピーは使わない。
 * 表記ゆれは「ください／下さい」「すべて／全て」（`core/notationVariants.ts` の一覧にある組。
 * 「ひとつ／一つ」は一覧に無いので使わない）。
 * **AI・GitHub・課金のかかるものは呼ばない。** 製品のコードは変えない。
 *
 * 出力：`docs/手順書/編集部/img/NN_名前.png`（押す所の周りを切り出した2枚目は `_拡大`）。
 * 走らせ方：`npm run manual:shots`（本番ビルドのあと、この台本だけを走らせる）
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Frame, Locator, Page } from "playwright-core";
import { test } from "vitest";
import { fakeOllamaLaunch, startFakeOllama } from "../support/fakeOllama";
import { addLocalRemote, git, initRepoWithFirstCommit } from "../support/gitFixture";
import { memoPanelFrame, openEpisode, selectText } from "../support/manuscriptFrame";
import { fillInput, runCommand } from "../support/quickInput";
import { proposalPanelFrame, readJsonLines } from "../support/sampleFinding";
import { SIDEBAR_LAUNCH, treeRowLabels } from "../support/sidebar";
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
import { clearRings, clipAround, drawRings, type RingTarget } from "./support/redRing";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const IMG_DIR = path.join(repositoryRoot, "docs", "手順書", "編集部", "img");

/** 窓の中身の大きさ（手順書の画像の大きさ） */
const SIZE = { width: 1280, height: 800 };
/** 作り話の作品の題（見本と分かる名前） */
const WORK_TITLE = "春を待つ灯（見本）";
/** 編集部の名前（鍵の持ち主・編集履歴に出る）。実在の人の名前は使わない */
const EDITOR_NAME = "編集者（見本）";
/** 参加の入力欄に貼るリンクの見本（取り寄せは走らせない） */
const SAMPLE_LINK = "https://github.com/sakka-mihon/haru-wo-matsu-akari";

const STEP_PANE = "簡単ステップメニュー";
const ACTION_PANE = "詳細メニュー";

/*
  表記ゆれ：「ください」2つと「下さい」1つ、「すべて」1つと「全て」1つ。
  ほかの組（良い・尚・直ぐ・出来る など）が出ないよう、一覧にある語はこれだけにしてある
*/
const EP1 = "001_灯をともす.txt";
const EP2 = "002_雪どけ.txt";
const EP3 = "003_春の灯.txt";
const EPISODES: FixtureEpisode[] = [
  {
    name: EP1,
    text: ["　春を待つ町に、小さな灯がともった。", "　「足もとに気をつけてください」と、娘は言った。", "　すべての窓は、まだ暗かった。", ""].join("\n"),
  },
  {
    name: EP2,
    text: ["　雪どけの道を、二人は並んで歩いた。", "　「その荷物を、こちらへ下さい」", "　娘は、灯を手で囲った。", ""].join("\n"),
  },
  {
    name: EP3,
    text: ["　町の全ての窓に、灯がともった。", "　「また来てください」と、娘は笑った。", "　春は、もうそこまで来ていた。", ""].join("\n"),
  },
];

/** 「直しを提案する」で選ぶ字と、直した案・ひと言 */
const PROPOSE_TARGET = "もうそこまで来ていた";
const PROPOSE_FIX = "もうすぐそこまで来ていた";
const PROPOSE_REASON = "「すぐ」を足すと、春の近さが伝わります";

const SETTINGS: Record<string, unknown> = {
  ...SIDEBAR_LAUNCH.settings,
  // 編集者モードで起こす（編集部へ渡した写しの印と合わせて、参加を済ませた形）
  "novelai.mode": "editor",
  "workbench.colorTheme": "Default Light Modern",
  // 「校閲中にしました」などは下の帯に数秒だけ出る（notifyDone）。帯を隠すと写らない
  "workbench.statusBar.visible": true,
  // 木を送ったとき上に貼り付く見出しが、同じ名前の行を2つにする（押す行を取り違える）ので切る
  "workbench.tree.enableStickyScroll": false,
  "editor.minimap.enabled": false,
  "breadcrumbs.enabled": false,
  "window.commandCenter": false,
  /*
    拡大はしない（0）。1 にすると窓の中の座標が 1280×800 より小さくなり（1067×667）、画像も粗くなる。
    字の小ささは、押す所の周りを切り出した2枚目（_拡大）で補う
  */
  "window.zoomLevel": 0,
};

/** 撮った画像の一覧（終わりに標準出力へ出す） */
const taken: string[] = [];

test("編集者向けの手順書の画面ショットを撮る", async () => {
  await mkdir(IMG_DIR, { recursive: true });
  const fake = await startFakeOllama(() => "OK");
  let remoteFolder = "";
  try {
    await withVsCode(
      "手順書・編集部",
      EPISODES,
      async (session) => {
        const { page, workFolder, manuscriptFolder } = session;
        const settingsFile = path.join(session.root, "user-data", "User", "settings.json");
        const proposalFile = path.join(workFolder, ".aiwriter", "proposals", "proposals.jsonl");
        const proposalCount = async () => (await readJsonLines(proposalFile).catch(() => [])).filter((line) => line.kind === "proposal").length;

        await clearNotifications(page);
        process.stdout.write(`[手順書] 登録の直後の git status：${JSON.stringify(await git(workFolder, ["status", "--porcelain", "--untracked-files=all"]))}\n`);
        await pressWorkbenchKey(page, "Control+Alt+Shift+KeyJ");
        await setPaneExpanded(page, "AIに相談", false).catch(() => undefined);
        // 作品一覧が左の列の上半分を取り、簡単ステップメニューの7段が収まらない（1回目の撮影）。
        // 編集部は作品1つだけなので、一覧は畳んでおく（上の「選択作品」の行に題が出る）
        await setPaneExpanded(page, "作品一覧", false);

        /* ── 01 拡張機能のアイコンと、簡単ステップメニュー（7段） ── */
        await setPaneExpanded(page, ACTION_PANE, false);
        await setPaneExpanded(page, STEP_PANE, true);
        const steps = [
          "1. 編集者として参加",
          "2. 校閲する範囲を押さえる",
          "3. 検知で探す",
          "4. 修正を提案する",
          "5. 置いた提案を見る",
          "6. 校閲を終えて返す",
          "7. 作者モードへ戻る",
        ];
        await waitUntil(
          async () => {
            for (const head of steps) if (!(await rowFits(page, STEP_PANE, head))) return false;
            return true;
          },
          "簡単ステップメニューに7段がすべて見える",
          30_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（いまの行：${(await treeRowLabels(page)).join(" / ")}）`);
        });
        await calm(page);
        await shoot(page, "01_アイコンと簡単ステップメニュー", [
          { locator: activityIcon(page), label: "左の「統合小説執筆環境」のアイコン" },
          { locator: rowLabel(paneRow(page, STEP_PANE, steps[0] as string)), label: "「1. 編集者として参加」" },
        ], [page.locator(".part.sidebar").first(), activityIcon(page)]);

        /* ── 02 詳細メニュー →「作品管理」→「編集部連携」 ── */
        await setPaneExpanded(page, STEP_PANE, false);
        await setPaneExpanded(page, ACTION_PANE, true);
        await expandPath(page, ACTION_PANE, ["作品管理", "編集者連携"]);
        for (const head of ["編集者として参加", "校閲開始／終了", "修正を提案する", "校閲を終えて返す"]) {
          await revealRow(page, ACTION_PANE, head);
        }
        // 4つが同時に見えていること（手順書の文がこの1枚を指す）
        const visible: string[] = [];
        for (const head of ["編集者として参加", "校閲開始／終了", "修正を提案する", "校閲を終えて返す"]) {
          if (await rowFits(page, ACTION_PANE, head)) visible.push(head);
        }
        if (visible.length !== 4) {
          throw new Error(`「編集者連携」の4つが同時に見えていません（見えたもの：${visible.join("・")}／いまの行：${(await treeRowLabels(page)).join(" / ")}）`);
        }
        await calm(page);
        await shoot(page, "02_詳細メニューの編集部連携", [
          { locator: rowLabel(paneRow(page, ACTION_PANE, "編集者連携")), label: "「編集者連携」" },
          { locator: rowLabel(paneRow(page, ACTION_PANE, "編集者として参加")), label: "「編集者として参加」" },
        ], [page.locator(".part.sidebar").first()]);
        await collapsePath(page, ACTION_PANE, ["作品管理"]);
        await setPaneExpanded(page, ACTION_PANE, false);
        await setPaneExpanded(page, STEP_PANE, true);

        /* ── 04 校閲開始／終了（原稿エディターで第1話を開いておく。始めの話の近道がこれを指す） ── */
        await openEpisode(page, EP1, "足もとに");
        await clearNotifications(page);
        await clickStepEntry(page, steps[1] as string, "校閲開始／終了");
        await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes("始めの話を選びます"), "始めの話を選ぶ画面が出る", 20_000);
        await calm(page);
        await shoot(page, "04a_校閲の始めの話", [{ locator: pickRowLabel(page, "第1話"), label: "始めの話「第1話」" }], [quickWidget(page)]);
        await pickRow(page, "第1話").click();
        await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes("終わりの話を選びます"), "終わりの話を選ぶ画面が出る", 20_000);
        await calm(page);
        await shoot(page, "04b_校閲の終わりの話", [{ locator: pickRowLabel(page, "第3話"), label: "終わりの話「第3話」" }], [quickWidget(page)]);
        await pickRow(page, "第3話").click();
        await waitUntil(async () => (await quickPickRows(page)).some((row) => row.label.includes("校閲中")), "何をしているかを選ぶ画面が出る", 20_000);
        await calm(page);
        await shoot(page, "04c_校閲中を選ぶ", [{ locator: pickRowLabel(page, "校閲中"), label: "「校閲中」" }], [quickWidget(page)]);
        await pickRow(page, "校閲中").click();
        await waitUntil(
          async () => [...(await statusBarTexts(page)), ...(await notificationTexts(page))].some((text) => text.includes("を校閲中にしました")),
          "「…を校閲中にしました。」が出る",
          15_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（下の帯：${JSON.stringify(await statusBarTexts(page))}／右下の知らせ：${JSON.stringify(await notificationTexts(page))}）`);
        });
        await collapseStep(page, steps[1] as string);

        /* ── 05 表記ゆれ検知 → 提案パネルの［適用］ ── */
        await clearNotifications(page);
        await clickStepEntry(page, steps[2] as string, "表記ゆれ検知");
        await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes("表記ゆれが"), "表記ゆれの組が並ぶ", 30_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（右下の知らせ：${JSON.stringify(await notificationTexts(page))}）`);
        });
        await page.waitForTimeout(800);
        const groups = await quickPickRows(page);
        const group = groups.find((row) => row.label.includes("ください") || row.label.includes("下さい"));
        if (!group) throw new Error(`「ください／下さい」の組がありません：${JSON.stringify(groups)}`);
        const groupCheck = pickRow(page, group.label).locator(".monaco-checkbox").first();
        const okButton = page.locator(".quick-input-widget .quick-input-action .monaco-button", { hasText: "OK" }).first();
        await groupCheck.click();
        await waitUntil(async () => (await quickPickRows(page)).find((row) => row.label === group.label)?.checked === true, "組にチェックが付く", 5_000);
        await calm(page);
        await shoot(page, "05a_表記ゆれの組を選ぶ", [
          { locator: groupCheck, label: `組「${group.label}」のチェック` },
          { locator: okButton, label: "［OK］" },
        ], [quickWidget(page)]);
        await okButton.click();
        await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes("どちらに揃えますか"), "揃え先を訊かれる", 15_000);
        await page.waitForTimeout(500);
        const forms = await quickPickRows(page);
        const form = forms.find((row) => row.label.includes("「ください」に揃える"));
        if (!form) throw new Error(`「ください」に揃える行がありません：${JSON.stringify(forms)}`);
        await calm(page);
        await shoot(page, "05b_揃え先を選ぶ", [{ locator: pickRowLabel(page, form.label), label: "「ください」に揃える" }], [quickWidget(page)]);
        await pickRow(page, form.label).click();

        // 結果は校正・メモパネルに並ぶ。そこから提案パネルを開く（編集部の操作動画と同じ道）
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
          await memo.locator("button", { hasText: "提案パネル" }).first().click();
          await waitUntil(
            async () => (proposals = await proposalPanelFrame(page)) !== undefined && (await proposals.locator('[data-action="apply"]').count()) > 0,
            "提案パネルに［適用］が並ぶ",
            30_000
          );
        }
        if (!proposals) throw new Error("提案パネルが見つかりません");
        const panel = proposals;
        const apply = panel.locator('[data-action="apply"]').first();
        await calm(page);
        await shoot(page, "05c_提案パネルの適用", [{ locator: apply, label: "提案パネルの［適用］" }], [apply], 160);
        const bodyBefore = await readEpisodes(manuscriptFolder);
        const before = await proposalCount();
        await apply.click();
        await waitUntil(async () => (await proposalCount()) > before, "［適用］で提案の台帳に1件増える", 15_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（提案パネル：${JSON.stringify((await panel.evaluate(() => document.body.innerText)).slice(0, 400))}）`);
        });
        await holdsFor(async () => (await readEpisodes(manuscriptFolder)) === bodyBefore, "［適用］のあとも本文が変わらない", 2_500);
        await clearNotifications(page);
        await collapseStep(page, steps[2] as string);

        /* ── 06 本文を選んで右クリック ── */
        const frame = await openEpisode(page, EP3, "春は、");
        await selectText(frame, PROPOSE_TARGET);
        await frame.locator("#compose").click({ button: "right", position: await selectionPoint(frame) });
        const proposeItem = frame.locator("#menu .item", { hasText: "修正を提案する" }).first();
        await waitUntil(
          async () => (await frame.locator("#menu").evaluate((menu) => menu.classList.contains("open"))) && (await proposeItem.count()) > 0,
          "右クリックの品書きに「修正を提案する」が出る",
          10_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（品書き：${JSON.stringify(await frame.locator("#menu").innerText().catch(() => ""))}）`);
        });
        if (((await proposeItem.getAttribute("class")) ?? "").includes("disabled")) throw new Error("品書きの「修正を提案する」が押せない形です（選択が届いていない）");
        const menuText = await frame.locator("#menu").innerText();
        if (!menuText.includes("ここにメモを足す")) throw new Error(`品書きに「ここにメモを足す」がありません：${menuText}`);
        // 品書きの上に本物のマウスを載せると行が光るので、画面の端へ逃がしてから撮る（品書きは閉じない）
        await page.mouse.move(SIZE.width - 10, SIZE.height - 40);
        await page.waitForTimeout(300);
        const menuBox = frame.locator("#menu");
        await shoot(page, "06_右クリックの品書き", [{ locator: proposeItem, label: "品書きの「修正を提案する」" }], [menuBox], 60);
        await proposeItem.click();

        /* ── 07 直した案と、ひと言 ── */
        await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes("修正を提案する（1/2）"), "「修正案」の入力欄が出る", 15_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（右下の知らせ：${JSON.stringify(await notificationTexts(page))}）`);
        });
        await fillInput(page, PROPOSE_FIX);
        await calm(page);
        await shoot(page, "07a_直した案", [{ locator: quickInput(page), label: "修正案の入力欄" }], [quickWidget(page)]);
        await page.keyboard.press("Enter");
        await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes("修正を提案する（2/2）"), "「理由・意見」の入力欄が出る", 15_000);
        await page.keyboard.insertText(PROPOSE_REASON);
        await calm(page);
        await shoot(page, "07b_ひと言", [{ locator: quickInput(page), label: "理由・意見の入力欄" }], [quickWidget(page)]);
        const beforeHand = await proposalCount();
        const bodyBeforeHand = await readEpisodes(manuscriptFolder);
        await page.keyboard.press("Enter");
        await waitUntil(async () => (await proposalCount()) > beforeHand, "「修正を提案する」で提案の台帳に1件増える", 15_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（右下の知らせ：${JSON.stringify(await notificationTexts(page))}）`);
        });
        await holdsFor(async () => (await readEpisodes(manuscriptFolder)) === bodyBeforeHand, "「修正を提案する」のあとも本文が変わらない", 2_000);
        await clearNotifications(page);

        /* ── 08 置いた提案を見る（編集部提案確認） ── */
        await clickStepEntry(page, steps[4] as string, "編集者提案確認");
        await waitUntil(
          async () => (await notificationTexts(page)).some((text) => text.includes("未決の提案") || text.includes("提案はまだありません")),
          "提案の行方の知らせが出る",
          15_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（右下の知らせ：${JSON.stringify(await notificationTexts(page))}）`);
        });
        // 知らせは右下で途中までしか写らないので、全文を手順書の下書き用に出しておく
        process.stdout.write(`[手順書] 08 の知らせ：${JSON.stringify(await notificationTexts(page))}\n`);
        await calm(page);
        await shoot(page, "08_編集部提案確認", [{ locator: rowLabel(paneRow(page, STEP_PANE, "編集者提案確認")), label: "「編集者提案確認」" }], [
          page.locator(".notification-toast").first(),
        ]);
        await clearNotifications(page);
        await collapseStep(page, steps[4] as string);

        /* ── 09 校閲を終えて返す（確認の窓まで。返さない） ── */
        await clickStepEntry(page, steps[5] as string, "校閲を終えて返す");
        await waitUntil(async () => ((await dialogText(page)) ?? "").includes("の校閲を終えて、作者へ返します。"), "返すかの確認の窓が出る", 20_000).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（右下の知らせ：${JSON.stringify(await notificationTexts(page))}／git status：${await git(workFolder, ["status", "--porcelain", "--untracked-files=all"]).catch((e: unknown) => String(e))}）`);
        });
        const returnButton = page.locator(".monaco-dialog-box .monaco-button", { hasText: "返す" }).first();
        await calm(page);
        await shoot(page, "09_校閲を終えて返す確認", [{ locator: returnButton, label: "確認の窓の［返す］" }], [page.locator(".monaco-dialog-box").first()]);
        // 取り消す（返さない）。窓の［キャンセル］を押す（試験用の VS Code は日本語の言語パックが無く「Cancel」と出る）
        await page.locator(".monaco-dialog-box .monaco-button", { hasText: /^(キャンセル|Cancel)$/ }).first().click();
        await page.locator(".monaco-dialog-box").waitFor({ state: "detached", timeout: 5_000 });
        await holdsFor(
          async () => ![...(await statusBarTexts(page)), ...(await notificationTexts(page))].some((text) => text.includes("作者へ返しました")),
          "取り消したあと「作者へ返しました」が出ない",
          2_500
        );
        const sent = await git(remoteFolder, ["log", "--format=%s", "-n", "5", "main"]);
        if (sent.includes("校閲を終えて返す")) throw new Error(`取り消したのに送り先へ記録が届いています：${sent}`);
        await collapseStep(page, steps[5] as string);

        /* ── 10 作者モードへ戻る ── */
        await clickStepEntry(page, steps[6] as string, "作者／編集者切替");
        await waitUntil(async () => ((await dialogText(page)) ?? "").includes("この環境を「作者」に戻しますか。"), "作者に戻すかの確認の窓が出る", 20_000);
        const backButton = page.locator(".monaco-dialog-box .monaco-button", { hasText: "作者に戻す" }).first();
        await calm(page);
        await shoot(page, "10a_作者モードへ戻る確認", [{ locator: backButton, label: "確認の窓の［作者に戻す］" }], [page.locator(".monaco-dialog-box").first()]);
        await backButton.click();
        await page.locator(".monaco-dialog-box").waitFor({ state: "detached", timeout: 5_000 });
        await waitUntil(async () => /"novelai\.mode"\s*:\s*"author"/.test(await readFile(settingsFile, "utf8").catch(() => "")), "設定 novelai.mode が author に戻る", 15_000);
        await waitUntil(async () => (await notificationTexts(page)).some((text) => text.includes("作者モードに戻しました")), "「作者モードに戻しました」の知らせが出る", 15_000);
        await page.waitForTimeout(1_500);
        await calm(page);
        await shoot(page, "10b_作者モードに戻った", [], [page.locator(".notification-toast").first()]);

        process.stdout.write(`[手順書] 撮った画像（${taken.length} 枚）：\n${taken.map((name) => `  ${name}`).join("\n")}\n`);
      },
      fakeOllamaLaunch(fake, {
        settings: SETTINGS,
        keybindings: SIDEBAR_LAUNCH.keybindings,
        windowSize: SIZE,
        workTitle: WORK_TITLE,
        prepareWork: async ({ workFolder }) => {
          // 編集部へ渡した写しの印（`shareWithEditor.ts` が書くのと同じ形）。**最初の記録より前に置く**
          const aiwriter = path.join(workFolder, ".aiwriter");
          await mkdir(aiwriter, { recursive: true });
          await writeFile(path.join(aiwriter, "editor-share-manifest.json"), `${JSON.stringify({ files: [] }, null, 2)}\n`, "utf8");
          // 本物の git の置き場にして、送り先を一時フォルダーの中の裸の置き場にする（外へは何も出ない）
          await initRepoWithFirstCommit(workFolder);
          await git(workFolder, ["config", "user.name", EDITOR_NAME]);
          remoteFolder = path.join(path.dirname(path.dirname(workFolder)), "送り先.git");
          await addLocalRemote(workFolder, remoteFolder);
        },
        /* ── 03 編集部として参加（作品の登録より前） ── */
        beforeRegister: async (page) => {
          await clearNotifications(page);
          await pressWorkbenchKey(page, "Control+Alt+Shift+KeyJ");
          await page.locator(".pane-header", { hasText: ACTION_PANE }).first().waitFor({ state: "visible", timeout: 30_000 });
          // 作品一覧は「まだ作品が登録されていません」の案内で場所を取るので畳む（本体の 01 以降と同じ見た目にする）
          for (const pane of ["AIに相談", STEP_PANE, "作品一覧"]) await setPaneExpanded(page, pane, false).catch(() => undefined);
          // 起動の少しあとに出る「はじめまして」の知らせが入力欄の絵に写り込んだ（1回目）。出るのを待ってから払う
          await waitUntil(async () => (await notificationTexts(page)).some((text) => text.includes("はじめまして")), "「はじめまして」の知らせが出る", 10_000).catch(() => undefined);
          await clearNotifications(page);
          await setPaneExpanded(page, ACTION_PANE, true);
          await waitUntil(async () => (await paneRow(page, ACTION_PANE, "作品管理").count()) > 0, "詳細メニューに「作品管理」が出る", 30_000);
          await expandPath(page, ACTION_PANE, ["作品管理", "編集者連携"]);
          const join = await revealRow(page, ACTION_PANE, "編集者として参加");
          await rowLabel(join).click();
          await waitUntil(async () => ((await quickPickTitle(page)) ?? "").includes("編集者として参加"), "「編集者として参加」の入力欄が出る", 20_000).catch(async (error: unknown) => {
            throw new Error(`${String(error)}（右下の知らせ：${JSON.stringify(await notificationTexts(page))}）`);
          });
          await page.keyboard.insertText(SAMPLE_LINK);
          await calm(page);
          await shoot(page, "03_参加のリンクを貼る", [{ locator: quickInput(page), label: "リンクを貼る入力欄" }], [quickWidget(page)]);
          // ここで Enter を押すと取り寄せが始まる。撮るだけなので押さずに閉じる（GitHub を呼ばない）
          await page.keyboard.press("Escape");
          await waitUntil(async () => (await quickPickTitle(page)) === undefined, "入力欄が閉じる", 5_000);
          await collapsePath(page, ACTION_PANE, ["作品管理"]);
          /*
            焦点を左の列（木）から外し、空のエディターの所へ移す。木に焦点があると、このあと登録の途中で押す
            「版を表示」のキー（Ctrl+Alt+Shift+F10）が本体へ届かず、登録簿の読み返しが時間切れになった
            （編集部の操作動画の撮影 2026-10-31）
          */
          await page.mouse.click(SIZE.width * 0.7, SIZE.height * 0.45);
          await page.waitForTimeout(500);
          await page.keyboard.press("Escape");
        },
      })
    );
  } finally {
    await fake.close();
  }
});

/*
  11 作者の採否が届いた知らせと、ベル（通知の一覧）に残る知らせ（手順7の注記。
  編集者が「前回の採否はどこに出る？」と探せなかったため。リーダーの依頼 2026-11-05）。
  別の窓で撮る：採否の行を台帳へ入れると、上の本編の「未決の提案が 2 件」の数が変わってしまう。
  採否は、作者が決めて送り返したあとに編集者の写しへ届く形（台帳の decision の行）を、
  登録のあとに作品の台帳へ書いて記録し、簡単ステップメニューの「保存・同期」で受け取る道（開いたときの点検と同じ関数）で出す。
  **覚えは globalState なので、同じ採否は2度知らせない**（開き直すと知らせは出ず、ベルの一覧も空になる——下で確かめる）。
*/
const DECISION_FILE = "本文/003_春の灯.txt";
const DECIDED: ReadonlyArray<{ target: string; suggestion: string; reason: string; category: string; status: "accepted" | "rejected" | "read" }> = [
  { target: "もうそこまで来ていた", suggestion: "もうすぐそこまで来ていた", reason: "「すぐ」を足すと、春の近さが伝わります", category: "編集者の提案", status: "accepted" },
  { target: "全ての窓", suggestion: "すべての窓", reason: "表記をそろえます", category: "編集者の提案", status: "rejected" },
  { target: "娘は笑った", suggestion: "", reason: "ここで娘の表情をもう少し", category: "編集者の意見", status: "read" },
];

test("編集者の環境で、作者の採否が届いた知らせと、ベルの一覧の知らせを撮る", async () => {
  const fake = await startFakeOllama(() => "OK");
  try {
    await withVsCode(
      "手順書・編集部の採否",
      EPISODES,
      async (session) => {
        const { page, workFolder } = session;
        await clearNotifications(page);
        await pressWorkbenchKey(page, "Control+Alt+Shift+KeyJ");
        await setPaneExpanded(page, "AIに相談", false).catch(() => undefined);
        await setPaneExpanded(page, "作品一覧", false);
        await setPaneExpanded(page, ACTION_PANE, false);
        await setPaneExpanded(page, STEP_PANE, true);

        // 作者が決めて送り返した形（提案3件と、その採否3件）を台帳へ置いて記録する（登録のあと）
        const ledgerFolder = path.join(workFolder, ".aiwriter", "proposals");
        await mkdir(ledgerFolder, { recursive: true });
        const lines: string[] = [];
        for (const [index, entry] of DECIDED.entries()) {
          const id = `pmanual${index}`;
          lines.push(
            JSON.stringify({
              kind: "proposal",
              id,
              time: `2026-11-04T10:0${index}:00.000Z`,
              proposer: EDITOR_NAME,
              file: DECISION_FILE,
              line: index + 1,
              original: entry.target,
              target: entry.target,
              suggestion: entry.suggestion,
              reason: entry.reason,
              category: entry.category,
            })
          );
        }
        for (const [index, entry] of DECIDED.entries()) {
          lines.push(
            JSON.stringify({ kind: "decision", proposalId: `pmanual${index}`, time: `2026-11-05T09:0${index}:00.000Z`, decidedBy: "作者（見本）", status: entry.status, note: "" })
          );
        }
        await writeFile(path.join(ledgerFolder, "proposals.jsonl"), `${lines.join("\n")}\n`, "utf8");
        await git(workFolder, ["add", "-A"]);
        await git(workFolder, ["commit", "--quiet", "-m", "作者の採否を受け取った"]);
        await clearNotifications(page);

        /* ── 11a 「保存・同期」で受け取ると、右下に採否の知らせが出る ── */
        await clickStepEntry(page, "1. 編集者として参加", "保存・同期");
        const decisionText = "作者が提案を決めました";
        await waitUntil(
          async () => (await notificationTexts(page)).some((text) => text.includes(decisionText)),
          "「作者が提案を決めました」の知らせが出る",
          30_000
        ).catch(async (error: unknown) => {
          throw new Error(`${String(error)}（右下の知らせ：${JSON.stringify(await notificationTexts(page))}／下の帯：${JSON.stringify(await statusBarTexts(page))}）`);
        });
        process.stdout.write(`[手順書] 11a の知らせ：${JSON.stringify(await notificationTexts(page))}\n`);
        const toast = page.locator(".notification-toast", { hasText: decisionText }).first();
        // 知らせは数秒で消えるので、マウスは動かさずすぐ撮る（一覧に残るかはあとで見る）
        await shoot(page, "11a_作者の採否の知らせ", [{ locator: toast.locator(".notification-list-item-message span").first(), label: "作者が提案を決めました の知らせ" }], [toast]);

        /* ── 11b ベルを押すと、過去の知らせの一覧にその知らせが残っている ── */
        await waitUntil(async () => (await page.locator(".notification-toast").count()) === 0, "右下の知らせが消える（自動）", 30_000).catch(() => undefined);
        const bell = page.locator('.part.statusbar .statusbar-item[id="status.notifications"] a, .part.statusbar #status\\.notifications a').first();
        await bell.click();
        const center = page.locator(".notifications-center").first();
        await center.waitFor({ state: "visible", timeout: 10_000 });
        const listed = page.locator(".notifications-center .notification-list-item", { hasText: decisionText }).first();
        await listed.waitFor({ state: "visible", timeout: 10_000 });
        process.stdout.write(`[手順書] 11b のベルの一覧：${JSON.stringify(await page.locator(".notifications-center .notification-list-item").allInnerTexts())}\n`);
        await page.mouse.move(SIZE.width - 10, SIZE.height - 40);
        await page.waitForTimeout(300);
        await shoot(page, "11b_ベルの一覧", [
          // ベルは窓の右下の角で、囲みが切れる。囲みを内側（左上）へずらす（ベル自体は囲みの中に入る）
          { locator: bell, label: "下の帯のベル", fit: (box) => ({ ...box, x: box.x - 6, y: box.y - 6 }) },
          { locator: listed.locator(".notification-list-item-message span").first(), label: "一覧に残った知らせ" },
        ], [center, bell], 40);

        /* ── 開き直しで消えるか（撮らない。注記に書くための確認） ── */
        await page.keyboard.press("Escape");
        await runCommand(page, "Developer: Reload Window");
        await page.waitForTimeout(8_000);
        await page.locator(".monaco-workbench").waitFor({ timeout: 60_000 });
        await page.waitForTimeout(6_000);
        const afterReload = await notificationTexts(page);
        process.stdout.write(`[手順書] 開き直し後の右下の知らせ：${JSON.stringify(afterReload)}\n`);
        await page.locator('.part.statusbar #status\\.notifications a').first().click().catch(() => undefined);
        await page.waitForTimeout(800);
        const centerAfter = await page.locator(".notifications-center .notification-list-item").allInnerTexts().catch(() => [] as string[]);
        process.stdout.write(`[手順書] 開き直し後のベルの一覧：${JSON.stringify(centerAfter)}\n`);
        // 見逃した・開き直したあとに採否を見る道：「編集者提案確認」の知らせに「これまでの採否」が出る
        await page.keyboard.press("Escape");
        await clearNotifications(page);
        await clickStepEntry(page, "5. 置いた提案を見る", "編集者提案確認");
        await waitUntil(async () => (await notificationTexts(page)).some((text) => text.includes("提案")), "編集者提案確認の知らせが出る", 15_000).catch(() => undefined);
        process.stdout.write(`[手順書] 開き直し後の「編集者提案確認」：${JSON.stringify(await notificationTexts(page))}\n`);
        if (centerAfter.some((text) => text.includes(decisionText)) || afterReload.some((text) => text.includes(decisionText))) {
          process.stdout.write("[手順書] 開き直しのあとも知らせが残っている／もう一度出た\n");
        } else {
          process.stdout.write("[手順書] 開き直すと、ベルの一覧から知らせは消え、同じ知らせは出ない\n");
        }
      },
      fakeOllamaLaunch(fake, {
        settings: SETTINGS,
        keybindings: SIDEBAR_LAUNCH.keybindings,
        windowSize: SIZE,
        workTitle: WORK_TITLE,
        prepareWork: async ({ workFolder }) => {
          const aiwriter = path.join(workFolder, ".aiwriter");
          await mkdir(aiwriter, { recursive: true });
          await writeFile(path.join(aiwriter, "editor-share-manifest.json"), `${JSON.stringify({ files: [] }, null, 2)}\n`, "utf8");
          await initRepoWithFirstCommit(workFolder);
          await git(workFolder, ["config", "user.name", EDITOR_NAME]);
          await addLocalRemote(workFolder, path.join(path.dirname(path.dirname(workFolder)), "送り先.git"));
        },
      })
    );
  } finally {
    await fake.close();
  }
});

/* ── 撮る ── */

/**
 * 押す所を囲んで、窓全体と、`focus` の周りを切り出した2枚目（`_拡大`）を撮る。
 * 撮ったら囲みを消す（次の操作の邪魔をしない。囲みは pointer-events: none だが、念のため）
 */
async function shoot(page: Page, name: string, rings: readonly RingTarget[], focus: readonly Locator[], margin = 24): Promise<void> {
  await drawRings(page, rings);
  await page.waitForTimeout(150);
  const full = path.join(IMG_DIR, `${name}.png`);
  await page.screenshot({ path: full });
  taken.push(path.basename(full));
  if (focus.length > 0) {
    const clip = await clipAround(page, focus, margin);
    const zoom = path.join(IMG_DIR, `${name}_拡大.png`);
    await page.screenshot({ path: zoom, clip });
    taken.push(path.basename(zoom));
  }
  await clearRings(page);
}

/** 撮る前に、吹き出しを払い、マウスを邪魔にならない所へ置く */
async function calm(page: Page): Promise<void> {
  await dismissWorkbenchHover(page).catch(() => undefined);
  await page.mouse.move(SIZE.width - 10, SIZE.height - 40);
  await page.waitForTimeout(400);
}

/* ── 左の列 ── */

/** 左の端の「統合小説執筆環境」のアイコン */
function activityIcon(page: Page): Locator {
  return page.locator('.part.activitybar .action-item .action-label[aria-label*="統合小説執筆環境"]').first();
}

function pane(page: Page, title: string): Locator {
  return page.locator(".pane", { has: page.locator(".pane-header", { hasText: title }) }).first();
}

function paneBody(page: Page, title: string): Locator {
  return pane(page, title).locator(".pane-body").first();
}

/** 区画 `title` の中の、名前（aria-label）が `head` で始まる行（同じ名前が別の区画にあっても取り違えない） */
function paneRow(page: Page, title: string, head: string): Locator {
  return pane(page, title).locator(`.monaco-list-row[aria-label^="${head.replace(/"/g, '\\"')}"]`).first();
}

/** 行の中の名前の字（行の箱は幅いっぱいなので、囲むのは字のほう） */
function rowLabel(row: Locator): Locator {
  return row.locator(".label-name").first();
}

/** 区画を開く／畳む */
async function setPaneExpanded(page: Page, title: string, expanded: boolean): Promise<void> {
  const header = page.locator(".pane-header", { hasText: title }).first();
  await header.waitFor({ state: "visible", timeout: 15_000 });
  const isOpen = async () => (await header.getAttribute("aria-expanded")) === "true";
  if ((await isOpen()) === expanded) return;
  // 見出しの真ん中は右の操作のボタン（作品一覧の［＋］など）に当たりうるので、左の端（開閉の印）を押す
  await header.click({ position: { x: 12, y: 10 } });
  await waitUntil(async () => (await isOpen()) === expanded, `左の列の「${title}」を${expanded ? "開く" : "畳む"}`, 5_000);
  await page.waitForTimeout(300);
}

/** 行が区画の中に収まって見えているか */
async function rowFits(page: Page, title: string, head: string): Promise<boolean> {
  const row = paneRow(page, title, head);
  if ((await row.count()) === 0) return false;
  const box = await paneBody(page, title).boundingBox();
  const rowBox = await row.boundingBox();
  return box !== null && rowBox !== null && rowBox.y >= box.y && rowBox.y + rowBox.height <= box.y + box.height;
}

/**
 * 区画を、名前が `head` で始まる行が区画の中に収まるまで送る。
 * 木は見えている行しか DOM に描かないので、見つかるまでホイールで送る（編集部の操作動画と同じ）
 */
async function revealRow(page: Page, title: string, head: string): Promise<Locator> {
  const row = paneRow(page, title, head);
  const box = await paneBody(page, title).boundingBox();
  if (!box) throw new Error(`「${title}」の区画が見えません`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 40 && !(await rowFits(page, title, head)); i++) {
    const rowBox = (await row.count()) > 0 ? await row.boundingBox() : null;
    await page.mouse.wheel(0, rowBox && rowBox.y < box.y ? -60 : 60);
    await page.waitForTimeout(150);
  }
  if (!(await rowFits(page, title, head))) throw new Error(`「${title}」に「${head}」の行が出ません（いまの行：${(await treeRowLabels(page)).join(" / ")}）`);
  return row;
}

/** 区画を一番上まで戻す */
async function scrollTop(page: Page, title: string): Promise<void> {
  const box = await paneBody(page, title).boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -400);
  await page.waitForTimeout(300);
}

/** 見出しを順に開く（開いているものはそのまま） */
async function expandPath(page: Page, title: string, heads: readonly string[]): Promise<void> {
  await scrollTop(page, title);
  for (const head of heads) {
    const row = await revealRow(page, title, head);
    if ((await row.getAttribute("aria-expanded")) === "true") continue;
    await rowLabel(row).click();
    await waitUntil(async () => (await paneRow(page, title, head).getAttribute("aria-expanded")) === "true", `「${head}」が開く`, 5_000);
    await page.waitForTimeout(300);
  }
}

/** 開いている見出しを畳む */
async function collapsePath(page: Page, title: string, heads: readonly string[]): Promise<void> {
  await scrollTop(page, title);
  for (const head of heads) {
    const row = await revealRow(page, title, head).catch(() => paneRow(page, title, head));
    if ((await row.count()) === 0) continue;
    if ((await row.getAttribute("aria-expanded")) !== "true") continue;
    await rowLabel(row).click();
    await waitUntil(async () => (await row.getAttribute("aria-expanded")) === "false", `「${head}」が畳まれる`, 5_000).catch(() => undefined);
  }
}

/** 簡単ステップメニューの段を開いて、その中の `entry` を押す */
async function clickStepEntry(page: Page, step: string, entry: string): Promise<void> {
  await setPaneExpanded(page, STEP_PANE, true);
  await expandPath(page, STEP_PANE, [step]);
  const row = await revealRow(page, STEP_PANE, entry);
  await dismissWorkbenchHover(page).catch(() => undefined);
  await rowLabel(row).click();
}

/** 簡単ステップメニューの段を畳む（次の段の行を探しやすくする） */
async function collapseStep(page: Page, step: string): Promise<void> {
  await collapsePath(page, STEP_PANE, [step]);
}

/* ── 上に出る選ぶ画面・入力欄 ── */

function quickWidget(page: Page): Locator {
  return page.locator(".quick-input-widget").first();
}

function quickInput(page: Page): Locator {
  return page.locator(".quick-input-widget .quick-input-box input").first();
}

/** 選ぶ画面の、名前に `label` を含む行 */
function pickRow(page: Page, label: string): Locator {
  return page.locator(".quick-input-widget .quick-input-list .monaco-list-row", { hasText: label }).first();
}

/** 選ぶ画面の行の名前の字（行の箱は幅いっぱいなので、囲むのは字のほう） */
function pickRowLabel(page: Page, label: string): Locator {
  return pickRow(page, label).locator(".label-name").first();
}

/* ── 原稿 ── */

/** 組んで書く面の、いまの選択の真ん中を `#compose` の中の位置で返す（右クリックの場所） */
async function selectionPoint(frame: Frame): Promise<{ x: number; y: number }> {
  const point = await frame.evaluate(() => {
    const compose = document.getElementById("compose");
    const selection = window.getSelection();
    if (!compose || !selection || selection.rangeCount === 0) return undefined;
    const range = selection.getRangeAt(0);
    const rects = Array.from(range.getClientRects());
    const rect = rects.find((entry) => entry.height > 0) ?? range.getBoundingClientRect();
    const base = compose.getBoundingClientRect();
    return { x: rect.left - base.left + Math.max(rect.width / 2, 1), y: rect.top - base.top + rect.height / 2 };
  });
  if (!point) throw new Error("組んで書く面の選択が取れません（右クリックの場所が決まりません）");
  return point;
}

/** 話の本文をまとめて読む（本文が変わらないことを見る。書き込み途中の一時ファイルは拾わない） */
async function readEpisodes(folder: string): Promise<string> {
  const texts: string[] = [];
  for (const episode of EPISODES) texts.push((await readFile(path.join(folder, episode.name), "utf8")).replace(/\r\n/g, "\n"));
  return texts.join("\u0000");
}

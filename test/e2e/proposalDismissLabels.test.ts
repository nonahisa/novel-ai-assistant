/**
 * 提案パネルのボタンの名前（画面の自動テスト、設計書6.11・6.99.7・6.113。実機確認リスト 0.122.0 の 373 行を
 * 機械へ移した。作者の判断 2026-11-02「退けるボタンは［見送る］、押したあとの札は『見送りました』」）。
 *
 * 1. 誤字脱字・推敲・表記ゆれ・矛盾のタブで、退けるボタンが［見送る］。押すと行の札が「見送りました」になる。
 *    誤字脱字を［適用］したあとのボタンは［戻す］のまま
 * 2. バックアップとの違いの行は［バックアップを採る］［見送る］で、採ったあとは［手元の文に戻す］になる。
 *    見送った行からはボタンが消える
 *
 * **AI は呼ばない。** 1 の指摘は置き場（`.aiwriter/findings.jsonl`）へ製品が読む形で見本を置く。
 * 2 のバックアップとの違いは、相談画面へなろうの合本（展開した .txt）を落として作る（落とし方は
 * backupDropFromExplorer の「OS のエクスプローラーから」と同じ。WebView の外側の枠の CDP の口へ引きずりの便を送る）。
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { BACKUP_DIFF_RECORD_KIND } from "../../src/core/backupMerge";
import { OPEN_PROPOSALS_KEY, OPEN_PROPOSALS_PRESS, proposalPanelFrame, writeSampleFindings, type SampleFinding } from "./support/sampleFinding";
import { E2E_WORK_TITLE, withVsCode, type E2ESession } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { clearNotifications, dialogText, pressDialogButton, pressWorkbenchKey, quickInputWaitContext } from "./support/workbenchDom";
import { readFileWhenPresent } from "./support/fileSettle";

const EPISODE = "001_駅.txt";
const TEXT = [
  "　終電を逃した駅のホームに、雨の音だけが残っていた。",
  "　近づいてみると、男は以外にも若かった。",
  "　彼は灯台を見上げけて、息を吐いた。",
  "　ポケットのスマホが震え、別のポケットではスマートフォンが光った。",
  "　ホームの時計が、零時を指していた。",
  "",
].join("\n");

/** ［適用］して［戻す］を見る誤字脱字 */
const TYPO_APPLY: SampleFinding = { episode: EPISODE, text: TEXT, original: "男は以外にも若かった。", target: "以外", suggestion: "意外", message: "「思いのほか」の意味なら「意外」です" };
/** ［見送る］誤字脱字 */
const TYPO_DISMISS: SampleFinding = { episode: EPISODE, text: TEXT, original: "彼は灯台を見上げけて、息を吐いた。", target: "見上げけて", suggestion: "見上げて", message: "「け」が重なっています" };
const PROOFREAD: SampleFinding = {
  episode: EPISODE,
  text: TEXT,
  original: "　終電を逃した駅のホームに、雨の音だけが残っていた。",
  target: "　終電を逃した駅のホームに、雨の音だけが残っていた。",
  suggestion: "　終電を逃した駅のホームには、雨の音だけが残っていた。",
  message: "冗長",
  category: "proofread",
  label: "推敲",
};
const NOTATION: SampleFinding = {
  episode: EPISODE,
  text: TEXT,
  original: "スマートフォン",
  target: "スマートフォン",
  suggestion: "スマホ",
  message: "「スマホ」と「スマートフォン」が混ざっています",
  category: "notation",
  label: "表記ゆれ",
};
const CONTRADICTION: SampleFinding = {
  episode: EPISODE,
  text: TEXT,
  original: "　ホームの時計が、零時を指していた。",
  target: "零時",
  suggestion: "",
  message: "第1話では終電の時刻を二十三時としています",
  category: "contradiction",
  label: "矛盾",
};

/** 提案パネルを開き、`ready` が満たされるまで待つ */
async function openProposals(page: Page, ready: (frame: Frame) => Promise<boolean>, what: string): Promise<Frame> {
  await clearNotifications(page);
  await pressWorkbenchKey(page, OPEN_PROPOSALS_PRESS);
  let proposals: Frame | undefined;
  await waitUntil(
    async () => {
      proposals = await proposalPanelFrame(page);
      return proposals !== undefined && (await ready(proposals));
    },
    what,
    20_000
  ).catch(async (error: unknown) => {
    const shown = proposals ? await proposals.evaluate(() => document.body.innerText.slice(0, 600)).catch(() => "") : "（提案パネルが無い）";
    throw new Error(`${String(error)}（提案パネルの字：${JSON.stringify(shown)}）`);
  });
  if (!proposals) throw new Error("提案パネルが見つかりません");
  return proposals;
}

/** 分類のタブを押して、その分類の一覧へ切り替える */
async function selectCategory(frame: Frame, category: string): Promise<void> {
  const tab = frame.locator(`#tabs .tab[data-category="${category}"]`);
  await waitUntil(async () => (await tab.count()) > 0, `提案パネルに「${category}」のタブがある`, 10_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（タブ：${JSON.stringify(await frame.locator("#tabs .tab").allInnerTexts())}）`);
  });
  await tab.first().click();
  await waitUntil(async () => ((await frame.locator("#category").innerText().catch(() => "")) ?? "").trim() === category, `見出しが「${category}」になる`, 10_000);
}

/** いま見えている一覧の中で、`needle` を含む行 */
function issueRow(frame: Frame, needle: string) {
  return frame.locator("#list .issue", { hasText: needle }).first();
}

/** 行のボタンの名前（前後の空白を落とす） */
async function buttonLabels(row: ReturnType<typeof issueRow>): Promise<string[]> {
  return (await row.locator("button").allInnerTexts()).map((text) => text.trim());
}

/** 行の「見送る」を押し、札が「見送りました」になるまで待つ。押す前の行のボタンを返す */
async function dismissRow(frame: Frame, needle: string, label: string): Promise<string[]> {
  const row = issueRow(frame, needle);
  await waitUntil(async () => (await row.count()) > 0, `${label}：行が並ぶ`, 10_000).catch(async (error: unknown) => {
    throw new Error(`${String(error)}（一覧：${JSON.stringify((await frame.locator("#list").innerText().catch(() => "")).slice(0, 600))}）`);
  });
  const before = await buttonLabels(row);
  await row.locator('button[data-action="dismiss"]').click();
  await waitUntil(async () => ((await row.innerText().catch(() => "")) ?? "").includes("見送りました"), `${label}：［見送る］のあと札が「見送りました」になる`, 10_000).catch(
    async (error: unknown) => {
      throw new Error(`${String(error)}（行：${JSON.stringify(await row.innerText().catch(() => ""))}）`);
    }
  );
  return before;
}

async function fileText(session: E2ESession, name: string): Promise<string> {
  return (await readFileWhenPresent(path.join(session.manuscriptFolder, name))).replace(/\r\n/g, "\n");
}

test("提案パネルで、誤字脱字・推敲・表記ゆれ・矛盾の退けるボタンは［見送る］で、押すと札が「見送りました」になり、誤字脱字を［適用］したあとは［戻す］になる", async () => {
  await withVsCode(
    "提案パネルの見送る",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await writeSampleFindings(session.workFolder, [TYPO_APPLY, TYPO_DISMISS, PROOFREAD, NOTATION, CONTRADICTION]);
      const proposals = await openProposals(
        page,
        async (frame) => (await frame.locator("#tabs .tab").count()) >= 4,
        "提案パネルに置き場の指摘が分類のタブごとに並ぶ"
      );

      /* ── 誤字脱字：［見送る］→「見送りました」、［適用］→［戻す］ ── */
      await selectCategory(proposals, "誤字脱字");
      const typoButtons = await dismissRow(proposals, "見上げけて", "誤字脱字");
      expect(typoButtons, `誤字脱字の行のボタン：${JSON.stringify(typoButtons)}`).toEqual(expect.arrayContaining(["適用", "見送る"]));
      const applyRow = issueRow(proposals, "以外");
      await applyRow.locator('button[data-action="apply"]').click();
      await waitUntil(async () => (await fileText(session, EPISODE)).includes("男は意外にも若かった。"), "［適用］で本文のファイルが直る", 15_000);
      await waitUntil(async () => (await buttonLabels(issueRow(proposals, "意外"))).includes("戻す"), "［適用］したあとの行に［戻す］が出る", 10_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（一覧：${JSON.stringify((await proposals.locator("#list").innerText().catch(() => "")).slice(0, 600))}）`);
      });
      expect(await buttonLabels(issueRow(proposals, "意外")), "［適用］したあとの行のボタン").toEqual(["戻す"]);

      /* ── 推敲・表記ゆれ ── */
      await selectCategory(proposals, "推敲");
      const proofButtons = await dismissRow(proposals, "雨の音だけ", "推敲");
      expect(proofButtons, `推敲の行のボタン：${JSON.stringify(proofButtons)}`).toContain("見送る");
      await selectCategory(proposals, "表記ゆれ");
      const notationButtons = await dismissRow(proposals, "スマートフォン", "表記ゆれ");
      expect(notationButtons, `表記ゆれの行のボタン：${JSON.stringify(notationButtons)}`).toContain("見送る");

      /* ── 矛盾（形の違う行。本文を見る・設定資料を見る・見送る） ── */
      await selectCategory(proposals, "矛盾");
      const contradictionButtons = await dismissRow(proposals, "二十三時", "矛盾");
      expect(contradictionButtons, `矛盾の行のボタン：${JSON.stringify(contradictionButtons)}`).toContain("見送る");

      // 古い名前（却下・退ける）のボタンはどの行にも無い
      const all = (await proposals.locator("button").allInnerTexts()).map((text) => text.trim());
      expect(all.filter((text) => /却下|退ける/.test(text)), `古い名前のボタン：${JSON.stringify(all)}`).toEqual([]);
    },
    { keybindings: [{ key: OPEN_PROPOSALS_KEY, command: "novelai.openProposals" }] }
  );
}, 240_000);

/* ───────────── バックアップとの違い ───────────── */

const SEP = (n: number) => `------------------------- エピソード${n}開始 -------------------------`;
const TITLES = ["潮の匂い", "古い地図"];
const wide = (n: number) => String(n).replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));
/** 手元の本文（なろうの合本を話ごとに分けた形。区切り行の番号でバックアップの話と照らされる） */
const LOCAL_BODY = (n: number) => `${TITLES[n - 1]}の本文。手元で書いた文。`;
/** バックアップの本文（各話の本文の1行だけが手元と違う） */
const BACKUP_BODY = (n: number) => `${TITLES[n - 1]}の本文。サイトに出した文。`;
const BACKUP_NAME = "N0000ZX.txt";
const OPEN_CHAT_PRESS = "Control+Alt+Shift+KeyC";

function localEpisode(n: number): string {
  return [SEP(n), "【エピソードタイトル】", `${n}話　${TITLES[n - 1]}`, "", "【本文】", LOCAL_BODY(n), ""].join("\n");
}

/** なろうのバックアップ（ZIP を展開した合本の .txt）。題を見本の作品と同じにして、題で当てる */
function narouBackup(): string {
  const lines = ["【Nコード】", "N0000ZX", "", "【タイトル】", E2E_WORK_TITLE, ""];
  TITLES.forEach((title, index) => {
    const n = index + 1;
    lines.push(SEP(n), "【エピソードタイトル】", `${wide(n)}話　${title}`, "", "【本文】", BACKUP_BODY(n), "");
  });
  return lines.join("\n");
}

const BACKUP_EPISODES = TITLES.map((_, index) => ({ name: `episode_000${index + 1}.txt`, text: localEpisode(index + 1) }));

/** 相談画面の面（`#context-what` を持つ）のうち、`id` の要素を持つもの */
async function chatFrameWith(page: Page, id: string): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const found = await frame.evaluate((want) => document.getElementById("context-what") !== null && document.getElementById(want) !== null, id).catch(() => false);
    if (found) return frame;
  }
  return undefined;
}

/** 横の相談パネルを開いて［メインに表示］を押し、大きい相談画面の面を返す（落とす的を広くするため） */
async function openLargeChat(page: Page): Promise<Frame> {
  await pressWorkbenchKey(page, OPEN_CHAT_PRESS);
  await waitUntil(
    async () => {
      const side = await chatFrameWith(page, "to-main");
      if (!side) return false;
      await side.locator("#to-main").click();
      return true;
    },
    "横の相談パネルが開いて［メインに表示］を押せる",
    30_000
  );
  await waitUntil(async () => (await chatFrameWith(page, "to-sub")) !== undefined, "大きい相談画面が開く", 30_000);
  return (await chatFrameWith(page, "to-sub")) as Frame;
}

/** WebView の外側の枠の CDP の口から、ファイルを落とす便（入る → 上を動く → 落とす）を Shift つきで送る */
async function dropFileIntoChat(session: E2ESession, chat: Frame, file: string): Promise<void> {
  const outer = chat.parentFrame();
  if (!outer) throw new Error("WebView の外側の枠が見つかりません");
  const box = await (await outer.frameElement()).boundingBox();
  if (!box) throw new Error("WebView の枠の大きさが取れません");
  const cdp = await session.app.context().newCDPSession(outer);
  const data = { items: [], files: [file], dragOperationsMask: 1 | 2 | 16 };
  try {
    for (const type of ["dragEnter", "dragOver", "drop"] as const) {
      await cdp.send("Input.dispatchDragEvent", { type, x: box.width / 2, y: box.height / 2, data, modifiers: 8 });
    }
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

test("相談画面へ落としたバックアップとの違いの行は［バックアップを採る］［見送る］で、採ると［手元の文に戻す］になり、見送った行からはボタンが消える", async () => {
  await withVsCode(
    "バックアップとの違いのボタン",
    BACKUP_EPISODES,
    async (session) => {
      const { page } = session;
      const chat = await openLargeChat(page);
      await dropFileIntoChat(session, chat, path.join(path.dirname(session.workFolder), BACKUP_NAME));

      // 題で当たり、取り込むかを訊かれる
      let ask = "";
      await waitUntil(async () => (ask = (await dialogText(page)) ?? "").includes("取り込みますか"), "落としたバックアップが作品に当たり、取り込みの確認が出る", 30_000).catch(
        async (error: unknown) => {
          const log = await chat.evaluate(() => document.getElementById("log")?.innerText ?? "").catch(() => "");
          throw new Error(`${String(error)}（いまの窓：${JSON.stringify(ask)}／相談画面の末尾：${JSON.stringify(log.slice(-300))}）${await quickInputWaitContext(page)}`);
        }
      );
      expect(ask, `取り込みの確認：${ask}`).toContain(E2E_WORK_TITLE);
      await pressDialogButton(page, "取り込む");

      // 分類が1つだけのときはタブが出ず、見出しがその分類になる
      const proposals = await openProposals(
        page,
        async (frame) => ((await frame.locator("#category").innerText().catch(() => "")) ?? "").trim() === BACKUP_DIFF_RECORD_KIND,
        "提案パネルの見出しが「バックアップとの違い」になる"
      );
      const blocks = proposals.locator("#list .issue.block");
      await waitUntil(async () => (await blocks.count()) === 2, "違いの行が2つ（各話1か所）並ぶ", 10_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（一覧：${JSON.stringify((await proposals.locator("#list").innerText().catch(() => "")).slice(0, 600))}）`);
      });
      for (const index of [0, 1]) {
        const labels = (await blocks.nth(index).locator("button").allInnerTexts()).map((text) => text.trim());
        expect(labels, `違いの行 ${index + 1} のボタン`).toEqual(["バックアップを採る", "見送る"]);
      }

      /* ── 1つ目を採る → ［手元の文に戻す］ ── */
      const first = proposals.locator("#list .issue.block", { hasText: TITLES[0] }).first();
      await first.locator('button[data-action="apply"]').click();
      await waitUntil(async () => (await fileText(session, "episode_0001.txt")).includes(BACKUP_BODY(1)), "［バックアップを採る］で第1話のファイルがバックアップの文になる", 15_000);
      await waitUntil(async () => JSON.stringify((await first.locator("button").allInnerTexts()).map((text) => text.trim())) === JSON.stringify(["手元の文に戻す"]), "採ったあとの行は［手元の文に戻す］だけになる", 10_000).catch(
        async (error: unknown) => {
          throw new Error(`${String(error)}（行：${JSON.stringify(await first.innerText().catch(() => ""))}）`);
        }
      );
      expect(await first.innerText()).toContain("バックアップを採りました");

      /* ── 2つ目を見送る → ボタンが消え、本文はそのまま ── */
      const second = proposals.locator("#list .issue.block", { hasText: TITLES[1] }).first();
      await second.locator('button[data-action="dismiss"]').click();
      await waitUntil(async () => (await second.locator("button").count()) === 0, "見送った行からボタンが消える", 10_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}（行：${JSON.stringify(await second.innerText().catch(() => ""))}）`);
      });
      expect(await fileText(session, "episode_0002.txt")).toContain(LOCAL_BODY(2));
    },
    {
      keybindings: [
        { key: OPEN_PROPOSALS_KEY, command: "novelai.openProposals" },
        { key: "ctrl+alt+shift+c", command: "novelai.openChat" },
      ],
      // 書庫の直下（作品の外）に置く。作品の中に置くと、本文の一部と見なされうる
      prepareWork: async ({ workFolder }) => {
        await writeFile(path.join(workFolder, "..", BACKUP_NAME), narouBackup(), "utf8");
      },
    }
  );
}, 240_000);

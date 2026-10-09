/**
 * 提案パネルを狭くしたとき、分類のタブと文が右で切れずに折り返す（画面の自動テスト、設計書6.113）。
 *
 * 実機確認リスト 4544 行の写真（2026-10-09）：窓を狭くすると、分類のタブ
 * （誤字脱字・推敲・矛盾）の3つ目「矛盾」が右端で切れ、下の文（「確信度が低いものも
 * 表示」・指摘の説明）も右で切れていた。作者の裁定（2026-10-09）：**狭いときはタブを
 * 2段に折り返し、文も折り返して全部読めるようにする。広いときの見た目は変えない。**
 *
 * 確かめること：
 * - 狭い窓で、タブ・ツールバーの文・指摘の文のどれも、パネルの見える幅の右へはみ出さない
 *   （横へ送らないと読めない、が無い）
 * - 狭い窓で、タブは2段以上に折り返している
 * - 広い窓では、タブは1段のまま
 *
 * **AI は呼ばない。** 指摘は `.aiwriter/findings.jsonl` へ製品と同じ形で置く。
 */
import { appendFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import { expect, test } from "vitest";
import { openEpisode } from "./support/manuscriptFrame";
import {
  OPEN_PROPOSALS_LAUNCH,
  OPEN_PROPOSALS_PRESS,
  proposalPanelFrame,
  sampleFindingId,
  writeSampleFinding,
  type SampleFinding,
} from "./support/sampleFinding";
import { withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { clearNotifications } from "./support/workbenchDom";

const EPISODE = "001_駅.txt";
const TEXT = [
  "　終電を逃した駅のホームに、雨の音だけが残っていた。",
  "　近づいてみると、男は以外にも若かった。",
  "　ホームの時計が、零時を指していた。",
  "",
].join("\n");

/** 3つの分類（誤字脱字・推敲・矛盾）に1件ずつ。写真と同じ3つのタブが並ぶ */
const SAMPLES: SampleFinding[] = [
  {
    episode: EPISODE,
    text: TEXT,
    original: "男は以外にも若かった。",
    target: "以外",
    suggestion: "意外",
    message: "「思いのほか」の意味なら「意外」です（誤字脱字の見本。説明が長いと右で切れるかを見るため、少し長めに書いています）",
  },
  {
    episode: EPISODE,
    text: TEXT,
    original: "雨の音だけが残っていた。",
    target: "雨の音だけが残っていた",
    suggestion: "雨音だけが残っていた",
    message: "少し締まります",
    category: "proofread",
    label: "推敲",
  },
  {
    episode: EPISODE,
    text: TEXT,
    original: "零時を指していた。",
    target: "零時",
    suggestion: "",
    message: "前の話では終電は零時半でした",
    category: "contradiction",
    label: "矛盾",
  },
];

/** 2件目からは足す（`writeSampleFinding` は1件で置き直すため） */
async function placeFindings(workFolder: string): Promise<void> {
  await writeSampleFinding(workFolder, SAMPLES[0]);
  for (const sample of SAMPLES.slice(1)) {
    const at = sample.text.indexOf(sample.original);
    const line = JSON.stringify({
      kind: "finding",
      id: sampleFindingId(sample),
      time: new Date().toISOString(),
      file: `本文/${sample.episode}`,
      hintLine: sample.text.slice(0, at).split("\n").length,
      original: sample.original,
      target: sample.target,
      suggestion: sample.suggestion,
      before: sample.text.slice(Math.max(0, at - 12), at),
      after: sample.text.slice(at + sample.original.length, at + sample.original.length + 12),
      message: sample.message,
      category: sample.category,
      label: sample.label,
    });
    await appendFile(path.join(workFolder, ".aiwriter", "findings.jsonl"), line + "\n", "utf8");
  }
}

interface Measure {
  /** パネルが窓の中で実際に見えている幅（本体の側で測る） */
  width: number;
  /** パネル自身が思っている幅（WebView の中の幅） */
  frameWidth: number;
  /** 文書の横の広さ（見える幅より広ければ、横へ送らないと読めない） */
  scrollWidth: number;
  /** 見える幅の右へはみ出した要素（名前と右端） */
  overflowing: string[];
  /** タブの段の数 */
  tabRows: number;
  tabCount: number;
  /** パネルが本文の幅を詰めたか（空なら詰めていない） */
  bodyMaxWidth: string;
  /** 本文（body）の左端・右端。VS Code は WebView の body に左右の余白を入れることがある */
  bodyLeft: number;
  bodyRight: number;
  /** 本文の中で、いちばん右へ出た要素の右端 */
  widestRight: number;
}

/**
 * パネルが窓の中で見えている幅。
 *
 * **WebView の中の幅では測れない。** VS Code の編集の列には最小の幅（220px）があり、
 * 窓が狭いと右の列が窓の外へはみ出して切り落とされる（写真の原因）。WebView の中からは
 * 220px に見えたままなので、本体の側で「窓の右端 − 右の列の左端」を測る。
 */
async function visibleWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll(".editor-group-container"));
    const right = groups
      .map((group) => group.getBoundingClientRect())
      .sort((a, b) => b.left - a.left)[0];
    if (!right) return 0;
    return Math.min(right.width, window.innerWidth - right.left);
  });
}

async function measure(page: Page, frame: Frame): Promise<Measure> {
  const width = await visibleWidth(page);
  const inside = await frame.evaluate((width) => {
    const overflowing: string[] = [];
    const targets = document.querySelectorAll(
      "#tabs .tab, #toolbar > *, #toolbar label, .issue .reason, .issue .diff, .issue-head, .issue .actions button"
    );
    targets.forEach((element) => {
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) return;
      if (box.right > width + 1) {
        overflowing.push(`${element.tagName.toLowerCase()}#${element.id}.${element.className}「${(element.textContent ?? "").slice(0, 12)}」右端${Math.round(box.right)}`);
      }
    });
    const tabs = Array.from(document.querySelectorAll("#tabs .tab"));
    const rows = new Set(tabs.map((tab) => Math.round(tab.getBoundingClientRect().top)));
    return {
      frameWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflowing,
      tabRows: rows.size,
      tabCount: tabs.length,
      bodyMaxWidth: document.body.style.maxWidth,
      bodyLeft: Math.round(document.body.getBoundingClientRect().left),
      bodyRight: Math.round(document.body.getBoundingClientRect().right),
      // 本文の中の、いちばん右へ出た要素の右端（上の名指しの要素に限らない）
      widestRight: Math.round(
        Array.from(document.body.querySelectorAll("*")).reduce((most, element) => {
          const box = element.getBoundingClientRect();
          if (box.width === 0 && box.height === 0) return most;
          // 見えている幅を測る目印（visibleWidthScript.ts。窓いっぱいの見えない帯）は数えない
          if (getComputedStyle(element).position === "fixed") return most;
          return Math.max(most, box.right);
        }, 0)
      ),
    };
  }, width);
  return { width, ...inside };
}

async function openProposals(page: Page): Promise<Frame> {
  await clearNotifications(page);
  await page.keyboard.press(OPEN_PROPOSALS_PRESS);
  let proposals: Frame | undefined;
  await waitUntil(
    async () => {
      proposals = await proposalPanelFrame(page);
      return proposals !== undefined && (await proposals.locator("#tabs .tab").count()) >= 3;
    },
    "提案パネルに分類のタブが3つ並ぶ",
    15_000
  );
  if (!proposals) throw new Error("提案パネルが見つかりません");
  return proposals;
}

test("狭い窓で、提案パネルのタブと文は右で切れずに折り返す", async () => {
  await withVsCode(
    "提案パネル・狭い",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await placeFindings(session.workFolder);
      await openEpisode(page, EPISODE, "零時を指していた");
      const proposals = await openProposals(page);

      // 窓の大きさが落ち着き、パネルが見える幅へ詰め終わるのを待つ。
      // 詰めないまま（直す前）なら時間切れで、最後に測った値で下の言明が落ちる
      let last: Measure | undefined;
      await waitUntil(
        async () => {
          last = await measure(page, proposals);
          return last.tabCount >= 3 && last.width > 0 && last.overflowing.length === 0;
        },
        "提案パネルの中身が、窓の中で見えている幅に収まる",
        10_000
      ).catch(() => undefined);
      const result = last as Measure;
      const detail =
        `見える幅 ${result.width}px／パネルの幅 ${result.frameWidth}px／` +
        `本文の左端 ${result.bodyLeft}px・右端 ${result.bodyRight}px／いちばん右の要素 ${result.widestRight}px`;

      // 写真と同じ形：パネルの右端が窓の外へ出て、見える幅が WebView の幅より狭い
      expect(result.width, `写真と同じ形になっていません（${detail}）`).toBeLessThan(result.frameWidth);
      expect(result.overflowing, `見える幅の右へはみ出した要素があります（${detail}）`).toEqual([]);
      expect(result.scrollWidth, `パネルを横へ送らないと読めません（${detail}）`).toBeLessThanOrEqual(
        result.frameWidth + 1
      );
      expect(result.tabRows, `狭いのにタブが1段のままです（${detail}）`).toBeGreaterThanOrEqual(2);
      // 本文の右端も、中のどの要素も、見える幅の中に収まる。本文の左に余白があるとき、
      // 見える幅をそのまま最大幅にすると、余白のぶん右へ出る（原稿エディターで起きた）
      expect(result.bodyRight, `本文の右端が見える幅の外へ出ています（${detail}）`).toBeLessThanOrEqual(
        result.width + 1
      );
      expect(result.widestRight, `見える幅の外へ出た要素があります（${detail}）`).toBeLessThanOrEqual(
        result.width + 1
      );
    },
    { ...OPEN_PROPOSALS_LAUNCH, windowSize: { width: 640, height: 800 } }
  );
});

test("広い窓では、提案パネルのタブは1段のまま", async () => {
  await withVsCode(
    "提案パネル・広い",
    [{ name: EPISODE, text: TEXT }],
    async (session) => {
      const { page } = session;
      await placeFindings(session.workFolder);
      await openEpisode(page, EPISODE, "零時を指していた");
      const proposals = await openProposals(page);
      const result = await measure(page, proposals);

      expect(result.width, "パネルが広くなっていません").toBeGreaterThan(420);
      expect(result.tabRows).toBe(1);
      expect(result.overflowing).toEqual([]);
      // 切れていないときは、本文の幅に手を付けない（広いときの見た目を変えない）
      expect(result.bodyMaxWidth).toBe("");
    },
    { ...OPEN_PROPOSALS_LAUNCH, windowSize: { width: 1600, height: 900 } }
  );
});

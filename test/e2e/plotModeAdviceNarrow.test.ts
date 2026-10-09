/**
 * プロットモードの「AIと相談しながら組み立てる」の入力の段が、狭い列で崩れない
 * （画面の自動テスト、設計書6.113。実機確認リスト 545〜566 の写真、2026-10-09）。
 *
 * 写真：plot.md・プロットモード・提案パネルを3列に並べると、プロットモードの列が約310pxになり、
 * 入力の段の［止める］［会話を消す］が1字ずつ縦に折れ、入力欄も潰れていた。段が横1列（flex）で
 * 折り返さず、ボタンも縮められていたため。
 *
 * **窓の端で切られているのではない**（列そのものが狭い）ので、見えている幅を測る部品
 * （`views/visibleWidthScript.ts`）は使わない。狭い列では入力欄を1段目に、ボタンを2段目に
 * 折り返す。
 *
 * 確かめること：狭い列で、入力の段のボタンの字はどれも1行に収まり、入力欄は字が打てる幅を保つ。
 *
 * **AI は呼ばない。** 段を出すだけで送らない（偽の Ollama を既定のAIに立てるだけ）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { fakeOllamaLaunch, startFakeOllama, type FakeOllama } from "./support/fakeOllama";
import { SIDEBAR_LAUNCH } from "./support/sidebar";
import { withVsCode } from "./support/vscodeApp";
import { waitUntil } from "./support/wait";
import { openPlotMode } from "./look/nameLookSupport";

let fake: FakeOllama;
beforeAll(async () => {
  fake = await startFakeOllama(() => "了解しました。");
});
afterAll(async () => {
  await fake.close();
});

interface FormMeasure {
  /** プロットモードの面の幅（WebView の中の幅） */
  frameWidth: number;
  /** 入力欄の幅 */
  inputWidth: number;
  /** ボタンごとの「字が並んだ行の数」 */
  buttonLines: Record<string, number>;
}

test("狭い列でも、相談の入力の段のボタンは1行のまま、入力欄は潰れない", async () => {
  await withVsCode(
    "プロットモード・相談の段・狭い",
    [{ name: "第1話_はじまり.txt", text: "一話の本文。\n" }],
    async (session) => {
      const plot = await openPlotMode(session);
      await waitUntil(async () => await plot.locator("#adviceForm").isVisible(), "相談の入力の段が出る", 30_000);
      await session.page.waitForTimeout(800);

      const result: FormMeasure = await plot.evaluate(() => {
        const lines = (element: Element): number => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return new Set(
            Array.from(range.getClientRects())
              .filter((rect) => rect.width > 0)
              .map((rect) => Math.round(rect.top))
          ).size;
        };
        const buttonLines: Record<string, number> = {};
        document.querySelectorAll("#adviceForm button").forEach((button) => {
          buttonLines[(button.textContent ?? "").trim()] = lines(button);
        });
        return {
          frameWidth: document.documentElement.clientWidth,
          inputWidth: (document.getElementById("adviceInput") as HTMLElement).getBoundingClientRect().width,
          buttonLines,
        };
      });
      const detail = `面の幅 ${result.frameWidth}px／入力欄 ${Math.round(result.inputWidth)}px／${JSON.stringify(result.buttonLines)}`;

      // 写真と同じ形：列が狭い（3つの列に並べたときと同じくらい）
      expect(result.frameWidth, `列が広すぎて写真と同じ形になっていません（${detail}）`).toBeLessThan(360);
      for (const [label, count] of Object.entries(result.buttonLines)) {
        expect(count, `［${label}］の字が縦に折れています（${detail}）`).toBe(1);
      }
      // 例文（「例：主人公をどう動かすか迷っています」）の頭が読め、打った字が見える幅
      expect(result.inputWidth, `入力欄が潰れています（${detail}）`).toBeGreaterThanOrEqual(160);
    },
    fakeOllamaLaunch(fake, {
      ...SIDEBAR_LAUNCH,
      windowSize: { width: 960, height: 800 },
      settings: {
        ...SIDEBAR_LAUNCH.settings,
        "workbench.editorAssociations": { "*.txt": "novelai.manuscriptEditorHorizontal", "*.md": "default" },
      },
      prepareWork: async ({ workFolder }) => {
        await mkdir(path.join(workFolder, "設定"), { recursive: true });
        await writeFile(path.join(workFolder, "設定", "plot.md"), "# 見本の物語\n\n## 主要登場人物\n- 主人公：高校生。\n", "utf8");
      },
    })
  );
});

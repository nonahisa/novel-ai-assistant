import { afterEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { deviationPrompt } from "../../src/mcp/tools/episode";
import { PLOT_MAX_CHARS } from "../../src/core/plotForDeviation";

/**
 * 外から呼ぶ逸脱検知（P-11）も、プロットを製品と同じところで切るか
 * （設計書6.87.8、0.66.4）。
 *
 * **MCP で測って見つけた穴**（2026-09-17）。製品（`features/checkDeviations.ts`）
 * は 30,000字で切って「先頭 N字だけを使いました」と断るのに、MCP の道具は
 * `readPlotMarkdown` の全文をそのまま渡していた。76,471字のプロットでも
 * 切らず、知らせもしない。**製品の経路を迂回した測定は、製品に無い不具合を
 * 見つけたことになる**（CLAUDE.md の「繰り返し起きた失敗」5番）。
 *
 * ここで見るのは3つ。**切ること**・**切ったと言うこと**・**普通の長さの
 * プロットでは何も変わらないこと**。
 */

const FIXTURE = nodePath.join(__dirname, "..", "fixtures", "mcp-work");
const EPISODE = "本文/004_よあけ.txt";

const temporary: string[] = [];

/**
 * 作り物の作品を一時フォルダーへ写して、プロットだけ差し替える。
 *
 * **fixture そのものへは書かない。** 走らせるたびにリポジトリの
 * プロットが巨大になってしまう。
 */
function workWithPlot(plot: string): string {
  const folder = fs.mkdtempSync(
    nodePath.join(os.tmpdir(), "novelai-mcp-plot-trim-")
  );
  fs.cpSync(FIXTURE, folder, { recursive: true });
  fs.writeFileSync(nodePath.join(folder, "設定", "plot.md"), plot, "utf8");
  temporary.push(folder);
  return folder;
}

/** 行の区切りを含む、それらしいプロット（切り方が行境界であることを見る） */
function plotOfChars(chars: number): string {
  const line = "主人公が港へ向かい、防波堤の先で便りを読む。";
  const lines: string[] = [];
  let total = 0;
  while (total < chars) {
    lines.push(`${lines.length + 1}．${line}`);
    // 改行のぶんも数える
    total = lines.join("\n").length;
  }
  return lines.join("\n");
}

afterEach(() => {
  while (temporary.length > 0) {
    const folder = temporary.pop();
    if (folder) fs.rmSync(folder, { recursive: true, force: true });
  }
});

describe("episode.deviationPrompt のプロットの切り詰め", () => {
  test("35,000字のプロットは上限で切られ、切ったと言う", () => {
    const plot = plotOfChars(35_000);
    expect(plot.length).toBeGreaterThan(PLOT_MAX_CHARS);

    const result = deviationPrompt({
      folder: workWithPlot(plot),
      filePath: EPISODE,
    });

    expect(result.plotTrimmed).toBe(true);
    expect(result.plotChars).toBe(plot.length);
    // 行境界まで戻すので、上限ちょうどとは限らない。**超えないこと**が要点
    expect(result.usedPlotChars).toBeLessThanOrEqual(PLOT_MAX_CHARS);
    // 戻しすぎていない（1行ぶん以上は削らない）
    expect(result.usedPlotChars).toBeGreaterThan(PLOT_MAX_CHARS - 100);
    expect(result.note).toContain("先頭");
    expect(result.note).toContain(
      result.usedPlotChars.toLocaleString("ja-JP")
    );
  });

  test("切ったあとのプロットしかプロンプトに入らない", () => {
    const plot = plotOfChars(35_000);
    const result = deviationPrompt({
      folder: workWithPlot(plot),
      filePath: EPISODE,
    });

    // **末尾を送っていない。** プロットの最後の行がプロンプトに無いこと
    const lastLine = plot.slice(plot.lastIndexOf("\n") + 1);
    expect(result.userPrompt).not.toContain(lastLine);
    // 先頭は送っている（照らし合わせる相手が消えていない）
    expect(result.userPrompt).toContain(plot.slice(0, 200));
    // プロンプト全体でも、プロット全文ぶんの長さには届かない
    expect(result.userPrompt.length).toBeLessThan(plot.length);
  });

  test("普通の長さのプロットでは、切らず、何も断らない", () => {
    // fixture のプロット（数百字）をそのまま使う
    const result = deviationPrompt({ folder: FIXTURE, filePath: EPISODE });

    expect(result.plotTrimmed).toBe(false);
    expect(result.usedPlotChars).toBe(result.plotChars);
    expect(result.note).toBeUndefined();
    // 全文が入っている（1バイトも変えない）
    const plot = fs.readFileSync(
      nodePath.join(FIXTURE, "設定", "plot.md"),
      "utf8"
    );
    expect(result.userPrompt).toContain(plot.trim());
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { describe, expect, test } from "vitest";
import { novelPrompt, novelRun } from "../../../src/mcp/tools/features";
import {
  McpToolError,
  mcpToolErrorDetail,
} from "../../../src/mcp/tools/shared";
import {
  PREREQUISITE_KINDS,
  prerequisiteNextStep,
} from "../../../src/core/featurePrerequisites";
import { prerequisiteInfo } from "../../../src/core/prerequisites";
import { buildEpisodePlotTemplate } from "../../../src/core/resumeSheet";

/**
 * 前提が欠けて断るとき、**次の一手を1つ**添える（2026-10-01、
 * 測定記録 `2026-10-01-sonnet-as-internal-ai.md` の不具合17）。
 *
 * deviation と episodePlot は前提不足で正しく断られたが、断りの文から
 * 次の一手（プロット逆算を先にやる、など）へ繋ぐ案内が無かった。
 * CLAUDE.md の実装ルール5「種別ごとに次の操作を1つ示す」に合わせる。
 *
 * 見るのは3つ。①断りの文に「次にやること」が1行入る ②同じものが
 * 機械の読める形（`nextStep`）でも返る ③**外部AIに原稿や資料を
 * 書かせる案内にならない**（作者が行う・作者が承認する、と書く。6.87.7）
 */

const FIXTURE = nodePath.join(__dirname, "..", "..", "fixtures", "mcp-work");
const NUM_CTX = 32768;

/** 本文だけの作品。`extra` で前提を足す */
function withWork(
  extra: (folder: string) => void,
  run: (folder: string) => void | Promise<void>
): Promise<void> {
  const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "novelai-nextstep-"));
  const body = nodePath.join(tmp, "本文");
  fs.mkdirSync(body);
  fs.writeFileSync(
    nodePath.join(body, "001_はじまり.txt"),
    "少年は防波堤に立っていた。海はしずかだった。\n",
    "utf8"
  );
  extra(tmp);
  return Promise.resolve(run(tmp)).finally(() =>
    fs.rmSync(tmp, { recursive: true, force: true })
  );
}

function withSynopses(folder: string): void {
  const settings = nodePath.join(folder, "設定");
  fs.mkdirSync(settings, { recursive: true });
  fs.copyFileSync(
    nodePath.join(FIXTURE, "設定", "chapter_synopses.json"),
    nodePath.join(settings, "chapter_synopses.json")
  );
}

/** 断られることを確かめ、その例外を返す */
function refusalOf(call: () => unknown): McpToolError {
  try {
    call();
  } catch (error) {
    if (error instanceof McpToolError) return error;
    throw error;
  }
  throw new Error("断られなかった");
}

interface NextStepDetail {
  nextStep?: { prerequisite?: string; feature?: string; action?: string };
}

function detailOf(error: McpToolError): NextStepDetail {
  const text = mcpToolErrorDetail(error);
  expect(text).toBeDefined();
  return JSON.parse(text ?? "{}") as NextStepDetail;
}

describe("断りの文に、次の一手が1つ入る", () => {
  test("プロットが無く、あらすじはある → プロット逆算で下書き、置くのは作者の承認後", async () => {
    await withWork(withSynopses, (folder) => {
      const error = refusalOf(() =>
        novelPrompt({
          folder,
          feature: "deviation",
          filePath: "本文/001_はじまり.txt",
        })
      );
      expect(error.message).toContain("次にやること");
      expect(error.message).toContain("feature: plotReverse");
      expect(error.message).toContain("作者が承認");

      const detail = detailOf(error);
      expect(detail.nextStep?.prerequisite).toBe("plot");
      expect(detail.nextStep?.feature).toBe("plotReverse");
      expect(detail.nextStep?.action).toContain("作者が承認");
    });
  });

  test("プロットもあらすじも無い → 呼べないプロット逆算は勧めず、作者の操作を示す", async () => {
    await withWork(
      () => undefined,
      (folder) => {
        const error = refusalOf(() =>
          novelPrompt({
            folder,
            feature: "deviation",
            filePath: "本文/001_はじまり.txt",
          })
        );
        expect(error.message).toContain("次にやること");
        // 前提の足りないプロット逆算を勧めると、呼んだ先でまた断られる
        const detail = detailOf(error);
        expect(detail.nextStep?.feature).toBeUndefined();
        expect(detail.nextStep?.action).toContain("「プロット自力作成」");
        expect(detail.nextStep?.action).toContain("作者");
      }
    );
  });

  test("単話プロットが1つも無い → 作者が単話プロット作成で作る", async () => {
    await withWork(
      () => undefined,
      (folder) => {
        const error = refusalOf(() =>
          novelPrompt({
            folder,
            feature: "episodePlot",
            options: { plotPath: "設定/episode-plots/第1話.md" },
          })
        );
        expect(error.message).toContain("次にやること");
        const detail = detailOf(error);
        expect(detail.nextStep?.prerequisite).toBe("episodePlot");
        expect(detail.nextStep?.feature).toBeUndefined();
        expect(detail.nextStep?.action).toContain("「単話プロット作成」");
      }
    );
  });

  test("単話プロットがひな形のまま → 同じく次の一手が入る", async () => {
    await withWork(
      (folder) => {
        const directory = nodePath.join(folder, "設定", "episode-plots");
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(
          nodePath.join(directory, "第1話.md"),
          buildEpisodePlotTemplate(1),
          "utf8"
        );
      },
      (folder) => {
        const error = refusalOf(() =>
          novelPrompt({
            folder,
            feature: "episodePlot",
            options: { plotPath: "設定/episode-plots/第1話.md" },
          })
        );
        expect(error.message).toMatch(/ひな形のまま/);
        expect(error.message).toContain("次にやること");
        expect(detailOf(error).nextStep?.prerequisite).toBe("episodePlot");
      }
    );
  });

  test("ほかの話は書けていて、選んだ話だけひな形のまま → その話の断りにも次の一手", async () => {
    await withWork(
      (folder) => {
        const directory = nodePath.join(folder, "設定", "episode-plots");
        fs.mkdirSync(directory, { recursive: true });
        fs.copyFileSync(
          nodePath.join(FIXTURE, "設定", "episode-plots", "001_第1話.md"),
          nodePath.join(directory, "001_第1話.md")
        );
        fs.writeFileSync(
          nodePath.join(directory, "第2話.md"),
          buildEpisodePlotTemplate(2),
          "utf8"
        );
      },
      (folder) => {
        const error = refusalOf(() =>
          novelPrompt({
            folder,
            feature: "episodePlot",
            options: { plotPath: "設定/episode-plots/第2話.md" },
          })
        );
        expect(error.message).toContain("この単話プロットは");
        expect(error.message).toContain("次にやること");
        expect(detailOf(error).nextStep?.prerequisite).toBe("episodePlot");
      }
    );
  });

  test("設定資料が無い → 作者の一括抽出。代わりの道は別に残る", async () => {
    await withWork(
      () => undefined,
      (folder) => {
        const error = refusalOf(() =>
          novelPrompt({
            folder,
            feature: "contradiction",
            filePath: "本文/001_はじまり.txt",
            numCtx: NUM_CTX,
          })
        );
        expect(error.message).toContain("次にやること");
        expect(error.message).toContain("feature: factContradiction");
        const detail = detailOf(error) as NextStepDetail & {
          alternative?: { feature?: string };
        };
        expect(detail.nextStep?.action).toContain("「一括抽出」");
        expect(detail.alternative?.feature).toBe("factContradiction");
      }
    );
  });

  test("novel.run でも同じ次の一手が返る", async () => {
    await withWork(withSynopses, async (folder) => {
      let caught: unknown;
      try {
        await novelRun({
          folder,
          feature: "deviation",
          filePath: "本文/001_はじまり.txt",
          runner: "ollama",
          model: "gemma4:e4b",
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(McpToolError);
      const detail = detailOf(caught as McpToolError);
      expect(detail.nextStep?.feature).toBe("plotReverse");
    });
  });
});

describe("次の一手は、外部AIに作品を書かせない", () => {
  test("4種類とも「作者」が行う・承認すると書き、強調の記号を使わない", () => {
    for (const kind of PREREQUISITE_KINDS) {
      // 下書きを作れる道が開いているときと、閉じているときの両方
      for (const present of [[], PREREQUISITE_KINDS]) {
        const step = prerequisiteNextStep(kind, present);
        expect(step.prerequisite).toBe(kind);
        expect(step.action).toContain("作者");
        // 作る操作の名前は表から引く（写しを作らない）
        expect(step.action).toContain(`「${prerequisiteInfo(kind).makeLabel}」`);
        expect(step.action).not.toContain("**");
      }
    }
  });

  test("下書きを作る feature は、その前提が揃っているときだけ勧める", () => {
    expect(prerequisiteNextStep("plot", ["synopsis"]).feature).toBe(
      "plotReverse"
    );
    expect(prerequisiteNextStep("plot", []).feature).toBeUndefined();
    // 作者の画面の操作しか無いもの
    expect(prerequisiteNextStep("episodePlot", PREREQUISITE_KINDS).feature)
      .toBeUndefined();
  });
});

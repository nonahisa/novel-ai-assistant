import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  novelPrompt,
  novelRun,
  novelValidate,
} from "../../../src/mcp/tools/features";
import { validateWith } from "../../../src/mcp/tools/run";
import {
  EPISODE_PLOT_CONTRAST_SCHEMA,
  EPISODE_PLOT_CONTRAST_SYSTEM_PROMPT,
  EPISODE_PLOT_CONTRAST_TEMPERATURE,
  EPISODE_PLOT_CONTRAST_VERSION,
  buildEpisodePlotContrastPrompt,
  episodePlotContrastBudget,
} from "../../../src/prompts/episodePlotContrast";
import { parseEpisodePlot } from "../../../src/core/episodePlotDoc";
import { blankMemoLines } from "../../../src/core/sceneMemo";
import { hashText } from "../../../src/core/hash";
import { featureNeeds } from "../../../src/core/featurePrerequisites";
import {
  FEATURE_LABELS,
  FEATURE_NAMES,
} from "../../../src/core/mcpFeatures";
import { permissionKeyOf } from "../../../src/core/externalAccessPermission";

/**
 * 単話プロットと本文の照合（P-28）を外から呼ぶ（2026-10-10）。
 *
 * 実機確認の「本文と照合」（主筋の改変・出来事の欠落）を MCP から測るための道。
 * **製品と同じプロンプトを組み、製品と同じ検算を通す**ことを見張る——迂回すると、
 * 製品に無い不具合を見つけたことになる（CLAUDE.md の繰り返し起きた失敗5）。
 *
 * 作り物の作品を一時フォルダーへ作る（`test/fixtures/` は触らない）。
 * 箇条書きは4行。本文では、2行目の「依頼を引き受ける」を**断る**に変え（改変）、
 * 4行目の「師匠の手紙が届く」を**書かない**（欠落）。
 */

const PLOT = [
  "## 視点",
  "リオの視点",
  "",
  "## この話の目標",
  "リオが旅立ちを決める",
  "",
  "## 展開（箇条書き）",
  "- リオが港で老船長に声をかけられる",
  "- リオが沖の島へ渡る依頼を引き受ける",
  "- 二人で嵐の前に船を出す",
  "- 師匠の手紙が届く",
].join("\n");

const BODY = [
  "港の朝は早かった。",
  "「おい、坊主」と老船長がリオに声をかけた。",
  "// メモ：ここで潮の匂いを足す",
  "「沖の島まで渡してほしい。手を貸してくれ」",
  "リオは首を横に振った。「悪いけど、その頼みは断るよ」",
  "それでも二人は、嵐の前に船を出した。",
  "",
].join("\n");

const BODY_PATH = "本文/003_しおかぜ.txt";
const PLOT_PATH = "設定/episode-plots/第3話.md";

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeWork(plot = PLOT): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "novelai-mcp-contrast-"));
  made.push(folder);
  fs.mkdirSync(path.join(folder, "本文"), { recursive: true });
  fs.mkdirSync(path.join(folder, "設定", "episode-plots"), { recursive: true });
  fs.writeFileSync(path.join(folder, BODY_PATH), BODY, "utf8");
  fs.writeFileSync(path.join(folder, PLOT_PATH), plot, "utf8");
  return folder;
}

function call(folder: string, extra: Record<string, unknown> = {}) {
  return {
    folder,
    feature: "episodePlotContrast" as const,
    filePath: BODY_PATH,
    options: { plotPath: PLOT_PATH },
    ...extra,
  };
}

describe("feature: episodePlotContrast の配線", () => {
  it("外から呼べる機能に並び、許可の鍵は feature の名前そのもの", () => {
    expect(FEATURE_NAMES).toContain("episodePlotContrast");
    expect(FEATURE_LABELS.episodePlotContrast).toBe("単話プロットと本文の照合");
    // 許可は接続元ごと・機能ごと。ほかの feature と同じ決まりに乗る
    expect(permissionKeyOf("novel.run", "episodePlotContrast")).toBe(
      "episodePlotContrast"
    );
    expect(permissionKeyOf("novel.prompt", "episodePlotContrast")).toBe(
      "episodePlotContrast"
    );
  });

  it("前提は画面と同じ（単話プロットが要る）", () => {
    expect(featureNeeds("episodePlotContrast")).toEqual(["episodePlot"]);
  });

  it("足りない引数は名前を挙げて断る", () => {
    const folder = makeWork();
    expect(() =>
      novelPrompt({
        folder,
        feature: "episodePlotContrast",
        options: { plotPath: PLOT_PATH },
      })
    ).toThrow(/filePath/);
    expect(() =>
      novelPrompt({ folder, feature: "episodePlotContrast", filePath: BODY_PATH })
    ).toThrow(/options\.plotPath/);
  });
});

describe("novel.prompt（feature: episodePlotContrast）", () => {
  it("製品（contrastEpisodePlot）と同じ部品・同じ材料でプロンプトを組む", () => {
    const folder = makeWork();
    const result = novelPrompt(call(folder)) as Record<string, unknown>;

    // 製品の組み立て（`features/checkEpisodePlot.ts`）をここで写して比べる。
    // 本文はファイル丸ごとからシーンメモを空行にしたもの、件数は箇条書きの数から
    const doc = parseEpisodePlot(PLOT);
    const maxFindings = episodePlotContrastBudget(doc.items.length);
    const expected = buildEpisodePlotContrastPrompt({
      chapterLabel: "第3話",
      goal: doc.goal,
      items: doc.items.map((item) => item.text),
      chapterText: blankMemoLines(BODY),
      maxFindings,
    });

    expect(result.userPrompt).toBe(expected);
    expect(result.systemPrompt).toBe(EPISODE_PLOT_CONTRAST_SYSTEM_PROMPT);
    expect(result.schema).toBe(EPISODE_PLOT_CONTRAST_SCHEMA);
    expect(result.temperature).toBe(EPISODE_PLOT_CONTRAST_TEMPERATURE);
    expect(result.maxFindings).toBe(maxFindings);
    expect(result.itemCount).toBe(4);
    expect(result.chapterLabel).toBe("第3話");
    expect(result.validateWith).toBe(validateWith("episodePlotContrast"));
    // 版は製品のキャッシュの鍵と同じ組み立て（版＋単話プロットの指紋）
    expect(result.promptVersion).toBe(
      `${EPISODE_PLOT_CONTRAST_VERSION}:${hashText(PLOT).slice(0, 16)}`
    );
    // シーンメモは送らない（行は残す）
    expect(String(result.userPrompt)).not.toContain("潮の匂い");
    expect(result.bodyChars).toBe(blankMemoLines(BODY).length);
  });

  it("chapterLabel を渡せばその見出しで組む", () => {
    const folder = makeWork();
    const result = novelPrompt(
      call(folder, { options: { plotPath: PLOT_PATH, chapterLabel: "第三話 しおかぜ" } })
    ) as Record<string, unknown>;
    expect(result.chapterLabel).toBe("第三話 しおかぜ");
    expect(String(result.userPrompt)).toContain("小説の第三話 しおかぜについて");
  });

  it("展開の書かれていない単話プロットは、照合の名で断る", () => {
    const folder = makeWork(
      ["## 視点", "リオの視点", "", "## この話の目標", "旅立ち"].join("\n")
    );
    // 前提の関門は「置き場に1つも書けた単話プロットが無い」で先に断る
    expect(() => novelPrompt(call(folder))).toThrow(/episodePlotContrast/);
  });

  it("本文や単話プロットを書き換えない", () => {
    const folder = makeWork();
    novelPrompt(call(folder));
    novelValidate(call(folder, { response: JSON.stringify({ findings: [] }) }));
    expect(fs.readFileSync(path.join(folder, BODY_PATH), "utf8")).toBe(BODY);
    expect(fs.readFileSync(path.join(folder, PLOT_PATH), "utf8")).toBe(PLOT);
  });
});

describe("novel.validate（feature: episodePlotContrast）", () => {
  it("製品と同じ検算を通す：改変と欠落は残り、本文に無い引用は落ちる", () => {
    const folder = makeWork();
    const response = JSON.stringify({
      findings: [
        {
          kind: "主筋の改変",
          plotItem: "リオが沖の島へ渡る依頼を引き受ける",
          excerpt: "その頼みは断るよ",
          reason: "箇条書きでは引き受けるが、本文では断っており逆になっている",
        },
        {
          kind: "出来事の欠落",
          plotItem: "師匠の手紙が届く",
          excerpt: null,
          reason: "手紙が届く記述が本文にない",
        },
        {
          kind: "箇条書きに無い",
          plotItem: null,
          excerpt: "リオは灯台へ走った",
          reason: "灯台へ向かう場面は箇条書きのどの行にも当たらない",
        },
      ],
    });

    const result = novelValidate(call(folder, { response })) as {
      accepted: Array<{
        kind: string;
        plotItem: string | null;
        plotLine: number | null;
        excerpt: string | null;
        line: number | null;
      }>;
      rejected: Array<{ reason: string }>;
    };

    expect(result.accepted.map((item) => item.kind)).toEqual([
      "主筋の改変",
      "出来事の欠落",
    ]);
    // 引用の行は本文から機械的に求める（5行目。メモ行も行として数える）
    expect(result.accepted[0].line).toBe(5);
    expect(result.accepted[0].plotItem).toBe(
      "リオが沖の島へ渡る依頼を引き受ける"
    );
    expect(result.accepted[1].excerpt).toBeNull();
    expect(result.rejected.map((item) => item.reason)).toEqual([
      "excerpt_not_found",
    ]);
  });

  it("件数の上限は製品と同じ（箇条書きの数から）", () => {
    const folder = makeWork();
    const many = Array.from({ length: 6 }, (_, index) => ({
      kind: "出来事の欠落",
      plotItem: [
        "リオが港で老船長に声をかけられる",
        "リオが沖の島へ渡る依頼を引き受ける",
        "二人で嵐の前に船を出す",
        "師匠の手紙が届く",
      ][index % 4],
      excerpt: null,
      reason: `記述が本文にない（${index + 1}）`,
    }));
    const result = novelValidate(
      call(folder, { response: JSON.stringify({ findings: many }) })
    ) as { accepted: unknown[]; rejected: Array<{ reason: string }> };
    // 4行 → 上限3（`episodePlotContrastBudget`）。4件目は重なりでなく上限で落ちる
    expect(result.accepted).toHaveLength(episodePlotContrastBudget(4));
    expect(result.rejected.map((item) => item.reason)).toContain("over_budget");
  });

  it("読めない応答は断る（黙って0件にしない）", () => {
    const folder = makeWork();
    expect(() =>
      novelValidate(call(folder, { response: "照らしましたが、特にありません。" }))
    ).toThrow(/読み取れません/);
  });
});

describe("novel.run（feature: episodePlotContrast）", () => {
  it("runner: claude はプロンプトを返し、検算の戻し先を名指す", async () => {
    const folder = makeWork();
    const result = (await novelRun(call(folder, { runner: "claude" }))) as Record<
      string,
      unknown
    >;
    expect(result.runner).toBe("claude");
    expect(result.validateWith).toBe(validateWith("episodePlotContrast"));
    expect(String(result.userPrompt)).toContain("師匠の手紙が届く");
    expect(result.bodyChars).toBe(blankMemoLines(BODY).length);
  });
});

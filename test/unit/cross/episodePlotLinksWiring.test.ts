import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildManuscriptEditorHtml } from "../../../src/views/manuscriptEditorHtml";
import { buildPlotModePanelHtml } from "../../../src/views/plotModePanelHtml";

/**
 * プロットモード・単話プロット・原稿エディタ・伏線のつなぎ目（設計書6.4.8・6.36・
 * 6.25・6.35。作者の依頼、2026-09-23「プロットモードと単話プロットをうまく
 * つないでくださいね。あとエディターから単話プロット参照したいです」
 * 「伏線とも連携させてください」）。
 *
 * **どれか1つが抜けると、押しても何も起きない項目になる。** 画面の組み立ては
 * 単体で見られても、受け口の抜けは画面を押すまで気づけない（原稿エディタの
 * 「執筆を再開」と同じ見張り方）。
 */

const ROOT = join(__dirname, "..", "..", "..");
const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");

describe("E：原稿エディタから単話プロットを右の列に開く", () => {
  const html = buildManuscriptEditorHtml("NONCE", "vscode-resource:");

  test("上のバーと右クリックの両方にある", () => {
    expect(html).toContain('id="episodePlot"');
    expect(html).toContain("単話プロットを横に開く");
    // どちらもカーソルの行を添える（合本ではどの話かが位置でしか分からない）
    expect(html).toContain('type: "openEpisodePlot", line: caretLine()');
    expect(html).toContain('type: "openEpisodePlot", line: menuCaretLine()');
  });

  test("原稿エディタが知らせを受け、繋ぎへ渡す", () => {
    const source = read("src/features/manuscriptEditor.ts");
    expect(source).toContain('| { type: "openEpisodePlot"; line?: number }');
    const at = source.indexOf('case "openEpisodePlot":');
    expect(at).toBeGreaterThan(-1);
    expect(source.slice(at, at + 300)).toContain("this.deps.openEpisodePlot?.(");
  });

  test("別の話へ移ったことを外へ知らせる（前面に来たとき・立ち上がったとき）", () => {
    const source = read("src/features/manuscriptEditor.ts");
    expect(source.split("this.deps.onManuscriptShown?.(").length - 1).toBe(2);
  });

  test("extension.ts が、原稿の作品を引いて右の列に開く", () => {
    const source = read("src/extension.ts");
    const at = source.indexOf("openEpisodePlot: async (filePath, rawText, line)");
    expect(at).toBeGreaterThan(-1);
    const body = source.slice(at, at + 900);
    expect(body).toContain("workOfPath(registry, filePath)");
    expect(body).toContain("openEpisodePlotBesideManuscript(");
    expect(body).toContain("manuscriptEpisodePlotChapter(");
  });

  test("右の列はシーンメモと同じ扱い（Beside）", () => {
    const source = read("src/features/episodePlotNav.ts");
    const at = source.indexOf("export async function openEpisodePlotBesideManuscript(");
    expect(source.slice(at, at + 900)).toContain("vscode.ViewColumn.Beside");
  });

  test("追従は、単話プロットが見えているときだけ原稿を読む", () => {
    const source = read("src/extension.ts");
    const at = source.indexOf("const followEpisodePlotOf = async (");
    const body = source.slice(at, at + 900);
    const guard = body.indexOf("visibleEpisodePlotOf(work)");
    const read_ = body.indexOf("readText()");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(read_);
  });
});

describe("C：単話プロットからの行き来", () => {
  const manifest = JSON.parse(read("package.json")) as {
    contributes: {
      commands: Array<{ command: string; title: string }>;
      menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
    };
  };
  const commands = [
    "novelai.episodePlotToPlotMode",
    "novelai.previousEpisodePlot",
    "novelai.nextEpisodePlot",
  ];

  test("エディタのタイトルバーに、単話プロットのときだけ出す", () => {
    const titleBar = manifest.contributes.menus["editor/title"] ?? [];
    for (const command of commands) {
      const entry = titleBar.find((item) => item.command === command);
      expect(entry, `${command} がタイトルバーに無い`).toBeDefined();
      // 置き場（episode-plots）まで見る。本文の「第3話.md」には出さない
      expect(entry?.when).toContain("episode-plots$");
      expect(entry?.when).toContain("resourceExtname == .md");
      expect(entry?.group).toMatch(/^navigation/);
    }
  });

  test("コマンドパレットでも、単話プロットのときだけ出す", () => {
    const palette = manifest.contributes.menus.commandPalette ?? [];
    for (const command of commands) {
      const entry = palette.find((item) => item.command === command);
      expect(entry?.when).toContain("episode-plots$");
    }
  });

  test("前後の移動は、書いた話と予定の話を合わせた並びで決める", () => {
    const source = read("src/features/episodePlotNav.ts");
    const at = source.indexOf("export async function openNeighborEpisodePlot(");
    const body = source.slice(at, at + 1800);
    expect(body).toContain("episodePlotOrder(");
    expect(body).toContain("neighborEpisodeChapter(");
    // 無ければ作るか訊く（作るのは createEpisodePlot の1本）
    expect(body).toContain("openOrCreateEpisodePlot(");
    // 移った先の話の伏線を知らせる（F-3）
    expect(body).toContain("noticeForeshadowsFor(");
  });

  test("無い単話プロットは、訊いてから既存の口で作る", () => {
    const source = read("src/features/episodePlotNav.ts");
    const at = source.indexOf("export async function openOrCreateEpisodePlot(");
    const body = source.slice(at, at + 1500);
    expect(body).toContain("modal: true");
    expect(body).toContain("createEpisodePlot(");
    expect(body).not.toMatch(/atomicWriteFile|fs\.writeFile|writeTextFile/);
  });
});

describe("F：プロットモードの一覧と伏線", () => {
  const html = buildPlotModePanelHtml("NONCE", "vscode-resource:");

  test("伏線の数と「回収予定を過ぎた伏線」から、伏線の一覧を開ける", () => {
    expect(html).toContain('id="overdue"');
    expect(html).toContain('post("openForeshadows")');
    expect(html).toContain("張った伏線 ");
    expect(html).toContain("回収した伏線 ");
    expect(html).toContain("回収予定 ");
  });

  test("予定の話だけに並べ替えの3つを置く", () => {
    expect(html).toContain('post("movePlanned"');
    expect(html).toContain('post("insertPlanned"');
  });

  test("一覧に目標を1行出す", () => {
    expect(html).toContain("row.goalHead");
  });

  test("伏線の知らせは、単話プロットのファイルへ書かない", () => {
    const source = read("src/features/episodePlotNav.ts");
    const at = source.indexOf("export async function noticeForeshadowsFor(");
    const body = source.slice(at, at + 1400);
    expect(body).toContain("showInformationMessage(");
    expect(body).not.toMatch(/writeFile|writeText|applyEdit/);
  });
});

describe("F-1：回収予定の話は作者だけが書く", () => {
  test("状態を変える流れから決められる（メニューは増やさない）", () => {
    const source = read("src/features/foreshadows.ts");
    expect(source).toContain('const PLANNED_RESOLVE_LABEL = "回収予定の話を決める"');
    const at = source.indexOf("async function askPlannedResolve(");
    expect(source.slice(at, at + 2000)).toContain("setForeshadowPlannedResolve(");
  });

  test("AIの検知・回収確認は回収予定を書かない", () => {
    for (const file of [
      "src/features/checkForeshadows.ts",
      "src/prompts/foreshadowDetect.ts",
      "src/prompts/foreshadowResolve.ts",
      "src/core/foreshadowValidation.ts",
    ]) {
      const source = read(file);
      expect(source, file).not.toContain("setForeshadowPlannedResolve");
      expect(source, file).not.toContain("plannedResolveChapter");
    }
  });
});

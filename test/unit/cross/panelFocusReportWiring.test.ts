/**
 * WebView のパネルが、押さずに受けた焦点を知らせ、拡張機能がそれを受けているか（2026-11-14）。
 *
 * 0.152.1 で原稿エディターだけに入れた「確認の窓へ焦点を戻す」直しを、ほかのパネルへ広げた
 * （`views/focusReportScript.ts`・`views/pickerFocus.ts`）。パネルを足したときの入れ忘れを
 * ここで止める：
 * - `src/views/*Html.ts` は、共通の部品（`reportFocusWithoutPointerScript`）を埋める
 * - パネルの受け口（`onDidReceiveMessage`）を持つ `src/features/*.ts` は、受け口と同じ数だけ
 *   `listenForFocusWithoutPointer` を張る
 *
 * 例外：
 * - 原稿エディター（`manuscriptEditorHtml.ts`・`manuscriptEditor.ts`）は 0.152.1 の自前の写しを持つ
 *   （画面の側は同じ決まりの写し、受け口は便の型の中で `reclaimPickerFocus` を呼ぶ）
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAuthorDecisionsHtml } from "../../../src/views/authorDecisionsPanelHtml";
import { buildChroniclePanelHtml } from "../../../src/views/chroniclePanelHtml";
import { buildEditHistoryHtml } from "../../../src/views/editHistoryPanelHtml";
import { buildEpubEditorPanelHtml } from "../../../src/views/epubEditorPanelHtml";
import { buildLocationSketchPanelHtml } from "../../../src/views/locationSketchPanelHtml";
import { buildNameCheckPanelHtml } from "../../../src/views/nameCheckPanelHtml";
import { buildPhotoTranscribeHtml } from "../../../src/views/photoTranscribePanelHtml";
import { buildPlotModePanelHtml } from "../../../src/views/plotModePanelHtml";
import { buildProposalPanelHtml } from "../../../src/views/proposalPanelHtml";
import { buildRelationGraphPanelHtml } from "../../../src/views/relationGraphPanelHtml";
import { buildSchedulePanelHtml } from "../../../src/views/schedulePanelHtml";
import { buildSettingsPanelHtml } from "../../../src/views/settingsPanelHtml";
import { buildSceneMemoPanelHtml } from "../../../src/views/sceneMemoPanelHtml";
import { buildWorkChatPanelHtml } from "../../../src/views/workChatPanelHtml";
import { buildWritingStatsPanelHtml } from "../../../src/views/writingStatsPanelHtml";

const root = path.resolve(__dirname, "../../..");
const viewsDir = path.join(root, "src", "views");
const featuresDir = path.join(root, "src", "features");

const HTML_EXCEPTIONS = new Set(["manuscriptEditorHtml.ts"]);
const FEATURE_EXCEPTIONS = new Set(["manuscriptEditor.ts"]);

function count(text: string, word: string): number {
  return text.split(word).length - 1;
}

describe("パネルの焦点の知らせの配線", () => {
  const htmlFiles = readdirSync(viewsDir).filter((name) => name.endsWith("Html.ts") && !HTML_EXCEPTIONS.has(name));

  it("パネルの画面（*Html.ts）が見つかる", () => {
    expect(htmlFiles.length).toBeGreaterThanOrEqual(10);
  });

  for (const name of htmlFiles) {
    it(`${name} は、押さずに受けた焦点を知らせる部品を埋める`, () => {
      const text = readFileSync(path.join(viewsDir, name), "utf8");
      expect(text).toContain("reportFocusWithoutPointerScript(");
    });
  }

  const featureFiles = readdirSync(featuresDir).filter((name) => {
    if (!name.endsWith(".ts") || FEATURE_EXCEPTIONS.has(name)) return false;
    return readFileSync(path.join(featuresDir, name), "utf8").includes(".onDidReceiveMessage(");
  });

  it("パネルの受け口を持つファイルが見つかる", () => {
    expect(featureFiles.length).toBeGreaterThanOrEqual(10);
  });

  for (const name of featureFiles) {
    it(`${name} は、受け口ごとに焦点の知らせを聞く`, () => {
      const text = readFileSync(path.join(featuresDir, name), "utf8");
      expect(count(text, "listenForFocusWithoutPointer(")).toBeGreaterThanOrEqual(count(text, ".onDidReceiveMessage("));
    });
  }
});

/**
 * 組み上がった画面の台本が、構文として通るか。
 *
 * 部品は `acquireVsCodeApi()` の次の行へ差し込んだ。差し込みで1枚でも構文が崩れると、
 * そのパネルは何も動かなくなる（上の配線の検査は名前があることしか見ていない）。
 * ここでは組み上げた HTML から `<script nonce>` の中身を取り出し、`new Function` に通す
 * （動かさずに、読めるかだけを見る）。
 */
describe("パネルの台本が構文として通る（部品を埋めたあと）", () => {
  const NONCE = "NONCE123";
  const built: Array<[string, () => string]> = [
    ["作者の判断", () => buildAuthorDecisionsHtml(NONCE, "c", "作者の採否", [])],
    ["年表", () => buildChroniclePanelHtml(NONCE, "vscode-resource:")],
    ["書き換えの履歴", () => buildEditHistoryHtml(NONCE, "vscode-resource:")],
    ["EPUBの設計図", () => buildEpubEditorPanelHtml(NONCE, "vscode-resource:")],
    ["場所の見取り図", () => buildLocationSketchPanelHtml(NONCE, "vscode-resource:")],
    ["名前の点検", () => buildNameCheckPanelHtml(NONCE, "vscode-resource:")],
    ["写真の書き起こし", () => buildPhotoTranscribeHtml(NONCE, "vscode-resource:")],
    ["プロットモード", () => buildPlotModePanelHtml(NONCE, "vscode-resource:")],
    ["提案パネル", () => buildProposalPanelHtml(NONCE, "vscode-resource:")],
    ["人物相関図", () => buildRelationGraphPanelHtml(NONCE, "vscode-resource:")],
    ["スケジュール", () => buildSchedulePanelHtml(NONCE, "vscode-resource:")],
    ["設定資料", () => buildSettingsPanelHtml(NONCE, "vscode-resource:")],
    ["校正・メモパネル", () => buildSceneMemoPanelHtml(NONCE, "vscode-resource:")],
    ["相談", () => buildWorkChatPanelHtml(NONCE, "vscode-resource:")],
    ["執筆量", () => buildWritingStatsPanelHtml(NONCE, "vscode-resource:")],
  ];

  it("上の配線の検査と同じ枚数を見る", () => {
    const htmlCount = readdirSync(viewsDir).filter((name) => name.endsWith("Html.ts") && !HTML_EXCEPTIONS.has(name)).length;
    expect(built).toHaveLength(htmlCount);
  });

  for (const [label, build] of built) {
    it(`${label}：部品を含み、台本が構文として読める`, () => {
      const html = build();
      const scripts = [...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)].map((match) => match[1]);
      const joined = scripts.join("\n");
      expect(joined).toContain("function reportFocusWithoutPointer(");
      expect(joined).toContain('postMessage({ type: "focusWithoutPointer" })');
      for (const script of scripts) {
        expect(() => new Function(script)).not.toThrow();
      }
    });
  }
});

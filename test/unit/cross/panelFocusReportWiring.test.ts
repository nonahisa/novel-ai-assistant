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
 * - 校正・メモパネル（`sceneMemoPanelHtml.ts`・`sceneMemoPanel.ts`）は、ほかの担当が触っている
 *   間は当てない。当てたら例外から外す
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../..");
const viewsDir = path.join(root, "src", "views");
const featuresDir = path.join(root, "src", "features");

const HTML_EXCEPTIONS = new Set(["manuscriptEditorHtml.ts", "sceneMemoPanelHtml.ts"]);
const FEATURE_EXCEPTIONS = new Set(["manuscriptEditor.ts", "sceneMemoPanel.ts"]);

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

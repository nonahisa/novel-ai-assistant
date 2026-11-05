import { afterEach, describe, expect, test } from "vitest";
import {
  buildFeatureGuideForQuestion,
  buildFeatureIndex,
} from "../../../src/core/featureGuide";
import { setActiveModeForGuide } from "../../../src/core/editorMode";
import {
  evidenceGrams,
  featureNameTermsIn,
  normalizeGuideQuestion,
} from "../../../src/core/guideSelect";
import { PROCEDURES, proceduresForMode, selectProcedure } from "../../../src/core/procedures";
import { EDITOR_STEP_DEFS } from "../../../src/core/stepDefs";
import { MENU_PATH_START } from "../../../src/core/menuPath";

/**
 * 編集者と組む仕事の質問に、相談が答えられる材料を渡す（設計書6.118。作者の依頼 2026-11-05
 * 「編集部関係の質問に統合小説執筆環境のAIは答えられますか？」）。
 *
 * **作者は「編集部」と言うが、画面は「編集者」**（画面テスト `editorialWords` が「編集部」を
 * 禁じている）。言い換えは質問の側で1か所だけ行い、束選びと手順書き選びの両方が同じ規則で
 * 当たることを見る。
 */

afterEach(() => setActiveModeForGuide("author"));

describe("「編集部」を「編集者」と読む（質問の側で1か所）", () => {
  test("言い換えの規則は1つで、束選びと手順書き選びが同じ組みを使う", () => {
    expect(normalizeGuideQuestion("編集部の提案")).toBe("編集者の提案");
    // 手順書き（`procedures.ts`）も束選びも `evidenceGrams` を通る
    const grams = evidenceGrams(["編集部の提案はどこで見るの？"]);
    expect(grams.has("集者")).toBe(true);
    expect(grams.has("集部")).toBe(false);
  });

  test("機能の名前の拾い方も同じ言い換えを通る", () => {
    // 言い換え後の字で照合する（照合する語が「編集者」を含むときに効く）
    expect(featureNameTermsIn(["ルビを振りたい"])).toEqual(["ルビ"]);
  });
});

describe("作者モードの質問", () => {
  test("「編集部の提案はどこで見るの？」に、作者の側の手順書きと編集者連携の束が付く", () => {
    setActiveModeForGuide("author");
    const built = buildFeatureGuideForQuestion({ question: "編集部の提案はどこで見るの？" });
    expect(built.procedureKey).toBe("editorialAuthor");
    expect(built.selected).toContain("作品管理 → 編集者連携");
    // 手順の各段に場所が付き、見出しに最初の一押しが書いてある
    expect(built.text).toContain(MENU_PATH_START);
    expect(built.text).toContain("編集者の提案を見る〔簡単ステップメニュー → 6. 編集者校正・校閲〕");
  });

  test("「編集部に原稿を渡したい」でも同じ手順書き", () => {
    setActiveModeForGuide("author");
    expect(selectProcedure({ question: "編集部に原稿を渡したい", mode: "author" })?.key).toBe(
      "editorialAuthor"
    );
  });

  test("作者モードでは、編集者の側の手順書きを選ばない", () => {
    expect(selectProcedure({ question: "編集部に参加するには？", mode: "author" })?.key).not.toBe(
      "editorialEditor"
    );
  });

  test("作者モードの目次には、編集者メニューを載せない（画面に無い）", () => {
    expect(buildFeatureIndex("author")).not.toContain("【編集者メニュー");
  });
});

describe("編集者モードの質問", () => {
  test("「編集部に参加するには？」に、編集者の側の手順書きと束が付く", () => {
    setActiveModeForGuide("editor");
    const built = buildFeatureGuideForQuestion({ question: "編集部に参加するには？" });
    expect(built.procedureKey).toBe("editorialEditor");
    expect(built.selected).toContain("作品管理 → 編集者連携");
    // 段の名前は編集者メニューの行の名前で出る（詳細メニューの「保存・同期」ではない）
    expect(built.text).toContain("\n・1. 作者の最新の原稿を受け取る〔編集者メニュー〕：");
    expect(built.text).toContain("\n・置いた提案の一覧〔編集者メニュー → 5. 置いた提案を見直す〕：");
    // 名前の番号に手順書きの番号を重ねない（「2. 1. …」にしない）
    expect(built.text).not.toMatch(/\d+\. \d+\. /);
  });

  test("編集者モードでは、作者の側の手順書きを選ばない", () => {
    expect(selectProcedure({ question: "編集部の提案はどこで見るの？", mode: "editor" })?.key).not.toBe(
      "editorialAuthor"
    );
  });

  test("目次に編集者メニューの7つの手順が入る", () => {
    const index = buildFeatureIndex("editor");
    expect(index).toContain("【編集者メニュー");
    for (const def of EDITOR_STEP_DEFS) expect(index).toContain(def.label);
    expect(index).toContain("置いた提案の一覧");
  });
});

describe("手順書きはモードで分ける（作者の裁定 2026-11-06）", () => {
  test("編集者モードで選べる手順書きは、編集者と組む仕事の1本だけ", () => {
    expect(proceduresForMode("editor").map((procedure) => procedure.key)).toEqual(["editorialEditor"]);
  });

  test("作者モードでは、編集者の側の1本だけを除いて全部選べる", () => {
    const keys = proceduresForMode("author").map((procedure) => procedure.key);
    expect(keys).not.toContain("editorialEditor");
    expect(keys).toEqual(PROCEDURES.filter((procedure) => procedure.key !== "editorialEditor").map((procedure) => procedure.key));
  });

  test("編集者モードで「推敲して仕上げたい」と訊いても、作者向けの順路を渡さない", () => {
    expect(selectProcedure({ question: "推敲して仕上げたい。どの順でやればいい？", mode: "editor" })?.key).not.toBe("polish");
    expect(selectProcedure({ question: "推敲して仕上げたい。どの順でやればいい？", mode: "author" })?.key).toBe("polish");
  });

  test("束を組むときにモードを渡せる（画面のモードと違う作品を MCP から撃つとき）", () => {
    setActiveModeForGuide("author");
    const built = buildFeatureGuideForQuestion({ question: "編集部に参加するには？", mode: "editor" });
    expect(built.procedureKey).toBe("editorialEditor");
    expect(built.text).toContain("【編集者メニュー");
  });
});

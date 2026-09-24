import { describe, expect, test } from "vitest";
import {
  buildFeatureGuideForQuestion,
  buildFeatureIndex,
  buildGuideBundles,
} from "../../../src/features/featureGuide";
import { TARGET_READER_ENTRY_TITLE } from "../../../src/prompts/readerTarget";

/**
 * 相談が読者を決める操作を、旧名「ターゲット読者診断」で案内しない
 * （2026-09-25 深夜の実接続の測定。引継ぎ書8章「2巡目」の不具合3）。
 *
 * ## 何が起きたか
 *
 * 0.82.0 で「ターゲット読者診断」「ターゲットシート」「3つの輪」を
 * 「ターゲット読者」1つの入口にまとめ（設計書6.108.6）、旧「ターゲット読者診断」は
 * 詳細メニューから外した（コマンドパレットには残る）。ところが相談で読者層を
 * 尋ねると、e4b は「ターゲット読者診断」を2回とも案内し、26b は選択肢に旧名を
 * 出した。**作者は詳細メニューでその名前を探せない。**
 *
 * 出どころは2つあった。
 * - 手順書き「ターゲット読者を決める」の「どんなときに読むか」が旧名で
 *   始まっていた（`core/procedures.ts`）。AIはこれを写した
 * - 目次に、隠した旧入口が名前だけで載っていた（`views/actionList.ts`）
 */
const READER_QUESTION = "読者層を決めたいんですが、どうすればいいですか？";
const OLD_NAME = "ターゲット読者診断";

describe("読者の相談で渡す材料", () => {
  test("手順書きは、いまの入口の名前で書いてある", () => {
    const guide = buildFeatureGuideForQuestion({ question: READER_QUESTION });

    // 手順書きが当たっていること（当たらなければ、以下は何も確かめていない）
    expect(guide.procedureKey).toBe("readerTarget");
    const procedure = guide.text
      .split("\n\n")
      .find((block) => block.startsWith("【この仕事の手順"));
    expect(procedure).toBeDefined();
    expect(procedure).toContain(`1. ${TARGET_READER_ENTRY_TITLE}：`);
    expect(procedure).not.toContain(OLD_NAME);
    // 小分類の名前「読者診断」と入口の名前を並べない。e4b は並んだ2つを
    // つないで旧名を作った（2026-09-25 深夜、補足だけで直そうとした回）
    expect(procedure).not.toContain("読者診断");
  });

  test("目次にも説明の束にも、旧入口の名前を載せない", () => {
    // 「旧入口。いまは〜」の補足を添えるだけでは、e4b は名前のほうを写した
    // （同じ測定）。旧入口は `supersededBy` で相談の材料から外す
    expect(buildFeatureIndex()).not.toContain(OLD_NAME);
    for (const bundle of buildGuideBundles()) {
      expect(bundle.text, bundle.label).not.toContain(OLD_NAME);
    }
  });

  test("旧名で頼まれても、読者の手順書きがいまの入口へ導く", () => {
    // 目次から旧名を外したので、旧名で頼まれたときの道はここだけになる
    const guide = buildFeatureGuideForQuestion({
      question: "ターゲット読者診断を実行して",
    });

    expect(guide.procedureKey).toBe("readerTarget");
    expect(guide.topic).not.toBe("craft");
    expect(guide.text).toContain(`1. ${TARGET_READER_ENTRY_TITLE}：`);
  });
});
